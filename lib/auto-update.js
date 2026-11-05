// @ts-check
/**
 * dsh-multi-provider-usage — self-update for the linked checkout.
 *
 * Scope: the plugin checks the GitHub release feed for a newer version. When
 * the running copy is a local `link:`/symlink checkout, it may fast-forward
 * that checkout only if all of the following hold:
 *
 *   - the checkout is a git repository on `main`;
 *   - `git status --porcelain` is empty (no local changes);
 *   - `origin/main` is a fast-forward of the current HEAD.
 *
 * The update is installed on disk immediately, but the running Host still has
 * the old module graph; `restartRequired` tells the UI that a DSH restart is
 * needed. The updater never restarts the Host and never touches an npm/market
 * installed copy — market installations update through the plugin market.
 *
 * All external effects are injectable (`fetchImpl`, `execImpl`, `readVersion`)
 * so the tests can exercise the decision and git command sequence offline.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export const AUTO_UPDATE_REPO = "wjw1-Evan/dsh-provider-usage";
export const AUTO_UPDATE_RELEASE_URL = `https://api.github.com/repos/${AUTO_UPDATE_REPO}/releases/latest`;
/** Delay before the first background check, so activation is never blocked. */
const FIRST_CHECK_DELAY_MS = 15_000;
/** Hourly tick; the configured check interval gates actual network calls. */
const TICK_MS = 3600_000;
const DEFAULT_CHECK_HOURS = 6;

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
 * means an installed copy owned by npm/the plugin market.
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

/** Fetch the latest GitHub release tag and page URL. */
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
		publishedAt: typeof release?.published_at === "string" ? release.published_at : null
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
				if (install.kind !== "checkout" || typeof install.checkout !== "string") {
					return patch({
						status: "available",
						message: "installed copy is managed by the DSH plugin market; update it from Plugins → market",
						restartRequired: false
					});
				}
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
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn?.(`dsh-multi-provider-usage: auto-update check failed: ${message}`);
				return patch({ status: "error", message, restartRequired: false });
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	const start = () => {
		if (getConfig()?.autoUpdate === false) {
			patch({ status: "disabled", message: "automatic updates are disabled" });
			return;
		}
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
