// Auto-update decisions: version comparison, safe fast-forward for linked
// checkouts, and in-place self-update for installed packages. No network or
// real git process is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	applyCheckoutUpdate,
	applyPackageUpdate,
	detectInstall,
	isNewerVersion,
	parseTarball,
	startAutoUpdate
} from "../lib/auto-update.js";

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-auto-update-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }));
	return dir;
}

function fakeGit(overrides = {}) {
	const calls = [];
	const execImpl = async (_file, args) => {
		const command = args.slice(2).join(" ");
		calls.push(command);
		if (overrides[command] !== undefined) {
			const value = overrides[command];
			if (value instanceof Error) throw value;
			return { stdout: value, stderr: "" };
		}
		if (command === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n", stderr: "" };
		if (command === "status --porcelain") return { stdout: "", stderr: "" };
		if (command === "fetch --quiet origin main") return { stdout: "", stderr: "" };
		if (command === "merge-base --is-ancestor HEAD origin/main") return { stdout: "", stderr: "" };
		if (command === "merge --ff-only origin/main") return { stdout: "Updating\n", stderr: "" };
		throw new Error(`unexpected git command: ${command}`);
	};
	return { calls, execImpl };
}

/** Build one 512-byte tar header + body (+ padding). */
function tarEntry(path, contents, type = "0") {
	const body = Buffer.from(contents);
	const header = Buffer.alloc(512);
	header.write(path.slice(0, 100), 0, "utf8");
	header.write("0000644\0", 100, "utf8");
	header.write("0000000\0", 108, "utf8");
	header.write("0000000\0", 116, "utf8");
	header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
	header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "utf8");
	header.write("        ", 148, "utf8"); // checksum placeholder: spaces
	header.write(type, 156, "utf8");
	header.write("ustar\0", 257, "utf8");
	header.write("00", 263, "utf8");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
	const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
	return Buffer.concat([header, body, padding]);
}

