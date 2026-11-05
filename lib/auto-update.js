// @ts-check
/**
 * dsh-multi-provider-usage — self-update.
 *
 * Two install shapes, two strategies:
 *
 *   - `checkout` (`link:` / `file:` directory): fast-forward the git checkout,
 *     but only when it is on `main`, clean, and can fast-forward `origin/main`.
 *   - `package` (npm / market / tarball install): download the GitHub release
 *     tarball and replace the packaged files in place. Every file is written
 *     to a temp file inside the package directory first and then renamed over
 *     the target, which keeps pnpm's hardlinked store untouched.
 *
 * Neither strategy restarts the Host: the running module graph is stale once
 * the files land, so the UI reports `restartRequired`. The updater never
 * touches a symlinked checkout and never runs when the install is a `link:`
 * that has local changes.
 *
 * All external effects are injectable (`fetchImpl`, `execImpl`, `readVersion`)
 * so the tests can exercise the decision and file work offline.
 */

import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

export const AUTO_UPDATE_REPO = "wjw1-Evan/dsh-provider-usage";
export const AUTO_UPDATE_RELEASE_URL = `https://api.github.com/repos/${AUTO_UPDATE_REPO}/releases/latest`;
/** Delay before the first background check, so activation is never blocked. */
const FIRST_CHECK_DELAY_MS = 15_000;
/** Hourly tick; the configured check interval gates actual network calls. */
const TICK_MS = 3600_000;
const DEFAULT_CHECK_HOURS = 6;
/** Upper bound on a release tarball, to keep a bad download out of memory. */
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
/** Files a release tarball may replace inside an installed package. */
const PACKAGED_PREFIXES = ["lib/", "docs/"];
const PACKAGED_FILES = ["package.json", "cordis.patch.yml"];

const execFileAsync = promisify(execFile);

/** Parse `v1.2.3` / `1.2.3` into numeric parts; returns null when unusable. */
export function parseVersion(value) {
	const text = String(value ?? "").trim().replace(/^v/i, "").split("-")[0];
	const parts = text.split(".").map((part) => Number(part));
	if (parts.length === 0 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
	while (parts.length < 3) parts.push(0);
	return parts.slice(0, 3);
}

/** True when `latest` is a strictly higher semver than `current`. */
export function isNewerVersion(latest, current) {
	const a = parseVersion(latest);
	const b = parseVersion(current);
	if (a === null || b === null) return false;
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] > b[index];
	}
	return false;
}

/** Read the profile dependency spec, or null when it cannot be read. */
function profileSpec(profileDir, packageName) {
	if (typeof profileDir !== "string" || profileDir.length === 0) return null;
	try {
		const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
		const spec = manifest?.dependencies?.[packageName];
		return typeof spec === "string" ? spec : null;
	} catch {
		return null;
	}
}

/** Expand `link:`/`file:` specs relative to the profile directory. */
function specPath(profileDir, spec) {
	const prefix = spec.startsWith("link:") ? "link:" : spec.startsWith("file:") ? "file:" : null;
	if (prefix === null) return null;
	const raw = spec.slice(prefix.length);
	if (raw.startsWith("/")) return raw;
	return join(profileDir, raw);
}

/**
 * Classify the running installation.
 * `checkout` means a local linked directory we may fast-forward; `package`
 * means an installed copy we update by replacing its packaged files.
 * @returns {{ kind: "checkout" | "package", checkout: string | null }}
 */
export function detectInstall({ packageDir, profileDir, packageName }) {
	const spec = profileSpec(profileDir, packageName);
	if (typeof spec === "string" && spec.startsWith("link:")) {
		const checkout = specPath(profileDir, spec);
		if (checkout !== null) return { kind: "checkout", checkout };
	}
	if (typeof spec === "string" && spec.startsWith("file:")) {
		// A file: directory can be a checkout, but a file: tarball cannot. Only
		// treat it as a checkout when the path looks like a directory.
		const path = specPath(profileDir, spec);
		if (path !== null && !path.endsWith(".tgz") && !path.endsWith(".tar.gz")) {
			return { kind: "checkout", checkout: path };
		}
	}
	return { kind: "package", checkout: null };
}

