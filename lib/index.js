// @ts-check
/**
 * dsh-multi-provider-usage — host half.
 *
 * One DSH plugin that watches the quotas of three coding-plan providers:
 *
 *   - OpenCode GO      — official `/v1/usage` endpoint, or the live
 *                        `dsh-opencode-go` service when it is available;
 *   - Command Code     — `/alpha/billing/*` and `/alpha/usage/summary`;
 *   - GLM Code Plan    — Z.ai / BigModel `/api/monitor/usage/quota/limit`.
 *
 * The host exposes same-origin routes so the browser widget never sees an API
 * key and no CORS is involved:
 *
 *   - `GET  /provider-usage/usage`     — all enabled providers, canonical shape.
 *   - `GET  /provider-usage/settings`  — redacted settings + non-network detection.
 *   - `POST /provider-usage/settings`  — whitelisted settings updates.
 *
 * It also registers the `/provider-usage` chat command, the sidebar widget
 * (through the official `sidebar.footer.action` slot) and a bundle settings
 * page (`plugins.bundle.config`), mirroring dsh-opencode-go-usage.
 *
 * Installation / configuration (official DSH flows):
 *   - Install: `dsh plugin --profile web add dsh-multi-provider-usage` — the
 *     `dsh.bundle.patch` declaration makes the CLI reconcile this package into
 *     the profile's bundle layer stack automatically (no manual patch edits).
 *   - Configure: the loader picks the exported `Config` schema up by itself.
 *     Every field is `.volatile()`, so Settings → Plugins → Plugin
 *     configuration exposes it and edits hot-apply. The API keys themselves
 *     live in the credentials domain (credential refs), never in settings.
 *
 * Credential discovery is deliberately forgiving:
 *   - OpenCode GO: configured ref, then the dsh-opencode-go active account ref,
 *     then OPENCODE_GO_API_KEY / OPENCODE_API_KEY.
 *   - Command Code: configured ref, then COMMANDCODE_API_KEY, then
 *     `~/.commandcode/auth.json` written by the Command Code CLI.
 *   - GLM: configured ref, then ZAI_CODING_CN_API_KEY / ZAI_API_KEY /
 *     ZHIPU_API_KEY / GLM_API_KEY / BIGMODEL_API_KEY.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import {
	GLM_BIGMODEL_BASE_URL,
	GLM_ZAI_BASE_URL,
	GLM_KNOWN_REFS,
	PROVIDER_IDS,
	PROVIDERS,
	DEFAULT_COMMAND_CODE_BASE_URL,
	DEFAULT_COMMAND_CODE_API_KEY_ENV,
	DEFAULT_GLM_API_KEY_ENV,
	DEFAULT_OPENCODE_API_KEY_ENV,
	DEFAULT_OPENCODE_BASE_URL,
	ProviderError,
	providerInfo,
	readCommandCode,
	readCommandCodeAuthFile,
	readGlm,
	readOpencodeGo
} from "./providers.js";
import { isCredentialRefName } from "./util.js";
import { patchFetch, recordStream, sessionDiag, sessionHeaderCount, withSession } from "./opencode-session.js";
import { startAutoUpdate, isNewerVersion } from "./auto-update.js";
import {
	DEFAULT_OPENCODE_CONSOLE_API_KEY_ENV,
	DEFAULT_OPENCODE_CONSOLE_BASE_URL,
	opencodeConsoleStatus
} from "./opencode-console.js";

export const name = "dsh-multi-provider-usage";

/** Required services: web routes, chat commands, credentials. */
export const inject = ["webServer", "commands", "credentials"];

/** Settings namespace owned by this plugin. */
export const namespace = "dsh-multi-provider-usage";

const DEFAULT_CACHE_MS = 30_000;
/** npm package name this plugin is published under (update checks). */
const NPM_PACKAGE = "dsh-multi-provider-usage";
/** How often the update check may hit the npm registry (ms). */
const UPDATE_CHECK_INTERVAL_MS = 24 * 3600_000;
/** Same-origin route the sidebar widget polls. */
const USAGE_ROUTE_PATH = "/provider-usage/usage";
/** Same-origin route the Plugins-panel settings page uses. */
const SETTINGS_ROUTE_PATH = "/provider-usage/settings";
/** Chat command name this plugin owns. */
const COMMAND_NAME = "provider-usage";
/** Profile entry ids / package names probed for the dsh-opencode-go config. */
const OPENCODE_GO_ENTRY_SOURCES = ["opencode-go", "dsh-opencode-go"];
/** npm package whose live usage service is read in `opencode-go` mode. */
const OPENCODE_GO_PACKAGE = "dsh-opencode-go";
/** Cordis service dsh-opencode-go registers for host-side usage reads. */
const OPENCODE_GO_USAGE_SERVICE = "opencodeGoUsage";
/** Fallback account reference when dsh-opencode-go omits `apiKeyEnv`. */
const OPENCODE_GO_DEFAULT_ACCOUNT_REF = "OPENCODE_API_KEY";
/** Entry ids / package names probed when reading another plugin's live config. */
const LOCALE_ENTRY_SOURCES = ["locale", "@deepseek-ai/dsh-client-locale"];
const PI_AI_ENTRY_SOURCES = ["llm-pi-ai", "@deepseek-ai/dsh-llm-pi-ai"];

/** Allowed values for the GLM region field. */
export const GLM_REGIONS = ["auto", "zai", "bigmodel", "custom"];
/** Allowed OpenCode GO quota sources. */
export const OPENCODE_GO_SOURCES = ["opencode-go", "builtin"];

/** Resolves packages relative to this file (the profile's node_modules). */
const pluginRequire = createRequire(import.meta.url);

/** The version this running copy was installed as (read once at load). */
const CURRENT_VERSION = readPackageVersion();

/** Read `version` from the installed package.json next to this file. */
function readPackageVersion() {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		if (typeof pkg?.version === "string") return pkg.version;
	} catch {
		// fall through
	}
	return "0.0.0";
}

/**
 * Mark one field live-editable when the resolved schemastery supports it.
 * `.volatile()` only exists in schemastery >= 3.18.4; an older hoisted copy
 * must not make activation throw, it only loses the settings page/hot-edit.
 * @template T
 * @param {T} field
 * @returns {T}
 */
function live(field) {
	return typeof field?.volatile === "function" ? field.volatile() : field;
}