/** Wrap `{ path: contents }` in a gzipped tar buffer. */
function tarGz(entries) {
	const parts = Object.entries(entries).map(([path, contents]) => tarEntry(path, contents));
	return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

/** Build a valid pax extended-header record. */
function paxRecord(key, value) {
	const body = ` ${key}=${value}\n`;
	let length = body.length;
	while (String(length).length + body.length !== length) length = String(length).length + body.length;
	return `${length}${body}`;
}

const timers = {
	setTimeout: () => ({ unref() {} }),
	clearTimeout() {},
	setInterval: () => ({ unref() {} }),
	clearInterval() {}
};

/** A package directory shaped like an installed copy. */
function packageDir(version = "0.2.5") {
	const dir = mkdtempSync(join(tmpdir(), "dsh-package-"));
	mkdirSync(join(dir, "lib"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dsh-multi-provider-usage", version }));
	writeFileSync(join(dir, "lib", "index.js"), "old index");
	writeFileSync(join(dir, "lib", "client.js"), "old client");
	writeFileSync(join(dir, "extras.txt"), "keep me");
	return dir;
}

/** A release tarball with the package surface and one file to ignore. */
function releaseTarball(version = "0.3.0") {
	const root = `dsh-provider-usage-${version}`;
	return tarGz({
		[`${root}/package.json`]: JSON.stringify({ name: "dsh-multi-provider-usage", version }),
		[`${root}/lib/index.js`]: "new index",
		[`${root}/lib/client.js`]: "new client",
		[`${root}/cordis.patch.yml`]: "patch: rows",
		[`${root}/docs/widget.png`]: "png",
		[`${root}/test/ignored.test.mjs`]: "not shipped"
	});
}

/** A fake npm registry "latest" manifest response. */
function npmManifest(version, tarballUrl) {
	return { ok: true, json: async () => ({ version, dist: { tarball: tarballUrl } }) };
}

const LATEST = {
	npm: "https://registry.npmjs.org/dsh-multi-provider-usage/latest",
	mirror: "https://registry.npmmirror.com/dsh-multi-provider-usage/latest",
	github: "https://api.github.com/repos/wjw1-Evan/dsh-provider-usage/releases/latest"
};

test("version comparison accepts v-prefixed releases", () => {
	assert.equal(isNewerVersion("v0.3.0", "0.2.5"), true);
	assert.equal(isNewerVersion("0.2.5", "0.2.5"), false);
	assert.equal(isNewerVersion("0.2.4", "0.2.5"), false);
	assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
});

test("applyCheckoutUpdate fast-forwards a clean main checkout", async () => {
	const checkout = tempDir();
	const git = fakeGit();
	try {
		const result = await applyCheckoutUpdate({ checkout, execImpl: git.execImpl });
		assert.deepEqual(result, { updated: true, reason: null, version: "0.3.0" });
		assert.deepEqual(git.calls, [
			"rev-parse --abbrev-ref HEAD",
			"status --porcelain",
			"fetch --quiet origin main",
			"merge-base --is-ancestor HEAD origin/main",
			"merge --ff-only origin/main"
		]);
	} finally {
		rmSync(checkout, { recursive: true, force: true });
	}
});

test("applyCheckoutUpdate refuses local changes, other branches and divergence", async () => {
	const checkout = tempDir();
	try {
		const dirty = await applyCheckoutUpdate({
			checkout,
			execImpl: fakeGit({ "status --porcelain": " M lib/index.js\n" }).execImpl
		});
		assert.equal(dirty.updated, false);
		assert.match(dirty.reason, /local changes/);

		const branch = await applyCheckoutUpdate({
			checkout,
			execImpl: fakeGit({ "rev-parse --abbrev-ref HEAD": "feature\n" }).execImpl
		});
		assert.equal(branch.updated, false);
		assert.match(branch.reason, /not main/);

		const diverged = await applyCheckoutUpdate({
			checkout,
			execImpl: fakeGit({ "merge-base --is-ancestor HEAD origin/main": new Error("not ancestor") }).execImpl
		});
		assert.equal(diverged.updated, false);
		assert.match(diverged.reason, /diverged/);
	} finally {
		rmSync(checkout, { recursive: true, force: true });
	}
});

test("detectInstall distinguishes a link checkout from a market package", () => {
	const dir = tempDir();
	try {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "dsh-multi-provider-usage": "link:/tmp/checkout" } }));
		assert.deepEqual(detectInstall({ packageDir: "/tmp/profile/node_modules/dsh-multi-provider-usage", profileDir: dir, packageName: "dsh-multi-provider-usage" }), {
			kind: "checkout",
			checkout: "/tmp/checkout"
		});
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "dsh-multi-provider-usage": "^0.2.5" } }));
		assert.deepEqual(detectInstall({ packageDir: "/tmp/profile/node_modules/dsh-multi-provider-usage", profileDir: dir, packageName: "dsh-multi-provider-usage" }), {
			kind: "package",
			checkout: null
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseTarball reads regular files and applies pax paths", () => {
	const pax = paxRecord("path", "repo-1.0.0/lib/renamed.js");
	const buffer = Buffer.concat([
		tarEntry("pax-header", pax, "x"),
		tarEntry("repo-1.0.0/lib/original.js", "content"),
		tarEntry("repo-1.0.0/docs", "", "5"),
		tarEntry("long-name", "repo-1.0.0/lib/gnu-long.js\0", "L"),
		tarEntry("short.js", "gnu content"),
		Buffer.alloc(1024)
	]);
	const entries = parseTarball(buffer);
	assert.equal(entries.get("repo-1.0.0/lib/renamed.js").toString(), "content");
	assert.equal(entries.get("repo-1.0.0/lib/gnu-long.js").toString(), "gnu content");
	assert.equal(entries.has("repo-1.0.0/docs"), false, "directories are skipped");
});