/** Format one exec failure without leaking huge output. */
function failure(result) {
	const stderr = String(result?.stderr ?? "").trim();
	return stderr.length > 0 ? stderr.slice(0, 240) : `git exited ${String(result?.code ?? "nonzero")}`;
}

/**
 * Fast-forward a clean `main` checkout to `origin/main`.
 *
 * @param {{
 *   checkout: string,
 *   execImpl?: (file: string, args: string[], options: object) => Promise<{ stdout?: string, stderr?: string }>,
 *   readVersion?: (checkout: string) => string,
 * }} input
 * @returns {Promise<{ updated: boolean, reason: string | null, version?: string }>}
 */
export async function applyCheckoutUpdate(input) {
	const { checkout, execImpl = execFileAsync, readVersion = readPackageVersion } = input;
	const run = async (args) => {
		try {
			const result = await execImpl("git", ["-C", checkout, ...args], { windowsHide: true });
			return { code: 0, stdout: String(result?.stdout ?? ""), stderr: String(result?.stderr ?? "") };
		} catch (error) {
			return {
				code: typeof error?.code === "number" ? error.code : 1,
				stdout: String(error?.stdout ?? ""),
				stderr: String(error?.stderr ?? error?.message ?? error)
			};
		}
	};

	const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch.code !== 0) return { updated: false, reason: `not a git checkout: ${failure(branch)}` };
	if (branch.stdout.trim() !== "main") return { updated: false, reason: `checkout is on "${branch.stdout.trim() || "unknown"}", not main` };

	const status = await run(["status", "--porcelain"]);
	if (status.code !== 0) return { updated: false, reason: `cannot read checkout status: ${failure(status)}` };
	if (status.stdout.trim() !== "") return { updated: false, reason: "checkout has local changes" };

	const fetched = await run(["fetch", "--quiet", "origin", "main"]);
	if (fetched.code !== 0) return { updated: false, reason: `git fetch failed: ${failure(fetched)}` };

	const ancestor = await run(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
	if (ancestor.code !== 0) return { updated: false, reason: "checkout has diverged from origin/main" };

	const merged = await run(["merge", "--ff-only", "origin/main"]);
	if (merged.code !== 0) return { updated: false, reason: `git merge failed: ${failure(merged)}` };

	const version = readVersion(checkout);
	return { updated: true, reason: null, version };
}

/** Read the version from a checkout's package.json. */
function readPackageVersion(checkout) {
	try {
		const pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
		return typeof pkg?.version === "string" ? pkg.version : "";
	} catch {
		return "";
	}
}

// ── release tarball handling ────────────────────────────────────────────

/** Read a NUL-padded tar header field as UTF-8. */
function headerText(header, start, length) {
	const slice = header.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

/** Decode a pax extended header body into a record map. */
function parsePaxRecords(body) {
	const records = {};
	let offset = 0;
	while (offset < body.length) {
		const space = body.indexOf(0x20, offset);
		if (space === -1) break;
		const length = Number(body.subarray(offset, space).toString("utf8"));
		if (!Number.isSafeInteger(length) || length <= 0) break;
		const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
		const equals = record.indexOf("=");
		if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
		offset += length;
	}
	return records;
}

/** Normalize a tar path; returns null for absolute or parent-escaping paths. */
function normalizeTarPath(path) {
	const parts = String(path).replace(/\\/g, "/").split("/");
	const safe = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") return null;
		safe.push(part);
	}
	return safe.length === 0 ? null : safe.join("/");
}