/**
 * Settings schema for this plugin's namespace.
 *
 * The loader consumes `Config` directly (DSH 2.x removed
 * `ctx.settings.register`). All fields are volatile so the auto-generated
 * Settings page can edit them live. The API keys themselves are credential
 * refs (`role("credential-ref")`), never values.
 */
export const Config = z.object({
	opencodeGoEnabled: live(z.boolean().default(true)),
	opencodeGoSource: live(z.union([
		z.const("opencode-go"),
		z.const("builtin")
	]).default("opencode-go").description(
		"OpenCode GO quota source: \"opencode-go\" follows the dsh-opencode-go active account and falls back to the built-in endpoint; \"builtin\" always uses apiKeyEnv/baseUrl."
	)),
	opencodeGoApiKeyEnv: live(z.string().role("credential-ref").default(DEFAULT_OPENCODE_API_KEY_ENV)),
	opencodeGoBaseUrl: live(z.string().default(DEFAULT_OPENCODE_BASE_URL)),
	opencodeConsoleEnabled: live(z.boolean().default(true)),
	opencodeConsoleApiKeyEnv: live(z.string().role("credential-ref").default(DEFAULT_OPENCODE_CONSOLE_API_KEY_ENV)),
	opencodeConsoleOrgId: live(z.string().default("")),
	opencodeConsoleAuthFile: live(z.string().default("")).description(
		"Optional OpenCode CLI auth.json path; empty auto-discovers auth.json and opencode.db."
	),
	opencodeConsoleDbFile: live(z.string().default("")).description(
		"Optional OpenCode opencode.db path; empty derives it from auth.json or the default data dir."
	),
	opencodeConsoleBaseUrl: live(z.string().default(DEFAULT_OPENCODE_CONSOLE_BASE_URL)),

	commandCodeEnabled: live(z.boolean().default(true)),
	commandCodeApiKeyEnv: live(z.string().role("credential-ref").default(DEFAULT_COMMAND_CODE_API_KEY_ENV)),
	commandCodeBaseUrl: live(z.string().default(DEFAULT_COMMAND_CODE_BASE_URL)),
	commandCodeAuthFile: live(z.string().default("")).description(
		"Optional Command Code CLI auth file; empty means ~/.commandcode/auth.json."
	),

	glmEnabled: live(z.boolean().default(true)),
	glmApiKeyEnv: live(z.string().role("credential-ref").default(DEFAULT_GLM_API_KEY_ENV)),
	glmBaseUrl: live(z.string().default("")).description(
		"Optional GLM API base override (for example https://api.z.ai); empty uses the region setting."
	),
	glmRegion: live(z.union([
		z.const("auto"),
		z.const("zai"),
		z.const("bigmodel"),
		z.const("custom")
	]).default("auto").description(
		"GLM region: auto probes api.z.ai then open.bigmodel.cn; zai/bigmodel pin one host; custom uses glmBaseUrl."
	)),

	cacheMs: live(z.number().default(DEFAULT_CACHE_MS)),
	updateCheck: live(z.boolean().default(true)),
	autoUpdate: live(z.boolean().default(true)).description(
		"Check the GitHub release feed and fast-forward a clean local checkout; a DSH restart applies the update. Market-installed copies report an update instead of modifying themselves."
	),
	autoUpdateCheckHours: live(z.number().default(6)).description(
		"Hours between automatic update checks (1-168)."
	),
	injectSessionHeader: live(z.boolean().default(true)),
	providerOrder: live(z.array(z.string()).default(["opencode-go", "command-code", "glm"]).description(
		"Provider display order in the sidebar widget; drag the cards in the plugin settings to change it."
	))
});