test("applyPackageUpdate replaces the packaged files and keeps unrelated ones", async () => {
	const dir = packageDir();
	try {
		const tarball = releaseTarball("0.3.0");
		const result = await applyPackageUpdate({
			packageDir: dir,
			tarballUrl: "https://example.test/release.tar.gz",
			fetchImpl: async () => ({ ok: true, arrayBuffer: async () => tarball }),
			packageName: "dsh-multi-provider-usage",
			expectVersion: "0.3.0"
		});
		assert.equal(result.version, "0.3.0");
		assert.equal(result.files, 5);
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "new index");
		assert.equal(readFileSync(join(dir, "lib", "client.js"), "utf8"), "new client");
		assert.equal(readFileSync(join(dir, "cordis.patch.yml"), "utf8"), "patch: rows");
		assert.equal(readFileSync(join(dir, "package.json"), "utf8").includes("\"0.3.0\""), true);
		assert.equal(readFileSync(join(dir, "extras.txt"), "utf8"), "keep me");
		assert.equal(existsSync(join(dir, "test", "ignored.test.mjs")), false, "test files are never shipped");
		assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".dsh-update")), [], "the staging directory is removed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("applyPackageUpdate refuses a tarball that is not the expected version", async () => {
	const dir = packageDir();
	try {
		await assert.rejects(
			applyPackageUpdate({
				packageDir: dir,
				tarballUrl: "https://example.test/release.tar.gz",
				fetchImpl: async () => ({ ok: true, arrayBuffer: async () => releaseTarball("0.3.0") }),
				packageName: "dsh-multi-provider-usage",
				expectVersion: "0.4.0"
			}),
			/expected v0\.4\.0/
		);
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "old index", "nothing is written on a bad release");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the updater fast-forwards a link checkout and reports restartRequired", async () => {
	const checkout = tempDir();
	const git = fakeGit();
	const updater = startAutoUpdate({
		packageDir: checkout,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({ tag_name: "v0.3.0", html_url: "https://example.test/v0.3.0", published_at: "2026-11-05T00:00:00Z" })
		}),
		execImpl: git.execImpl,
		timers,
		detect: () => ({ kind: "checkout", checkout }),
		now: () => 1_000_000
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "updated");
		assert.equal(state.version, "0.3.0");
		assert.equal(state.restartRequired, true);
	} finally {
		updater.dispose();
		rmSync(checkout, { recursive: true, force: true });
	}
});

test("a market-installed copy updates itself from the release tarball", async () => {
	const dir = packageDir();
	const tarball = releaseTarball("0.3.0");
	const fetched = [];
	const updater = startAutoUpdate({
		packageDir: dir,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async (url) => {
			fetched.push(String(url));
			if (String(url) === LATEST.npm) return npmManifest("0.3.0", "https://example.test/npm.tgz");
			if (String(url) === LATEST.mirror) return npmManifest("0.3.0", "https://example.test/mirror.tgz");
			if (String(url) === LATEST.github) {
				return { ok: true, json: async () => ({ tag_name: "v0.3.0", tarball_url: "https://example.test/tarball.tar.gz" }) };
			}
			return { ok: true, arrayBuffer: async () => tarball };
		},
		execImpl: async () => { throw new Error("must not run git"); },
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 2_000_000
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "updated");
		assert.equal(state.version, "0.3.0");
		assert.equal(state.restartRequired, true);
		assert.deepEqual(fetched, [
			LATEST.npm,
			LATEST.mirror,
			LATEST.github,
			"https://example.test/npm.tgz"
		], "the registry is checked before GitHub and its tarball wins the download");
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "new index");
	} finally {
		updater.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a release this session already applied is not re-downloaded until restart", async () => {
	const dir = packageDir();
	const tarball = releaseTarball("0.3.0");
	const tarballDownloads = [];
	const updater = startAutoUpdate({
		packageDir: dir,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async (url) => {
			const u = String(url);
			if (u === LATEST.npm || u === LATEST.mirror) {
				return npmManifest("0.3.0", "https://example.test/tarball.tar.gz");
			}
			if (u === LATEST.github) {
				return { ok: true, json: async () => ({ tag_name: "v0.3.0", tarball_url: "https://example.test/tarball.tar.gz" }) };
			}
			tarballDownloads.push(u);
			return { ok: true, arrayBuffer: async () => tarball };
		},
		execImpl: async () => { throw new Error("must not run git"); },
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 2_000_000
	});
	try {
		const first = await updater.checkNow(true);
		assert.equal(first.status, "updated");
		assert.equal(tarballDownloads.length, 1, "the first check downloads the tarball once");

		const second = await updater.checkNow(true);
		assert.equal(second.status, "updated", "the restart notice stays up");
		assert.equal(second.restartRequired, true, "the restart notice stays up");
		assert.equal(tarballDownloads.length, 1, "the same release is not re-downloaded");
	} finally {
		updater.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed self-update leaves an actionable notice instead of a broken install", async () => {
	const dir = packageDir();
	const updater = startAutoUpdate({
		packageDir: dir,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async (url) => {
			if (String(url).includes("releases/latest")) {
				return { ok: true, json: async () => ({ tag_name: "v0.3.0", tarball_url: "https://example.test/tarball.tar.gz" }) };
			}
			return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
		},
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 3_000_000
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "available");
		assert.equal(state.latestVersion, "0.3.0");
		assert.match(state.message, /HTTP 500/);
		assert.match(state.message, /all sources/, "the message lists every download source");
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "old index");
	} finally {
		updater.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("autoUpdate=false disables the checker without touching the network", async () => {
	let fetched = false;
	const updater = startAutoUpdate({
		packageDir: "/tmp/package",
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: false, autoUpdateCheckHours: 6 }),
		fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({ tag_name: "v0.3.0" }) }; },
		timers
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "disabled");
		assert.equal(fetched, false);
	} finally {
		updater.dispose();
	}
});