/**
 * Parse an uncompressed tar buffer into a `path → contents` map.
 * Only regular files are returned; directories and links are skipped.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function parseTarball(buffer) {
	/** @type {Map<string, Buffer>} */
	const entries = new Map();
	let offset = 0;
	/** @type {string | null} */
	let pendingPath = null;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		let blank = true;
		for (const byte of header) {
			if (byte !== 0) {
				blank = false;
				break;
			}
		}
		if (blank) break;
		const rawName = headerText(header, 0, 100);
		const prefix = headerText(header, 345, 155);
		const size = Number.parseInt(headerText(header, 124, 12).trim() || "0", 8);
		const flag = header[156];
		const name = prefix.length > 0 ? `${prefix}/${rawName}` : rawName;
		const bodyStart = offset + 512;
		const bodyEnd = bodyStart + (Number.isFinite(size) && size > 0 ? size : 0);
		const body = buffer.subarray(bodyStart, bodyEnd);
		offset = bodyStart + Math.ceil((Number.isFinite(size) && size > 0 ? size : 0) / 512) * 512;
		const type = flag === 0 ? "0" : String.fromCharCode(flag);
		if (type === "x") {
			pendingPath = parsePaxRecords(body).path ?? null;
			continue;
		}
		if (type === "L") {
			// GNU long-name entry: the body is the path for the next header.
			pendingPath = body.toString("utf8").replace(/\0+$/, "") || null;
			continue;
		}
		if (type === "g") continue;
		if (type !== "0") continue;
		const path = normalizeTarPath(pendingPath ?? name);
		pendingPath = null;
		if (path !== null) entries.set(path, Buffer.from(body));
	}
	return entries;
}

