// Auto-update decisions: version comparison, safe fast-forward, and the link vs
// market-installed branches. No network or real git process is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyCheckoutUpdate,
	detectInstall,
	isNewerVersion,
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

test("the updater fast-forwards a link checkout and reports restartRequired", async () => {
	const checkout = tempDir();
	const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} };
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

test("a market-installed copy only reports an available update", async () => {
	const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} };
	const updater = startAutoUpdate({
		packageDir: "/tmp/package",
		profileDir: "/tmp/profile",
		packageName: "dsh-multi-provider-usage",
		currentVersion: "0.2.5",
		getConfig: () => ({ autoUpdate: true, autoUpdateCheckHours: 6 }),
		fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v0.3.0" }) }),
		execImpl: async () => { throw new Error("must not run git"); },
		timers,
		detect: () => ({ kind: "package", checkout: null }),
		now: () => 2_000_000
	});
	try {
		const state = await updater.checkNow(true);
		assert.equal(state.status, "available");
		assert.equal(state.latestVersion, "0.3.0");
		assert.equal(state.restartRequired, false);
		assert.match(state.message, /market/);
	} finally {
		updater.dispose();
	}
});

test("autoUpdate=false disables the checker without touching the network", async () => {
	const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} };
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