/** Unwrap a cosmokit volatile reference. */
function unwrap(value) {
	return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

/** A live string field, or its fallback when absent/empty. */
function stringOr(value, fallback) {
	const text = unwrap(value);
	return typeof text === "string" && text.trim().length > 0 ? text.trim() : fallback;
}

/** A live boolean field (false only when explicitly false). */
function boolOr(value, fallback) {
	const flag = unwrap(value);
	return typeof flag === "boolean" ? flag : fallback;
}

/** A live finite number field. */
function numberOr(value, fallback) {
	const number = unwrap(value);
	return typeof number === "number" && Number.isFinite(number) ? number : fallback;
}

/**
 * Read another profile entry's resolved config from the loader. `sources` is
 * probed as (entry id, then package name); the first active match wins.
 * Returns `undefined` when no match is live yet — callers fall back to their
 * own defaults, so load order never blocks activation.
 */
function liveEntryConfig(ctx, sources) {
	const loader = ctx.loader ?? ctx.root?.loader;
	if (!loader || typeof loader.entries !== "function") return undefined;
	for (const probe of sources) {
		for (const entry of loader.entries()) {
			if (!entry?.fiber || entry.fiber.uid == null || entry.disabled) continue;
			if (entry.options?.id === probe || entry.options?.name === probe) return entry.fiber.config;
			let qualified;
			try {
				qualified = entry.id;
			} catch {
				qualified = undefined;
			}
			if (qualified === probe) return entry.fiber.config;
		}
	}
	return undefined;
}

/** Normalize a user-supplied OpenCode GO source. */
export function normalizeOpencodeGoSource(value) {
	return value === "builtin" ? "builtin" : "opencode-go";
}

/** Normalize the GLM region choice. */
export function normalizeGlmRegion(value) {
	return GLM_REGIONS.includes(value) ? value : "auto";
}

/**
 * Normalize the provider display order: keep the first occurrence of every
 * known id, drop unknown or repeated ones, then append anything still missing
 * in canonical order — the result is a full permutation of PROVIDER_IDS.
 */
export function normalizeProviderOrder(value) {
	const order = [];
	if (Array.isArray(value)) {
		for (const item of value) {
			if (PROVIDER_IDS.includes(item) && !order.includes(item)) order.push(item);
		}
	}
	for (const id of PROVIDER_IDS) {
		if (!order.includes(id)) order.push(id);
	}
	return order;
}

/** Read the installed dsh-opencode-go version, or null when it is not installed. */
function opencodeGoVersion() {
	try {
		const path = pluginRequire.resolve(`${OPENCODE_GO_PACKAGE}/package.json`);
		const pkg = JSON.parse(readFileSync(path, "utf8"));
		return typeof pkg?.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
}

/**
 * Find one loader entry by id or package name, including a disabled entry.
 * The difference between "not installed" and "installed but disabled" is what
 * the settings page and the fallback badge report.
 */
function findLoaderEntry(ctx, sources) {
	try {
		const loader = ctx.loader ?? ctx.root?.loader;
		if (!loader || typeof loader.entries !== "function") return null;
		for (const entry of loader.entries()) {
			if (entry === null || typeof entry !== "object") continue;
			if (sources.includes(entry.options?.id) || sources.includes(entry.options?.name)) return entry;
			let qualified;
			try {
				qualified = entry.id;
			} catch {
				qualified = undefined;
			}
			if (sources.includes(qualified)) return entry;
		}
	} catch {
		// an unavailable loader reads as "not installed"
	}
	return null;
}

/**
 * Read the active-account metadata of the dsh-opencode-go profile entry.
 * dsh-opencode-go selects the active account by `apiKeyEnv` and keeps the
 * accounts list re-ordered so that entry is first; reading the same fields
 * reproduces its choice without touching its internals.
 */
function opencodeGoEntryInfo(ctx) {
	const entry = findLoaderEntry(ctx, OPENCODE_GO_ENTRY_SOURCES);
	if (entry === null) {
		return { found: false, enabled: null, baseURL: null, ref: null, account: null, accounts: [] };
	}
	const inactive = entry.disabled === true || entry.fiber === null || entry.fiber === undefined || entry.fiber.uid == null;
	/** @type {Record<string, unknown>} */
	const cfg = inactive ? {} : (entry.fiber.config ?? {});
	let enabled = inactive ? false : true;
	if (!inactive) {
		try {
			enabled = unwrap(cfg.enabled) !== false;
		} catch {
			// an unreadable live ref keeps the documented default (enabled)
		}
	}
	let ref = OPENCODE_GO_DEFAULT_ACCOUNT_REF;
	try {
		const value = unwrap(cfg.apiKeyEnv);
		if (typeof value === "string" && value.length > 0) ref = value;
	} catch {
		// keep the default ref
	}
	/** @type {Array<Record<string, unknown>>} */
	let accounts = [];
	try {
		const value = unwrap(cfg.accounts);
		if (Array.isArray(value)) accounts = value.filter((account) => account !== null && typeof account === "object");
	} catch {
		// no account list → a legacy single-key profile
	}
	const hit = accounts.find((account) => account.apiKeyEnv === ref) ?? null;
	let baseURL = null;
	try {
		const value = unwrap(cfg.baseURL);
		if (typeof value === "string" && value.length > 0) baseURL = value;
	} catch {
		// callers fall back to the plugin's own baseUrl
	}
	return {
		found: true,
		enabled,
		baseURL,
		ref,
		account: {
			ref,
			id: typeof hit?.id === "string" ? hit.id : null,
			name: typeof hit?.name === "string" ? hit.name : ""
		},
		accounts: accounts.map((account) => ({
			ref: typeof account.apiKeyEnv === "string" ? account.apiKeyEnv : "",
			name: typeof account.name === "string" ? account.name : ""
		}))
	};
}

/**
 * The dsh-opencode-go host usage service, or null when that plugin is absent
 * or too old to register it. `ctx.get` is intentionally used instead of an
 * `inject` dependency: a missing service must not block this plugin.
 */
function opencodeGoService(ctx) {
	try {
		if (typeof ctx.get !== "function") return null;
		const service = ctx.get(OPENCODE_GO_USAGE_SERVICE);
		return service !== null && typeof service?.read === "function" ? service : null;
	} catch {
		return null;
	}
}

/** Public (JSON-safe) view of an OpenCode GO probe result. */
function publicOpencodeGoProbe(probe) {
	return {
		detected: probe.detected === true,
		version: probe.version ?? null,
		entryFound: probe.entryFound === true,
		enabled: probe.enabled ?? null,
		service: probe.service === true,
		compatible: probe.compatible === true,
		reason: probe.reason ?? null,
		message: probe.message ?? null
	};
}

/** Base detection metadata shared by every OpenCode GO probe. */
function opencodeGoProbe(ctx) {
	const info = opencodeGoEntryInfo(ctx);
	const version = opencodeGoVersion();
	const service = opencodeGoService(ctx);
	return {
		info,
		service,
		probe: {
			detected: info.found || version !== null,
			version,
			entryFound: info.found,
			enabled: info.enabled,
			service: service !== null,
			compatible: false,
			reason: null,
			message: null
		}
	};
}

/**
 * Resolve the first credential ref that has a value, without ever returning
 * the value to the caller's caller. `resolveCredential` is also used by the
 * adapters.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function makeCredentialResolver(ctx) {
	return async (refs) => {
		for (const ref of refs) {
			if (!isCredentialRefName(ref)) continue;
			try {
				const hit = await ctx.credentials.resolve(ref);
				if (hit?.value !== null && hit?.value !== undefined && String(hit.value).length > 0) {
					return { ref, value: String(hit.value) };
				}
			} catch {
				// an unresolvable ref is just absent; try the next one
			}
		}
		return null;
	};
}

/** Build the normalized, defaulted config read on every request. */
function makeConfigReader(ctx, config) {
	return () => {
		const own = unwrap(config) ?? {};
		const localeEntry = liveEntryConfig(ctx, LOCALE_ENTRY_SOURCES) ?? {};
		const preference = unwrap(localeEntry.preference);
		return {
			opencodeGoEnabled: boolOr(own.opencodeGoEnabled, true),
			opencodeGoSource: normalizeOpencodeGoSource(unwrap(own.opencodeGoSource)),
			opencodeGoApiKeyEnv: stringOr(own.opencodeGoApiKeyEnv, DEFAULT_OPENCODE_API_KEY_ENV),
			opencodeGoBaseUrl: stringOr(own.opencodeGoBaseUrl, DEFAULT_OPENCODE_BASE_URL),
			opencodeConsoleEnabled: boolOr(own.opencodeConsoleEnabled, true),
			opencodeConsoleApiKeyEnv: stringOr(own.opencodeConsoleApiKeyEnv, DEFAULT_OPENCODE_CONSOLE_API_KEY_ENV),
			opencodeConsoleOrgId: stringOr(own.opencodeConsoleOrgId, ""),
			opencodeConsoleAuthFile: stringOr(own.opencodeConsoleAuthFile, ""),
			opencodeConsoleDbFile: stringOr(own.opencodeConsoleDbFile, ""),
			opencodeConsoleBaseUrl: stringOr(own.opencodeConsoleBaseUrl, DEFAULT_OPENCODE_CONSOLE_BASE_URL),
			commandCodeEnabled: boolOr(own.commandCodeEnabled, true),
			commandCodeApiKeyEnv: stringOr(own.commandCodeApiKeyEnv, DEFAULT_COMMAND_CODE_API_KEY_ENV),
			commandCodeBaseUrl: stringOr(own.commandCodeBaseUrl, DEFAULT_COMMAND_CODE_BASE_URL),
			commandCodeAuthFile: stringOr(own.commandCodeAuthFile, ""),
			glmEnabled: boolOr(own.glmEnabled, true),
			glmApiKeyEnv: stringOr(own.glmApiKeyEnv, DEFAULT_GLM_API_KEY_ENV),
			glmBaseUrl: stringOr(own.glmBaseUrl, ""),
			glmRegion: normalizeGlmRegion(unwrap(own.glmRegion)),
			cacheMs: Math.max(0, numberOr(own.cacheMs, DEFAULT_CACHE_MS)),
			updateCheck: boolOr(own.updateCheck, true),
			autoUpdate: boolOr(own.autoUpdate, true),
			autoUpdateCheckHours: Math.min(168, Math.max(1, numberOr(own.autoUpdateCheckHours, 6))),
			injectSessionHeader: boolOr(own.injectSessionHeader, true),
			providerOrder: normalizeProviderOrder(unwrap(own.providerOrder)),
			// DSH's own locale preference (live entry config); absent falls
			// back to zh (the browser decides when the user never picked).
			locale: typeof preference === "string" ? preference : "zh"
		};
	};
}

/** Whether a provider is enabled in a normalized config. */
function providerEnabled(id, config) {
	if (id === "opencode-go") return config.opencodeGoEnabled;
	if (id === "command-code") return config.commandCodeEnabled;
	if (id === "glm") return config.glmEnabled;
	return false;
}

/** Credential refs probed for a provider, in priority order. */
function credentialRefsFor(id, config, entry) {
	if (id === "opencode-go") {
		return [
			config.opencodeGoApiKeyEnv,
			entry?.enabled === true ? entry.ref : null,
			DEFAULT_OPENCODE_API_KEY_ENV,
			"OPENCODE_API_KEY"
		].filter(isCredentialRefName);
	}
	if (id === "command-code") {
		return [config.commandCodeApiKeyEnv, DEFAULT_COMMAND_CODE_API_KEY_ENV].filter(isCredentialRefName);
	}
	return [config.glmApiKeyEnv, ...GLM_KNOWN_REFS].filter(isCredentialRefName);
}

/** Cache identity for one provider. */
function cacheKeyFor(id, config, entry) {
	if (id === "opencode-go") {
		return [
			id,
			config.opencodeGoSource,
			config.opencodeGoApiKeyEnv,
			config.opencodeGoBaseUrl,
			entry?.ref ?? "",
			entry?.enabled ?? "",
			config.opencodeConsoleEnabled ? "console" : "no-console",
			config.opencodeConsoleApiKeyEnv,
			config.opencodeConsoleOrgId,
			config.opencodeConsoleAuthFile,
			config.opencodeConsoleDbFile,
			config.opencodeConsoleBaseUrl
		].join("|");
	}
	if (id === "command-code") {
		return [id, config.commandCodeApiKeyEnv, config.commandCodeBaseUrl, config.commandCodeAuthFile].join("|");
	}
	return [id, config.glmApiKeyEnv, config.glmBaseUrl, config.glmRegion].join("|");
}

/**
 * Error view of one provider. The widget renders this instead of throwing, so
 * one broken provider never hides the other two.
 */
function errorResult(id, error) {
	const info = providerInfo(id);
	return {
		...info,
		status: "error",
		error: error instanceof Error ? error.message : String(error),
		code: error instanceof ProviderError ? error.code : "read-failed",
		account: error?.account ?? null,
		plan: error?.plan ?? null,
		source: null,
		requested: null,
		fallback: error?.fallback ?? null,
		balance: error?.balance ?? null,
		windows: [],
		meta: error?.meta ?? null
	};
}

/**
 * Read one provider through its adapter.
 * @param {string} id
 * @param {ReturnType<typeof makeConfigReader>} readConfig
 * @param {any} ctx
 * @param {boolean} force
 * @param {Map<string, { at: number, key: string, promise: Promise<any> }>} cache
 */
async function readProvider(id, readConfig, ctx, force, cache) {
	const config = readConfig();
	const entry = id === "opencode-go" ? opencodeGoEntryInfo(ctx) : null;
	const key = cacheKeyFor(id, config, entry);
	const existing = cache.get(id);
	const now = Date.now();
	if (!force && existing !== undefined && existing.key === key && now - existing.at < config.cacheMs) {
		return existing.promise;
	}
	const resolver = makeCredentialResolver(ctx);
	const promise = (async () => {
		try {
			if (id === "opencode-go") {
				return await readOpencodeGo({
					config: {
						source: config.opencodeGoSource,
						apiKeyEnv: config.opencodeGoApiKeyEnv,
						baseUrl: config.opencodeGoBaseUrl,
						console: {
							enabled: config.opencodeConsoleEnabled,
							apiKeyEnv: config.opencodeConsoleApiKeyEnv,
							orgId: config.opencodeConsoleOrgId,
							authFile: config.opencodeConsoleAuthFile,
							dbFile: config.opencodeConsoleDbFile,
							baseUrl: config.opencodeConsoleBaseUrl
						}
					},
					resolveCredential: resolver,
					service: opencodeGoService(ctx),
					entry
				});
			}
			if (id === "command-code") {
				return await readCommandCode({
					config: {
						apiKeyEnv: config.commandCodeApiKeyEnv,
						baseUrl: config.commandCodeBaseUrl,
						authFile: config.commandCodeAuthFile
					},
					resolveCredential: resolver
				});
			}
			return await readGlm({
				config: {
					apiKeyEnv: config.glmApiKeyEnv,
					baseUrl: config.glmBaseUrl,
					region: config.glmRegion
				},
				resolveCredential: resolver
			});
		} catch (error) {
			return errorResult(id, error);
		}
	})();
	cache.set(id, { at: now, key, promise });
	return promise;
}

/**
 * Collect every enabled provider, in display order. Failures are isolated.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof makeConfigReader>} readConfig
 * @param {Map<string, { at: number, key: string, promise: Promise<any> }>} cache
 * @param {boolean} force
 */
async function collectUsage(ctx, readConfig, cache, force = false) {
	const config = readConfig();
	const enabled = PROVIDER_IDS.filter((id) => providerEnabled(id, config));
	if (enabled.length === 0) {
		return { ok: false, providers: [], enabled: [], error: "no providers enabled" };
	}
	const providers = await Promise.all(enabled.map((id) => readProvider(id, readConfig, ctx, force, cache)));
	const errors = providers.filter((provider) => provider.status === "error");
	return {
		ok: errors.length < providers.length,
		providers,
		enabled,
		error: errors.length === providers.length
			? providers.map((provider) => `${provider.name}: ${provider.error}`).join("; ")
			: undefined
	};
}

/** Human-friendly chat output, localized (zh | en). */
function renderUsageText(data, lang) {
	const zh = !(typeof lang === "string" && /^en\b/i.test(lang.trim()));
	const lines = [zh ? "服务商用量:" : "Provider usage:"];
	const labels = zh
		? { rolling: "5 小时窗口", "five-hour": "5 小时窗口", weekly: "周窗口", monthly: "月窗口", mcp: "MCP 工具 (月)", token: "Token 窗口", other: "其他窗口" }
		: { rolling: "5-hour window", "five-hour": "5-hour window", weekly: "Weekly", monthly: "Monthly", mcp: "MCP tools (monthly)", token: "Token window", other: "Other window" };
	const statusLabel = (status) => {
		if (status === "ok" || status === undefined || status === null) return zh ? "正常" : "ok";
		if (status === "exceeded") return zh ? "已超限" : "exceeded";
		return String(status);
	};
	for (const provider of data.providers) {
		if (provider.status === "error") {
			lines.push(zh
				? `  ${provider.name}: 不可用 — ${provider.error}`
				: `  ${provider.name}: unavailable — ${provider.error}`);
			continue;
		}
		const account = typeof provider.account?.name === "string" && provider.account.name.length > 0
			? provider.account.name
			: "";
		const plan = typeof provider.plan?.name === "string" && provider.plan.name.length > 0 ? provider.plan.name : "";
		const suffix = [account, plan].filter(Boolean).join(" / ");
		lines.push(`  ${provider.name}${suffix === "" ? "" : ` (${suffix})`}`);
		for (const window of provider.windows ?? []) {
			const label = labels[window.key] ?? window.key;
			const percent = typeof window.percent === "number" && Number.isFinite(window.percent)
				? Math.round(window.percent * 10) / 10
				: "—";
			const resets = window.resetsAt
				? (zh
					? `, 重置于 ${new Date(window.resetsAt).toLocaleString("zh-CN")}`
					: `, resets at ${new Date(window.resetsAt).toLocaleString("en-US")}`)
				: "";
			lines.push(`    ${label}: ${percent}% (${statusLabel(window.status)})${resets}`);
		}
		if (provider.balance && typeof provider.balance.amount === "number") {
			const money = (value) => provider.balance.currency === "USD" || !provider.balance.currency
				? `$${value.toFixed(2)}`
				: `${value.toFixed(2)} ${provider.balance.currency}`;
			let amount = money(provider.balance.amount);
			const parts = provider.balance.details;
			if (parts && typeof parts === "object" && typeof parts.purchased === "number") {
				const free = money(typeof parts.free === "number" ? parts.free : 0);
				amount += zh
					? ` (购买 ${money(parts.purchased)} + 免费 ${free})`
					: ` (purchased ${money(parts.purchased)} + free ${free})`;
			}
			lines.push(zh ? `    订阅外充值余额: ${amount}` : `    Top-up balance: ${amount}`);
		} else if (provider.meta?.balanceMissing === true) {
			lines.push(zh ? "    订阅外充值余额: 无充值额度" : "    Top-up balance: no top-up credits");
		} else if (typeof provider.meta?.balanceError === "string" && provider.meta.balanceError !== "") {
			if (/no console credential/i.test(provider.meta.balanceError)) {
				lines.push(zh
					? "    订阅外充值余额: 未配置 — 运行 opencode auth login 或设置 OPENCODE_CONSOLE_TOKEN"
					: "    Top-up balance: not configured — run opencode auth login or set OPENCODE_CONSOLE_TOKEN");
			} else {
				lines.push(zh
					? `    订阅外充值余额: 不可用 — ${provider.meta.balanceError}`
					: `    Top-up balance: unavailable — ${provider.meta.balanceError}`);
			}
		}
		const partialErrors = Array.isArray(provider.meta?.errors)
			? provider.meta.errors.filter((message) => typeof message === "string" && message !== "")
			: [];
		if (partialErrors.length > 0) {
			lines.push(zh
				? `    部分接口失败: ${partialErrors.join("; ")}`
				: `    Some endpoints failed: ${partialErrors.join("; ")}`);
		}
		if (provider.fallback) {
			const reason = provider.fallback.message || provider.fallback.reason || "";
			lines.push(zh
				? `    已回退到内置提供商: ${reason}`
				: `    Fell back to the built-in provider: ${reason}`);
		}
	}
	if (data.providers.length === 0) lines.push(zh ? "  未启用任何服务商。" : "  No providers are enabled.");
	const auto = data.autoUpdate;
	if (auto?.status === "updated" && auto.restartRequired) {
		lines.push(zh
			? `  插件已自动更新到 v${auto.version ?? auto.latestVersion ?? "?"}，重启 DSH 后生效。`
			: `  Plugin auto-updated to v${auto.version ?? auto.latestVersion ?? "?"}; restart DSH to apply.`);
	} else if (auto?.status === "available") {
		const detail = typeof auto.message === "string" && auto.message.length > 0 ? auto.message : "";
		lines.push(zh
			? `  插件有新版本 v${auto.latestVersion ?? "?"}，但自动更新未成功${detail ? `：${detail}` : ""}。请手动更新。`
			: `  Plugin update v${auto.latestVersion ?? "?"} is available, but the automatic update failed${detail ? `: ${detail}` : ""}. Update it manually.`);
	} else if (auto?.status === "error" && auto.message) {
		lines.push(zh ? `  自动更新检查失败: ${auto.message}` : `  Auto-update check failed: ${auto.message}`);
	}
	return lines.join("\n");
}

/**
 * Migration shim: delete a route row this plugin owns but an older build
 * leaked past its fiber. `webServer.register()` returns a disposer rather than
 * owning the row, so a registration made outside `ctx.effect` can outlive a
 * reload and make the next apply fail with a duplicate-route error.
 */
function dropStaleRoute(ctx, path) {
	try {
		for (const table of [ctx.webServer?.exact, ctx.webServer?.prefixes]) {
			if (table instanceof Map) table.delete(path);
		}
	} catch {
		// fall through: the duplicate-route error is still actionable
	}
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config - the resolved plugin config.
 */
export function apply(ctx, config = {}) {
	const readConfig = makeConfigReader(ctx, config);
	const packageDir = fileURLToPath(new URL("..", import.meta.url));
	const profileDir = typeof process.env.DSH_PROFILE_DIR === "string" && process.env.DSH_PROFILE_DIR.length > 0
		? process.env.DSH_PROFILE_DIR
		: typeof ctx.profileContext?.dir === "string" ? ctx.profileContext.dir : "";
	const autoUpdate = startAutoUpdate({
		packageDir,
		profileDir,
		packageName: NPM_PACKAGE,
		currentVersion: CURRENT_VERSION,
		getConfig: () => {
			const current = readConfig();
			return { autoUpdate: current.autoUpdate, autoUpdateCheckHours: current.autoUpdateCheckHours };
		},
		logger: ctx.logger
	});
	ctx.effect(() => () => autoUpdate.dispose(), "dsh-multi-provider-usage: auto update");

	// Host-side cache: one in-flight promise + a TTL per provider, so several
	// open tabs or the command never hammer the vendor APIs. The key includes
	// the resolved source and the active dsh-opencode-go account, so a settings
	// switch or an account auto-switch never serves the previous account.
	/** @type {Map<string, { at: number, key: string, promise: Promise<any> }>} */
	const providerCache = new Map();

	// ── runtime x-opencode-session injection ───────────────────────────────
	// The GO gateway rejects chat-completion requests without
	// `x-opencode-session`. Wrap globalThis.fetch once and stand on the
	// official `llm/stream` waterfall to learn the per-call harness session id.
	// The listener is always registered and re-reads the config on every call,
	// so toggling `injectSessionHeader` hot-applies instead of needing a restart.
	patchFetch();
	try {
		ctx.effect(() => ctx.on("llm/stream", (options, next) => {
			const config = readConfig();
			if (!config.injectSessionHeader) return next();
			const info = {
				provider: options.provider ?? null,
				hasSessionId: options.sessionId !== void 0,
				base: null,
				baseFrom: /** @type {"settings" | "config" | null} */ (null)
			};
			if (options.sessionId === void 0) {
				recordStream(info);
				return next();
			}
			const providers = unwrap(liveEntryConfig(ctx, PI_AI_ENTRY_SOURCES)?.providers);
			const configured = providers?.[options.provider]?.baseURL;
			const fallback = config.opencodeGoBaseUrl;
			const base = typeof configured === "string" && configured.length > 0 ? configured : fallback;
			info.base = typeof base === "string" ? base : null;
			info.baseFrom = typeof configured === "string" && configured.length > 0 ? "settings" : "config";
			recordStream(info);
			if (typeof base !== "string" || base.length === 0) return next();
			return withSession(next(), { sessionId: String(options.sessionId), base });
		}), "dsh-multi-provider-usage: session header");
	} catch {
		// A composition without the llm/stream waterfall still gets the widget
		// and the quota routes; only this optional chat-header fix is lost.
	}

	// ── update check (npm) ─────────────────────────────────────────────────
	// Checks the registry at most once per UPDATE_CHECK_INTERVAL_MS; failures
	// are silent. The plugin only reports — upgrading stays a user action.
	/** @type {{ at: number, latest: string | null } | null} */
	let updateState = null;
	const checkForUpdate = async (config) => {
		if (!config.updateCheck) return null;
		const now = Date.now();
		if (updateState !== null && now - updateState.at < UPDATE_CHECK_INTERVAL_MS) return updateState;
		const snapshot = { at: now, latest: null };
		try {
			const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, {
				signal: AbortSignal.timeout(10_000)
			});
			if (res.ok) {
				const json = await res.json();
				if (typeof json?.version === "string" && isNewerVersion(json.version, CURRENT_VERSION)) {
					snapshot.latest = json.version;
				}
			}
		} catch {
			// offline / registry hiccup — keep the previous result, refresh later
			snapshot.at = updateState?.at ?? now;
			snapshot.latest = updateState?.latest ?? null;
		}
		updateState = snapshot;
		return snapshot;
	};
	const updateInfoOf = (config) => {
		const st = updateState;
		if (!config.updateCheck || st === null || st.latest === null) {
			return { current: CURRENT_VERSION, available: false, latest: null };
		}
		return { current: CURRENT_VERSION, available: true, latest: st.latest };
	};

	// Kick off the first check shortly after boot (non-blocking).
	void checkForUpdate(readConfig()).catch(() => {});

	/** JSON response helper shared by the usage and settings routes. */
	const sendJson = (res, statusCode, body) => {
		res.statusCode = statusCode;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify(body));
	};

	const handleUsage = async (req, res) => {
		try {
			const config = readConfig();
			const url = new URL(req.url ?? USAGE_ROUTE_PATH, "http://127.0.0.1");
			const force = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
			void checkForUpdate(config).catch(() => {});
			const data = await collectUsage(ctx, readConfig, providerCache, force);
			const status = data.ok || data.providers.some((provider) => provider.status === "ok") ? 200 : 502;
			sendJson(res, status, {
				...data,
				providerOrder: config.providerOrder,
				autoUpdate: autoUpdate.getState(),
				update: updateInfoOf(config),
				sessionHeader: { active: config.injectSessionHeader, count: sessionHeaderCount(), diag: sessionDiag() }
			});
		} catch (error) {
			const config = readConfig();
			sendJson(res, 502, {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				providers: [],
				enabled: [],
				providerOrder: config.providerOrder,
				fallback: error?.details?.fallback ?? null
			});
		}
	};

	// ── settings page support ──────────────────────────────────────────────
	// DSH 2.x keys a plugin's settings page by its profile entry id and only
	// exposes volatile fields through `settings.describe()`. The custom page
	// persists through this route, so it works even when the auto-generated
	// "Plugin configuration" form is the only other view.
	const settingsServiceNow = () => {
		try {
			return typeof ctx.get === "function" ? ctx.get("settings") : null;
		} catch {
			return null;
		}
	};
	const settingsNamespaceNow = () => {
		try {
			const id = ctx?.fiber?.entry?.options?.id;
			if (typeof id === "string" && id.length > 0) return id;
		} catch {
			// a fiber with no owning entry falls back to the exported namespace
		}
		return namespace;
	};
	const settingsDescriptorNow = (settings, ns) => {
		try {
			return (settings.describe({ redactSecrets: true }) ?? []).find((entry) => entry.ns === ns) ?? null;
		} catch {
			return null;
		}
	};

	/**
	 * Non-network detection snapshot for the settings page and diagnostics.
	 * It resolves credentials only to answer "is this provider configured?";
	 * values never leave this function.
	 */
	const detectProvider = async (id, config) => {
		const resolver = makeCredentialResolver(ctx);
		if (id === "opencode-go") {
			const { info, service, probe } = opencodeGoProbe(ctx);
			const refs = credentialRefsFor(id, config, info);
			const credential = await resolver(refs);
			const integration = config.opencodeGoSource === "opencode-go"
				? (info.found && info.enabled !== false && service !== null)
				: false;
			const fallback = config.opencodeGoSource === "opencode-go" && !integration
				? {
					from: "opencode-go",
					reason: !info.found ? "not-installed" : info.enabled === false ? "entry-disabled" : "service-unavailable",
					message: !info.found
						? "dsh-opencode-go is not installed, or its profile entry is inactive"
						: info.enabled === false
							? "dsh-opencode-go is installed but disabled in this profile"
							: "dsh-opencode-go does not expose the opencodeGoUsage service (unsupported version)"
				}
				: null;
			let consoleInfo = { enabled: config.opencodeConsoleEnabled, configured: false, source: null, orgId: null, error: null };
			try {
				consoleInfo = await opencodeConsoleStatus({
					config: {
						enabled: config.opencodeConsoleEnabled,
						apiKeyEnv: config.opencodeConsoleApiKeyEnv,
						orgId: config.opencodeConsoleOrgId,
						authFile: config.opencodeConsoleAuthFile,
						dbFile: config.opencodeConsoleDbFile
					},
					resolveCredential: resolver
				});
			} catch (error) {
				consoleInfo = {
					enabled: config.opencodeConsoleEnabled,
					configured: false,
					source: null,
					orgId: null,
					error: error instanceof Error ? error.message : String(error)
				};
			}
			return {
				id,
				name: providerInfo(id).name,
				enabled: config.opencodeGoEnabled,
				configured: integration || credential !== null,
				credentialRef: credential?.ref ?? refs[0] ?? null,
				source: integration ? "opencode-go" : "builtin",
				requested: config.opencodeGoSource,
				account: info.account,
				accounts: info.accounts,
				version: opencodeGoVersion(),
				entryFound: info.found,
				entryEnabled: info.enabled,
				service: service !== null,
				compatible: integration,
				fallback,
				console: consoleInfo,
				opencodeGo: {
					...publicOpencodeGoProbe(probe),
					service: service !== null,
					compatible: integration,
					account: info.account,
					accounts: info.accounts
				}
			};
		}
		if (id === "command-code") {
			const credential = await resolver(credentialRefsFor(id, config, null));
			const authFile = readCommandCodeAuthFile(config.commandCodeAuthFile);
			return {
				id,
				name: providerInfo(id).name,
				enabled: config.commandCodeEnabled,
				configured: credential !== null || authFile !== null,
				credentialRef: credential?.ref ?? config.commandCodeApiKeyEnv,
				source: credential !== null ? "credential" : authFile !== null ? "auth-file" : null,
				authFile: authFile?.path ?? null,
				account: authFile?.userName ? { ref: authFile.path, id: null, name: authFile.userName } : null
			};
		}
		const credential = await resolver(credentialRefsFor(id, config, null));
		return {
			id,
			name: providerInfo(id).name,
			enabled: config.glmEnabled,
			configured: credential !== null,
			credentialRef: credential?.ref ?? config.glmApiKeyEnv,
			source: credential === null ? null : `credential:${credential.ref}`,
			region: config.glmRegion,
			baseUrl: config.glmBaseUrl || (config.glmRegion === "zai" ? GLM_ZAI_BASE_URL : config.glmRegion === "bigmodel" ? GLM_BIGMODEL_BASE_URL : null)
		};
	};

	const detectionPayload = async () => {
		const config = readConfig();
		const entries = await Promise.all(PROVIDER_IDS.map(async (id) => {
			try {
				return [id, await detectProvider(id, config)];
			} catch (error) {
				return [id, {
					id,
					name: providerInfo(id).name,
					enabled: providerEnabled(id, config),
					configured: false,
					error: error instanceof Error ? error.message : String(error)
				}];
			}
		}));
		return {
			providerOrder: config.providerOrder,
			providers: Object.fromEntries(entries),
			enabled: PROVIDER_IDS.filter((id) => providerEnabled(id, config)),
			autoUpdate: autoUpdate.getState(),
			locale: config.locale
		};
	};

	const readRequestBody = async (req) => {
		let body = "";
		for await (const chunk of req) {
			body += chunk;
			if (body.length > 64_000) throw new Error("request body too large");
		}
		return body;
	};

	/** Reject a cross-origin settings write (the usage route is read-only). */
	const sameOrigin = (req) => {
		const origin = req.headers?.origin;
		if (typeof origin !== "string" || origin.length === 0) return true;
		const port = ctx.webServer?.port;
		if (typeof port !== "number") return true;
		const host = ctx.webServer?.host;
		const allowed = new Set([
			`http://127.0.0.1:${port}`,
			`http://localhost:${port}`,
			`http://${host}:${port}`
		]);
		return allowed.has(origin);
	};

	/** Validate and whitelist a settings patch; returns null when nothing valid is present. */
	const cleanSettingsPatch = (input) => {
		if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
		const patch = {};
		const bools = ["opencodeGoEnabled", "opencodeConsoleEnabled", "commandCodeEnabled", "glmEnabled", "updateCheck", "autoUpdate", "injectSessionHeader"];
		for (const key of bools) {
			if (typeof input[key] === "boolean") patch[key] = input[key];
		}
		if (input.opencodeGoSource === "opencode-go" || input.opencodeGoSource === "builtin") {
			patch.opencodeGoSource = input.opencodeGoSource;
		}
		if (Array.isArray(input.providerOrder)) patch.providerOrder = normalizeProviderOrder(input.providerOrder);
		if (GLM_REGIONS.includes(input.glmRegion)) patch.glmRegion = input.glmRegion;
		const strings = [
			"opencodeGoApiKeyEnv",
			"opencodeGoBaseUrl",
			"opencodeConsoleApiKeyEnv",
			"opencodeConsoleOrgId",
			"opencodeConsoleAuthFile",
			"opencodeConsoleDbFile",
			"opencodeConsoleBaseUrl",
			"commandCodeApiKeyEnv",
			"commandCodeBaseUrl",
			"commandCodeAuthFile",
			"glmApiKeyEnv",
			"glmBaseUrl"
		];
		for (const key of strings) {
			if (typeof input[key] === "string" && input[key].length <= 500 && !/[\r\n]/.test(input[key])) {
				patch[key] = input[key].trim();
			}
		}
		if (typeof input.cacheMs === "number" && Number.isFinite(input.cacheMs) && input.cacheMs >= 0 && input.cacheMs <= 3_600_000) {
			patch.cacheMs = Math.round(input.cacheMs);
		}
		if (typeof input.autoUpdateCheckHours === "number" && Number.isFinite(input.autoUpdateCheckHours) && input.autoUpdateCheckHours >= 1 && input.autoUpdateCheckHours <= 168) {
			patch.autoUpdateCheckHours = Math.round(input.autoUpdateCheckHours);
		}
		return Object.keys(patch).length === 0 ? null : patch;
	};

	const handleSettings = async (req, res) => {
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "POST") {
			res.statusCode = 405;
			res.end();
			return;
		}
		if (method === "POST" && !sameOrigin(req)) {
			sendJson(res, 403, { ok: false, error: "cross-origin request refused" });
			return;
		}
		const settings = settingsServiceNow();
		if (settings === null) {
			sendJson(res, 503, { ok: false, error: "the settings service is not available in this composition" });
			return;
		}
		const ns = settingsNamespaceNow();
		const descriptor = settingsDescriptorNow(settings, ns);
		if (descriptor === null) {
			sendJson(res, 503, {
				ok: false,
				namespace: ns,
				error: `settings namespace "${ns}" is not registered`,
				hint: "DSH derives this page from the plugin's exported Config; it must be active and declare at least one volatile field. Restart DSH after upgrading, and check that the profile entry id matches."
			});
			return;
		}
		if (method === "GET") {
			let detection = null;
			try {
				detection = await detectionPayload();
			} catch {
				detection = null;
			}
			sendJson(res, 200, {
				ok: true,
				namespace: descriptor.ns,
				revision: descriptor.revision ?? 0,
				value: descriptor.value ?? {},
				base: descriptor.base ?? {},
				user: descriptor.user ?? {},
				detection
			});
			return;
		}

		let body;
		try {
			body = JSON.parse((await readRequestBody(req)) || "{}");
		} catch {
			sendJson(res, 400, { ok: false, error: "invalid JSON body" });
			return;
		}
		const patch = cleanSettingsPatch(body?.patch);
		if (patch === null) {
			sendJson(res, 400, { ok: false, error: "missing or invalid patch object" });
			return;
		}
		try {
			await settings.update(ns, patch, Number.isInteger(body?.expectedRevision) ? body.expectedRevision : undefined);
			providerCache.clear();
			// A settings save is the natural point to act on a just-enabled
			// auto-update toggle instead of waiting for the next hourly tick.
			void autoUpdate.checkNow(true).catch(() => {});
			const next = settingsDescriptorNow(settings, ns);
			let detection = null;
			try {
				detection = await detectionPayload();
			} catch {
				detection = null;
			}
			sendJson(res, 200, { ok: true, revision: next?.revision ?? 0, detection });
		} catch (error) {
			if (error?.code === "SETTINGS_CONFLICT" || error?.name === "SettingsConflictError") {
				sendJson(res, 409, {
					ok: false,
					conflict: true,
					currentRevision: error.actual,
					error: "设置已被其他会话修改，请重新加载后再保存。"
				});
				return;
			}
			sendJson(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 500) });
		}
	};

	// Same-origin routes the browser widget and settings page use. Registered
	// through `ctx.effect` so a live plugin reload disposes the previous
	// registrations before the next apply.
	ctx.effect(() => {
		dropStaleRoute(ctx, USAGE_ROUTE_PATH);
		dropStaleRoute(ctx, SETTINGS_ROUTE_PATH);
		const owned = [
			{ kind: "exact", path: USAGE_ROUTE_PATH, handler: handleUsage },
			{ kind: "exact", path: SETTINGS_ROUTE_PATH, handler: handleSettings }
		].map((route) => ({
			route,
			dispose: ctx.webServer.register(route)
		}));
		return () => {
			for (const { route, dispose } of owned) {
				// A newer fiber may already own this path. Releasing it only when
				// ours is still current keeps an overlapping reload from deleting
				// the replacement's route.
				try {
					const table = route.kind === "exact" ? ctx.webServer?.exact : ctx.webServer?.prefixes;
					if (table instanceof Map && table.get(route.path) !== route) continue;
				} catch {
					// no introspectable table: fall through to the normal disposer
				}
				if (typeof dispose === "function") dispose();
			}
		};
	}, "dsh-multi-provider-usage: routes");

	// Chat command so the numbers are reachable from a conversation too. Owned
	// by this fiber; a duplicate left by an older build only warns.
	try {
		ctx.effect(
			() => ctx.commands.register({
				name: COMMAND_NAME,
				description: "show OpenCode GO / Command Code / GLM Code Plan quota windows",
				handler: async () => {
					try {
						const config = readConfig();
						const data = await collectUsage(ctx, readConfig, providerCache, false);
						data.autoUpdate = autoUpdate.getState();
						let text = renderUsageText(data, config.locale);
						const update = updateInfoOf(config);
						if (update.available && update.latest !== null) {
							text += config.locale === "en"
								? `\n\nUpdate available: v${update.latest} — run \`dsh plugin --profile <profile> add ${NPM_PACKAGE}@latest\` to upgrade.`
								: `\n\n发现新版本 v${update.latest} — 执行 \`dsh plugin --profile <profile> add ${NPM_PACKAGE}@latest\` 升级。`;
						}
						return { kind: data.ok ? "success" : "error", text };
					} catch (error) {
						return { kind: "error", text: error instanceof Error ? error.message : String(error) };
					}
				}
			}),
			"dsh-multi-provider-usage: command"
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/already registered/i.test(message)) throw error;
		try {
			ctx.logger?.warn?.(`dsh-multi-provider-usage: /${COMMAND_NAME} is still owned by a previous instance; the widget keeps working and a restart restores the command`);
		} catch {
			// logging is best-effort
		}
	}
}

/** Exposed for tests and diagnostics. */
export const PROVIDER_USAGE_INFO = {
	providers: PROVIDERS,
	providerIds: PROVIDER_IDS,
	usageRoute: USAGE_ROUTE_PATH,
	settingsRoute: SETTINGS_ROUTE_PATH,
	commandName: COMMAND_NAME,
	currentVersion: CURRENT_VERSION
};