test("a package install falls back to the registry when GitHub is unreachable", async () => {
	const dir = packageDir();
	const tarball = releaseTarball("0.3.0");
	const tarballDownloads = [];
	const updater = startAutoUpdate({
		packageDir: dir,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async (url) => {
			const u = String(url);
			if (u === LATEST.npm) return npmManifest("0.3.0", "https://example.test/npm.tgz");
			if (u === LATEST.mirror || u === LATEST.github) return { ok: false, status: 500, text: async () => "" };
			if (u === "https://example.test/npm.tgz") {
				tarballDownloads.push(u);
				return { ok: true, arrayBuffer: async () => tarball };
			}
			throw new Error(`unexpected fetch: ${u}`);
		},
		execImpl: async () => { throw new Error("must not run git"); },
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 2_000_000
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "updated");
		assert.equal(state.version, "0.3.0");
		assert.deepEqual(tarballDownloads, ["https://example.test/npm.tgz"]);
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "new index");
	} finally {
		updater.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the download falls back to the next source when the first fails", async () => {
	const dir = packageDir();
	const tarball = releaseTarball("0.3.0");
	const downloads = [];
	const updater = startAutoUpdate({
		packageDir: dir,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async (url) => {
			const u = String(url);
			if (u === LATEST.npm) return npmManifest("0.3.0", "https://example.test/npm.tgz");
			if (u === LATEST.mirror) return npmManifest("0.3.0", "https://example.test/mirror.tgz");
			if (u === LATEST.github) return { ok: false, status: 500, text: async () => "" };
			if (u === "https://example.test/npm.tgz") {
				downloads.push(u);
				return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
			}
			if (u === "https://example.test/mirror.tgz") {
				downloads.push(u);
				return { ok: true, arrayBuffer: async () => tarball };
			}
			throw new Error(`unexpected fetch: ${u}`);
		},
		execImpl: async () => { throw new Error("must not run git"); },
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 2_000_000
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "updated");
		assert.equal(state.version, "0.3.0");
		assert.deepEqual(downloads, ["https://example.test/npm.tgz", "https://example.test/mirror.tgz"]);
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "new index");
	} finally {
		updater.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every source failing the check reports an error instead of an update", async () => {
	const dir = packageDir();
	const updater = startAutoUpdate({
		packageDir: dir,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async () => ({ ok: false, status: 500, text: async () => "" }),
		execImpl: async () => { throw new Error("must not run git"); },
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 2_000_000
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "error");
		assert.match(state.message, /release check failed from all sources/);
		assert.match(state.message, /npm registry check 500/);
		assert.match(state.message, /GitHub release check 500/);
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "old index");
	} finally {
		updater.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a local write failure stops the source chain instead of retrying", { skip: process.platform === "win32" }, async () => {
	const dir = packageDir();
	const tarball = releaseTarball("0.3.0");
	const downloads = [];
	const updater = startAutoUpdate({
		packageDir: dir,
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async (url) => {
			const u = String(url);
			if (u === LATEST.npm) return npmManifest("0.3.0", "https://example.test/npm.tgz");
			if (u === LATEST.mirror || u === LATEST.github) return { ok: false, status: 500, text: async () => "" };
			downloads.push(u);
			return { ok: true, arrayBuffer: async () => tarball };
		},
		execImpl: async () => { throw new Error("must not run git"); },
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 2_000_000
	});
	try {
		chmodSync(dir, 0o555);
		const state = await updater.checkNow(true);
		assert.equal(state.status, "available");
		assert.match(state.message, /EACCES|EPERM/);
		assert.match(state.message, /not writable/, "the message carries a permission hint");
		assert.equal(downloads.length, 1, "no other download source is tried for a local failure");
		assert.equal(readFileSync(join(dir, "lib", "index.js"), "utf8"), "old index");
	} finally {
		chmodSync(dir, 0o755);
		updater.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