/** True when a relative path belongs to the published package surface. */
function isPackagedFile(relative) {
	if (PACKAGED_FILES.includes(relative)) return true;
	return PACKAGED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

/**
 * Replace an installed package's files with the release tarball contents.
 *
 * The package directory must be a real directory (a `link:` checkout is a
 * symlink and is refused). Files are staged next to the targets so the final
 * `rename` is atomic and never edits a pnpm store hardlink in place.
 *
 * @param {{
 *   packageDir: string,
 *   tarballUrl: string,
 *   fetchImpl?: typeof fetch,
 *   packageName?: string | null,
 *   expectVersion?: string | null,
 *   maxBytes?: number,
 *   logger?: { info?: Function, warn?: Function },
 * }} options
 * @returns {Promise<{ updated: true, version: string, files: number }>}
 */
export async function applyPackageUpdate(options) {
	const {
		packageDir,
		tarballUrl,
		fetchImpl = fetch,
		packageName = null,
		expectVersion = null,
		maxBytes = MAX_TARBALL_BYTES,
		logger = {}
	} = options;
	if (typeof packageDir !== "string" || packageDir.length === 0) throw new Error("no package directory to update");
	if (typeof tarballUrl !== "string" || tarballUrl.length === 0) throw new Error("release has no tarball URL");

	const stat = lstatSync(packageDir);
	if (stat.isSymbolicLink()) throw new Error(`${packageDir} is a symlink; refusing to replace a linked checkout`);

	const res = await fetchImpl(tarballUrl, {
		headers: { Accept: "application/octet-stream", "User-Agent": "dsh-multi-provider-usage" },
		signal: AbortSignal.timeout(30_000)
	});
	if (!res.ok) throw new Error(`release tarball download failed with HTTP ${res.status}`);
	const body = Buffer.from(await res.arrayBuffer());
	if (body.length === 0) throw new Error("release tarball is empty");
	if (body.length > maxBytes) throw new Error(`release tarball is larger than ${maxBytes} bytes`);

	const entries = parseTarball(gunzipSync(body));
	if (entries.size === 0) throw new Error("release tarball has no files");
	const roots = new Set([...entries.keys()].map((path) => path.split("/")[0]));
	if (roots.size !== 1) throw new Error("release tarball does not have exactly one root directory");
	const root = [...roots][0];

	const manifestBytes = entries.get(`${root}/package.json`);
	if (manifestBytes === undefined) throw new Error("release tarball has no package.json");
	/** @type {{ name?: string, version?: string }} */
	let manifest;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch {
		throw new Error("release package.json is not valid JSON");
	}
	if (typeof packageName === "string" && packageName.length > 0 && manifest?.name !== packageName) {
		throw new Error(`release is package "${String(manifest?.name)}", expected "${packageName}"`);
	}
	if (parseVersion(manifest?.version) === null) throw new Error("release package.json has no usable version");
	if (typeof expectVersion === "string" && expectVersion.length > 0 && String(parseVersion(manifest.version)) !== String(parseVersion(expectVersion))) {
		throw new Error(`release tarball is v${manifest.version}, expected v${expectVersion}`);
	}

	/** @type {Map<string, Buffer>} */
	const files = new Map();
	for (const [path, contents] of entries) {
		if (!path.startsWith(`${root}/`)) continue;
		const relative = path.slice(root.length + 1);
		if (relative.length === 0 || relative.includes("../")) continue;
		if (!isPackagedFile(relative)) continue;
		files.set(relative, contents);
	}
	if (!files.has("lib/index.js") || !files.has("lib/client.js")) {
		throw new Error("release tarball is missing lib/index.js or lib/client.js");
	}

	// Stage inside packageDir: a rename across filesystems would fail, and the
	// temp names are easy to clean up if the download turns out to be bad.
	const staging = join(packageDir, `.dsh-update-${process.pid}-${Date.now()}`);
	/** @type {{ temp: string, target: string }[]} */
	const staged = [];
	try {
		for (const [relative, contents] of files) {
			const temp = join(staging, relative);
			mkdirSync(dirname(temp), { recursive: true });
			writeFileSync(temp, contents, { mode: 0o644 });
			staged.push({ temp, target: join(packageDir, relative) });
		}
		for (const { temp, target } of staged) {
			mkdirSync(dirname(target), { recursive: true });
			renameSync(temp, target);
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	logger.info?.(`dsh-multi-provider-usage: replaced ${files.size} files in ${packageDir} with v${manifest.version}`);
	return { updated: true, version: String(manifest.version), files: files.size };
}

/** Fetch the latest GitHub release tag, page URL and tarball URL. */
async function fetchLatestRelease(fetchImpl) {
	const res = await fetchImpl(AUTO_UPDATE_RELEASE_URL, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "dsh-multi-provider-usage"
		},
		signal: AbortSignal.timeout(10_000)
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GitHub release check ${res.status}: ${body.slice(0, 200)}`);
	}
	const release = await res.json();
	const tag = typeof release?.tag_name === "string" ? release.tag_name.replace(/^v/i, "") : "";
	if (parseVersion(tag) === null) throw new Error("GitHub release has no usable tag");
	return {
		version: tag,
		url: typeof release?.html_url === "string" ? release.html_url : null,
		publishedAt: typeof release?.published_at === "string" ? release.published_at : null,
		tarballUrl: typeof release?.tarball_url === "string" && release.tarball_url.length > 0
			? release.tarball_url
			: `https://github.com/${AUTO_UPDATE_REPO}/archive/refs/tags/v${tag}.tar.gz`
	};
}

/**
 * Start the background checker.
 *
 * @param {{
 *   packageDir: string,
 *   profileDir: string,
 *   packageName: string,
 *   currentVersion: string,
 *   getConfig: () => { autoUpdate?: boolean, autoUpdateCheckHours?: number },
 *   fetchImpl?: typeof fetch,
 *   execImpl?: Function,
 *   now?: () => number,
 *   logger?: { info?: Function, warn?: Function },
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 *   detect?: typeof detectInstall,
 * }} options
 */
export function startAutoUpdate(options) {
	const {
		packageDir,
		profileDir,
		packageName,
		currentVersion,
		getConfig,
		fetchImpl = fetch,
		execImpl = execFileAsync,
		now = Date.now,
		logger = {},
		timers = { setTimeout, clearTimeout, setInterval, clearInterval },
		detect = detectInstall
	} = options;
	const state = {
		status: "idle",
		currentVersion,
		latestVersion: null,
		checkedAt: null,
		updatedAt: null,
		installKind: null,
		version: null,
		restartRequired: false,
		message: null,
		releaseUrl: null
	};
	let disposed = false;
	let firstTimer = null;
	let tickTimer = null;
	let inFlight = null;
	let lastCheckAt = 0;

	const patch = (next) => {
		Object.assign(state, next);
		return state;
	};
	const configuredHours = () => {
		const value = Number(getConfig()?.autoUpdateCheckHours);
		return Number.isFinite(value) && value >= 1 && value <= 168 ? value : DEFAULT_CHECK_HOURS;
	};

	const checkNow = async (force = false) => {
		if (disposed) return { ...state };
		if (inFlight !== null) return inFlight;
		const config = getConfig() ?? {};
		if (config.autoUpdate === false) {
			return patch({ status: "disabled", message: "automatic updates are disabled" });
		}
		if (currentVersion === "0.0.0" || parseVersion(currentVersion) === null) {
			return patch({ status: "skipped", message: "development version" });
		}
		if (!force && now() - lastCheckAt < configuredHours() * 3600_000) return { ...state };
		lastCheckAt = now();
		patch({ status: "checking", message: null });
		inFlight = (async () => {
			try {
				const release = await fetchLatestRelease(fetchImpl);
				const install = detect({ packageDir, profileDir, packageName });
				patch({
					latestVersion: release.version,
					checkedAt: now(),
					installKind: install.kind,
					releaseUrl: release.url
				});
				if (!isNewerVersion(release.version, currentVersion)) {
					return patch({ status: "up-to-date", message: null, restartRequired: false });
				}
				if (install.kind === "checkout" && typeof install.checkout === "string") {
					const result = await applyCheckoutUpdate({
						checkout: install.checkout,
						execImpl,
						readVersion: readPackageVersion
					});
					if (!result.updated) {
						return patch({ status: "skipped", message: result.reason, restartRequired: false });
					}
					if (!isNewerVersion(result.version, currentVersion)) {
						return patch({
							status: "skipped",
							message: `checkout is at ${result.version || "an unknown version"}; release is ${release.version}`,
							restartRequired: false
						});
					}
					logger.info?.(`dsh-multi-provider-usage: auto-updated checkout to ${result.version}; restart DSH to apply`);
					return patch({
						status: "updated",
						version: result.version,
						updatedAt: now(),
						restartRequired: true,
						message: "checkout updated; restart DSH to apply"
					});
				}
				// Installed package (npm / market / tarball): replace the packaged
				// files in place. The running Host keeps the old module graph until
				// it is restarted, which the UI reports.
				const result = await applyPackageUpdate({
					packageDir,
					tarballUrl: release.tarballUrl,
					fetchImpl,
					packageName,
					expectVersion: release.version,
					logger
				});
				logger.info?.(`dsh-multi-provider-usage: self-updated package to ${result.version}; restart DSH to apply`);
				return patch({
					status: "updated",
					version: result.version,
					updatedAt: now(),
					restartRequired: true,
					message: "package files replaced; restart DSH to apply"
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn?.(`dsh-multi-provider-usage: auto-update failed: ${message}`);
				return patch({ status: "available", message, restartRequired: false });
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	const start = () => {
		// Keep the schedule even while disabled: enabling the setting later must
		// start checking without a host restart.
		if (getConfig()?.autoUpdate === false) patch({ status: "disabled", message: "automatic updates are disabled" });
		firstTimer = timers.setTimeout(() => {
			void checkNow(false).catch(() => {});
		}, FIRST_CHECK_DELAY_MS);
		firstTimer?.unref?.();
		tickTimer = timers.setInterval(() => {
			void checkNow(false).catch(() => {});
		}, TICK_MS);
		tickTimer?.unref?.();
	};

	start();

	return {
		getState: () => ({ ...state }),
		checkNow,
		dispose() {
			disposed = true;
			if (firstTimer !== null) timers.clearTimeout(firstTimer);
			if (tickTimer !== null) timers.clearInterval(tickTimer);
			firstTimer = null;
			tickTimer = null;
		}
	};
}
