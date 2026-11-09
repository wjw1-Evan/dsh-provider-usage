// @ts-check
/**
 * dsh-multi-provider-usage — provider adapters.
 *
 * Every adapter turns one subscription's vendor API into the same canonical
 * shape, so the host routes and the browser widget never need provider-specific
 * branches:
 *
 *   {
 *     id, name, short,
 *     status: "ok" | "error",
 *     account: { name, ref, id } | null,
 *     plan: { id, name, status, periodStart, periodEnd, totalCredits } | null,
 *     source: string,             // credential ref / auth file / vendor path
 *     requested: string | null,   // for the OpenCode GO integration fallback
 *     fallback: { from, reason, message } | null,
 *     windows: [{
 *       key, labelKey, hintKey, percent, status, resetsAt, windowMs, note
 *     }],
 *     meta: object
 *   }
 *
 * The adapters are dependency-injected (`fetchImpl`, `resolveCredential`,
 * `service`) so the hermetic tests can run them without network or real keys.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isCredentialRefName, uniqueStrings } from "./util.js";
import { readOpencodeBalance } from "./opencode-console.js";

// ── provider catalogue ─────────────────────────────────────────────────────

/** Stable provider ids, in display order. */
export const PROVIDER_IDS = ["opencode-go", "command-code", "glm"];

/** Display metadata for the widget tabs and the settings page. */
export const PROVIDERS = [
	{ id: "opencode-go", name: "OpenCode GO", short: "GO", order: 0 },
	{ id: "command-code", name: "Command Code", short: "CC", order: 1 },
	{ id: "glm", name: "GLM Code Plan", short: "GLM", order: 2 }
];

/** One provider's display metadata by id. */
export function providerInfo(id) {
	return PROVIDERS.find((provider) => provider.id === id) ?? { id, name: id, short: id.toUpperCase(), order: 99 };
}

/**
 * The plan windows each provider can expose. `windowMs` is the window LENGTH
 * used by the client's time bar; adapters may override it (Command Code's
 * monthly window is the real billing period).
 */
export const WINDOW_DEFS = {
	rolling: { labelKey: "window.five-hour", hintKey: "window.five-hour.hint", windowMs: 5 * 3600e3 },
	"five-hour": { labelKey: "window.five-hour", hintKey: "window.five-hour.hint", windowMs: 5 * 3600e3 },
	weekly: { labelKey: "window.weekly", hintKey: null, windowMs: 7 * 86400e3 },
	monthly: { labelKey: "window.monthly", hintKey: null, windowMs: 30 * 86400e3 },
	mcp: { labelKey: "window.mcp", hintKey: "window.mcp.hint", windowMs: null },
	token: { labelKey: "window.token", hintKey: null, windowMs: null },
	other: { labelKey: "window.other", hintKey: null, windowMs: null }
};

/** Canonical window key for the alias spellings vendors use. */
export function canonicalWindowKey(key) {
	if (key === "fiveHour" || key === "five-hour") return "five-hour";
	return key;
}

// ── small parsing helpers ──────────────────────────────────────────────────

/**
 * Finite number or null. Numeric strings are accepted too: vendor APIs
 * serialize counters as strings often enough that rejecting them turns a
 * whole provider into an error (or silently drops one window).
 */
export function finiteNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** Clamp a percentage into [0, 100]; null stays null. */
export function clampPercent(value) {
	const number = finiteNumber(value);
	if (number === null) return null;
	return Math.max(0, Math.min(100, number));
}

/** ISO string for a Date, epoch-ms number, or date string; null when invalid/zero. */
export function toIso(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		// A numeric string is an epoch timestamp like the numeric branch below
		// (Date.parse would reject it and silently drop the reset time).
		if (/^\d+$/.test(trimmed)) return toIso(Number(trimmed));
		const ms = Date.parse(trimmed);
		return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
	}
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		// Vendor timestamps are milliseconds; accept seconds defensively.
		const ms = value < 10_000_000_000 ? value * 1000 : value;
		return new Date(ms).toISOString();
	}
	return null;
}

/** Build one canonical window, omitting fields the vendor did not send. */
export function makeWindow(key, percent, options = {}) {
	const canonical = canonicalWindowKey(key);
	// Duplicate vendor limits are suffixed (`five-hour-2`); they still belong
	// to the base window, so they keep its label, hint and time-bar length.
	const def = WINDOW_DEFS[canonical] ?? WINDOW_DEFS[canonical.replace(/-\d+$/, "")] ?? WINDOW_DEFS.other;
	const value = clampPercent(percent);
	return {
		key: canonical,
		labelKey: options.labelKey ?? def.labelKey,
		hintKey: options.hintKey ?? def.hintKey ?? null,
		percent: value,
		status: typeof options.status === "string" && options.status.length > 0
			? options.status
			: value !== null && value >= 100 ? "exceeded" : "ok",
		resetsAt: toIso(options.resetsAt),
		windowMs: typeof options.windowMs === "number" && Number.isFinite(options.windowMs) && options.windowMs > 0
			? options.windowMs
			: options.windowMs === null ? null : def.windowMs ?? null,
		...(typeof options.note === "string" && options.note.length > 0 ? { note: options.note } : {}),
		// Token usage is only attached when the vendor reports an absolute
		// count for this window (Command Code's billing-period summary); the
		// client renders it after the window label when the field exists.
		...(Number.isFinite(options.tokensUsed) ? { tokensUsed: options.tokensUsed } : {}),
		// Vendors that count things other than tokens (GLM's monthly MCP tool
		// limit) report an absolute used/cap pair; forwarded when both exist.
		...(Number.isFinite(options.used) && options.used >= 0 ? { used: options.used } : {}),
		...(Number.isFinite(options.cap) && options.cap > 0 ? { cap: options.cap } : {})
	};
}

// ── adapter registry ───────────────────────────────────────────────────────

/**
 * Data-driven map of provider id → adapter entry point. Mirrors the host's
 * `PROVIDER_REGISTRY` so callers can dispatch generically instead of
 * branching on the provider id. Each adapter keeps its own option shape; this
 * table only removes the id-based dispatch boilerplate.
 */
export const PROVIDER_READERS = Object.freeze({
	"opencode-go": readOpencodeGo,
	"command-code": readCommandCode,
	"glm": readGlm
});


/** Provider failure with a machine-readable code and optional public details. */
export class ProviderError extends Error {
	/**
	 * @param {string} code - stable diagnostic code (`no-credential`, `http-error`, …).
	 * @param {string} message - human-readable, already safe to show.
	 * @param {Record<string, unknown>} [details] - public fields merged onto the error result.
	 */
	constructor(code, message, details = {}) {
		super(message);
		this.name = "ProviderError";
		this.code = code;
		Object.assign(this, details);
	}
}

/** JSON fetch with a timeout and a bounded error body. */
async function fetchJson(fetchImpl, url, init = {}, label = "request") {
	let res;
	try {
		res = await fetchImpl(url, {
			...init,
			signal: init.signal ?? AbortSignal.timeout(15_000)
		});
	} catch (error) {
		throw new ProviderError("network-error", `${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new ProviderError("http-error", `${label} ${res.status}: ${body.slice(0, 300)}`, {
			httpStatus: res.status,
			// Kept for callers that classify the vendor's typed error envelope
			// (OpenCode GO's `EntitlementError`) instead of pattern-matching the
			// composed message.
			body: body.slice(0, 300)
		});
	}
	try {
		return await res.json();
	} catch {
		throw new ProviderError("invalid-response", `${label}: response is not JSON`);
	}
}

/**
 * HTTP statuses that mean "ask again later" rather than "the setup is wrong".
 * A `429` is a throttle and every `5xx` is the vendor's own failure.
 */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);

/**
 * Whether a read failure is transient — the vendor did not answer this time
 * (DNS/connect failure, timeout, throttle, gateway error) — instead of a state
 * the user can act on (missing key, rejected key, vendor `success: false`).
 *
 * The host uses this to keep showing the last good numbers instead of an error
 * card when a refresh stumbles, so a momentary network blip no longer wipes
 * the widget. `error.transient === true` is the explicit override for callers
 * that already classified a failure themselves (a `withTimeout` abandonment,
 * an aggregated provider read where every call failed on the wire).
 *
 * @param {unknown} error
 */
export function isTransientProviderError(error) {
	if (error === null || typeof error !== "object") return false;
	if (/** @type {{ transient?: unknown }} */ (error).transient === true) return true;
	const code = /** @type {{ code?: unknown }} */ (error).code;
	if (code === "network-error") return true;
	if (code === "http-error") {
		// `fetchJson` records `httpStatus`; the OpenCode console client records
		// `status`. Either one is the vendor's answer.
		const status = Number(/** @type {{ httpStatus?: unknown, status?: unknown }} */ (error).httpStatus
			?? /** @type {{ status?: unknown }} */ (error).status);
		// A status-less HTTP failure is treated as actionable: hiding a 4xx
		// behind stale numbers is worse than showing one error card.
		if (!Number.isFinite(status)) return false;
		return status >= 500 || TRANSIENT_HTTP_STATUSES.has(status);
	}
	return false;
}

/**
 * The transport classification of a wrapped error, for a re-thrown
 * `ProviderError` that replaces it: without this, `opencodeGoFailure` and the
 * GLM aggregator would drop `httpStatus` and every such failure would look
 * transient (a revoked key hiding forever behind stale numbers).
 * @param {unknown} error
 */
function transportFields(error) {
	/** @type {Record<string, unknown>} */
	const fields = {};
	if (error === null || error === undefined || typeof error !== "object") return fields;
	const status = Number(/** @type {{ httpStatus?: unknown, status?: unknown }} */ (error).httpStatus
		?? /** @type {{ status?: unknown }} */ (error).status);
	if (Number.isFinite(status)) fields.httpStatus = status;
	if (/** @type {{ transient?: unknown }} */ (error).transient === true) fields.transient = true;
	return fields;
}

// ── OpenCode GO ────────────────────────────────────────────────────────────

export const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/go";
export const DEFAULT_OPENCODE_API_KEY_ENV = "OPENCODE_GO_API_KEY";

/**
 * Validate and canonicalize the gateway's `{ usage: { rolling, weekly, monthly } }`
 * payload (also accepts the flat shape `dsh-opencode-go`'s service returns).
 * Throws instead of turning absent data into zeroes.
 * @param {unknown} payload
 */
export function normalizeOpencodeUsage(payload) {
	const usage = payload !== null && typeof payload === "object" && payload.usage !== null && typeof payload.usage === "object"
		? payload.usage
		: payload;
	const out = [];
	for (const [key, windowKey] of [["rolling", "rolling"], ["weekly", "weekly"], ["monthly", "monthly"]]) {
		const row = usage?.[key];
		if (row === null || typeof row !== "object" || finiteNumber(row.percent) === null) {
			throw new ProviderError("invalid-response", `invalid usage payload: missing ${key}.percent`);
		}
		out.push(makeWindow(windowKey, row.percent, {
			status: typeof row.status === "string" ? row.status : "ok",
			resetsAt: row.resetsAt
		}));
	}
	return out;
}

/**
 * Probe the optional `dsh-opencode-go` integration without a network call.
 * @param {unknown} service - the `opencodeGoUsage` service, or null.
 * @param {{ found?: boolean, enabled?: boolean|null, account?: object, ref?: string, baseURL?: string|null } | null} entry
 */
export function probeOpencodeGo(service, entry) {
	if (!entry || entry.found !== true) {
		return {
			ok: false,
			reason: "not-installed",
			message: "dsh-opencode-go is not installed, or its profile entry is inactive",
			entryFound: false,
			enabled: null,
			service: service !== null && service !== undefined
		};
	}
	if (entry.enabled === false) {
		return {
			ok: false,
			reason: "entry-disabled",
			message: "dsh-opencode-go is installed but disabled in this profile",
			entryFound: true,
			enabled: false,
			service: service !== null && service !== undefined
		};
	}
	if (service === null || service === undefined || typeof service.read !== "function") {
		return {
			ok: false,
			reason: "service-unavailable",
			message: "dsh-opencode-go does not expose the opencodeGoUsage service (unsupported version)",
			entryFound: true,
			enabled: true,
			service: false
		};
	}
	return { ok: true, reason: null, message: null, entryFound: true, enabled: true, service: true };
}

/**
 * Whether a failed OpenCode GO read is the gateway's entitlement refusal.
 *
 * A 401/403 carrying `{"type":"error","error":{"type":"EntitlementError",
 * "message":"OpenCode Go subscription required."}}` means the API key itself
 * was accepted but its account has no OpenCode GO subscription. That is a
 * setup state of its own: retrying, or installing the optional
 * `dsh-opencode-go` integration, cannot create a subscription, so the failure
 * must read as "subscribe" rather than as a broken provider.
 * @param {unknown} error
 */
function opencodeEntitlementFailure(error) {
	if (error === null || typeof error !== "object") return false;
	const status = Number(/** @type {{ httpStatus?: unknown, status?: unknown }} */ (error).httpStatus
		?? /** @type {{ status?: unknown }} */ (error).status);
	if (status !== 401 && status !== 403) return false;
	const body = /** @type {{ body?: unknown, message?: unknown }} */ (error).body
		?? /** @type {{ message?: unknown }} */ (error).message;
	return /EntitlementError|OpenCode Go subscription required|subscription[_-]required/i.test(String(body ?? ""));
}

/** How long a third-party quota service may take before the read is abandoned. */
const SERVICE_READ_TIMEOUT_MS = 15_000;

/**
 * Await `value`, but reject with a ProviderError after `ms`. A provider that
 * never settles used to hang the whole aggregated read (and the cached
 * promise behind it) forever, so it must time out like the HTTP paths do.
 * @template T
 * @param {T | Promise<T>} value
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(value, ms, message) {
	let timer = null;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new ProviderError("read-failed", message, { transient: true })), ms);
		if (typeof timer?.unref === "function") timer.unref();
	});
	return Promise.race([Promise.resolve(value), timeout]).finally(() => {
		if (timer !== null) clearTimeout(timer);
	});
}

/** Start the optional OpenCode console balance read (never rejects). */
function startOpencodeBalance(consoleConfig, resolveCredential, fetchImpl) {
	if (consoleConfig === null || consoleConfig === undefined || consoleConfig.enabled !== true) {
		return Promise.resolve(null);
	}
	return readOpencodeBalance({ config: consoleConfig, resolveCredential, fetchImpl })
		.then((balance) => ({ ok: true, balance }))
		.catch((error) => ({ ok: false, error }));
}

/**
 * Project a settled balance read into public result fields.
 *
 * A failed read carries `balanceSetup` when the user can act on it (no console
 * login, an API-key-only login, or an expired/revoked session); the widget
 * turns that into a setup chip instead of a mute dash. A read that only failed
 * on the wire is `balanceTransient`: it is not an error to show — the quota
 * numbers are the point — and the host keeps the previous balance for it.
 */
function balanceFields(settled) {
	if (settled === null) return { balance: null, balanceError: null, balanceSetup: null, balanceTransient: false };
	if (settled.ok) return { balance: settled.balance, balanceError: null, balanceSetup: null, balanceTransient: false };
	const error = settled.error;
	const code = error?.code;
	if (isTransientProviderError(error)) {
		return { balance: null, balanceError: null, balanceSetup: null, balanceTransient: true };
	}
	return {
		balance: null,
		balanceError: error instanceof Error ? error.message : String(error),
		balanceSetup: code === "no-console-credential"
			? "no-credential"
			: code === "console-api-key"
				? "api-key"
				: code === "console-unauthorized" ? "expired" : null,
		balanceTransient: false
	};
}

/** Merge a settled balance read into one provider result. */
function attachBalance(result, settled) {
	const fields = balanceFields(settled);
	return {
		...result,
		balance: fields.balance,
		meta: {
			...(result.meta ?? {}),
			...(fields.balanceError === null ? {} : { balanceError: fields.balanceError }),
			...(fields.balanceSetup === null ? {} : { balanceSetup: fields.balanceSetup }),
			...(fields.balanceTransient ? { balanceTransient: true } : {})
		}
	};
}

/**
 * Build the OpenCode GO error result shared by every failure path: the
 * account, the integration probe, the fallback and the settled balance read
 * always travel together so the widget never hides the quota that did arrive.
 * `cause` (when there is one) carries the transport classification of the
 * error being replaced, so a 401 stays actionable and a network failure stays
 * transient.
 */
async function opencodeGoFailure(code, message, accountRef, probe, fallback, balancePromise, cause = null) {
	const balance = balanceFields(await balancePromise);
	return new ProviderError(code, message, {
		account: { ref: accountRef, id: null, name: "" },
		fallback,
		balance: balance.balance,
		...transportFields(cause),
		meta: {
			opencodeGo: probe,
			...(balance.balanceError === null ? {} : { balanceError: balance.balanceError }),
			...(balance.balanceSetup === null ? {} : { balanceSetup: balance.balanceSetup }),
			...(balance.balanceTransient ? { balanceTransient: true } : {})
		}
	});
}

/**
 * Read OpenCode GO quota.
 *
 * `source: "opencode-go"` prefers the live `dsh-opencode-go` service (so the
 * numbers follow its active account), then falls back to the official
 * `${baseUrl}/v1/usage` endpoint with a resolved credential. `source:
 * "builtin"` pins the HTTP path.
 *
 * @param {{
 *   config: { source?: string, apiKeyEnv?: string, baseUrl?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 *   service?: { read?: () => Promise<unknown> } | null,
 *   entry?: object | null,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
export async function readOpencodeGo(input) {
	const { config, resolveCredential, service = null, entry = null, fetchImpl = fetch } = input;
	const source = config.source === "builtin" ? "builtin" : "opencode-go";
	const probe = probeOpencodeGo(service, entry);
	const balancePromise = startOpencodeBalance(config.console, resolveCredential, fetchImpl);
	let fallback = null;

	if (source === "opencode-go") {
		if (probe.ok) {
			let raw;
			try {
				raw = await withTimeout(
					service.read(),
					SERVICE_READ_TIMEOUT_MS,
					"OpenCode GO: the dsh-opencode-go usage service did not answer in time"
				);
			} catch (error) {
				fallback = {
					from: "opencode-go",
					reason: "read-failed",
					message: error instanceof Error ? error.message : String(error)
				};
			}
			if (fallback === null) {
				try {
					const windows = normalizeOpencodeUsage(raw);
					return attachBalance({
						...providerInfo("opencode-go"),
						status: "ok",
						account: entry?.account ?? null,
						plan: null,
						source: "opencode-go",
						requested: "opencode-go",
						fallback: null,
						windows,
						meta: { opencodeGo: { ...probe, compatible: true }, lastSwitch: raw?.lastSwitch ?? null }
					}, await balancePromise);
				} catch (error) {
					fallback = {
						from: "opencode-go",
						reason: "invalid-response",
						message: error instanceof Error ? error.message : String(error)
					};
				}
			}
		} else {
			fallback = { from: "opencode-go", reason: probe.reason, message: probe.message };
		}
	}

	const refs = uniqueStrings([
		config.apiKeyEnv,
		entry?.enabled === true ? entry.ref : null,
		DEFAULT_OPENCODE_API_KEY_ENV,
		"OPENCODE_API_KEY"
	]).filter(isCredentialRefName);
	const credential = await resolveCredential(refs);
	if (credential === null) {
		const reason = fallback === null ? null : `; ${fallback.reason}: ${fallback.message}`;
		throw await opencodeGoFailure(
			"no-credential",
			`OpenCode GO: no API key (set one of ${refs.join(", ")})${reason ?? ""}`,
			config.apiKeyEnv ?? DEFAULT_OPENCODE_API_KEY_ENV,
			probe,
			fallback,
			balancePromise
		);
	}

	const baseUrl = String(config.baseUrl || entry?.baseURL || DEFAULT_OPENCODE_BASE_URL).replace(/\/+$/, "");
	let payload;
	try {
		payload = await fetchJson(
			fetchImpl,
			`${baseUrl}/v1/usage`,
			{ headers: { Authorization: `Bearer ${credential.value}` } },
			"OpenCode GO usage"
		);
	} catch (error) {
		const entitlement = opencodeEntitlementFailure(error);
		// The "why built-in" suffix explains a fallback, not the vendor's
		// answer. On an entitlement refusal it is pure noise — the account
		// lacks a subscription, so neither a retry nor the optional integration
		// would change anything — and it made a plain 403 look like a second,
		// unrelated breakage. The fallback still travels in `fallback`/`meta`.
		const reason = fallback === null || entitlement
			? ""
			: ` — dsh-opencode-go: ${fallback.reason}: ${fallback.message}`;
		throw await opencodeGoFailure(
			entitlement ? "no-subscription" : error instanceof ProviderError ? error.code : "read-failed",
			entitlement
				? "OpenCode GO: this account has no active OpenCode GO subscription"
				: `${error instanceof Error ? error.message : String(error)}${reason}`,
			credential.ref,
			probe,
			fallback,
			balancePromise,
			error
		);
	}

	let windows;
	try {
		windows = normalizeOpencodeUsage(payload);
	} catch (error) {
		throw await opencodeGoFailure(
			"invalid-response",
			error instanceof Error ? error.message : String(error),
			credential.ref,
			probe,
			fallback,
			balancePromise
		);
	}

	return attachBalance({
		...providerInfo("opencode-go"),
		status: "ok",
		// The numbers came from the built-in credential, so this account
		// describes that ref; the dsh-opencode-go probe lives in meta.
		account: { ref: credential.ref, id: null, name: "" },
		plan: null,
		source: "builtin",
		requested: source,
		fallback,
		windows,
		meta: {
			opencodeGo: {
				...probe,
				reason: fallback?.reason ?? probe.reason,
				message: fallback?.message ?? probe.message,
				compatible: fallback === null && probe.ok
			}
		}
	}, await balancePromise);
}

// ── Command Code ───────────────────────────────────────────────────────────

export const DEFAULT_COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
export const DEFAULT_COMMAND_CODE_API_KEY_ENV = "COMMANDCODE_API_KEY";

/** Plan totals documented by the Command Code CLI (credits). */
const COMMAND_CODE_PLAN_TOTALS = {
	"individual-go": 10,
	"individual-go-v1": 10,
	"individual-goat": 70,
	"individual-pro": 30,
	"individual-pro-v1": 80,
	"individual-provider": 15,
	"individual-max": 150,
	"individual-ultra": 300,
	"teams-pro": 40
};
const COMMAND_CODE_PLAN_NAMES = {
	"individual-go": "Go",
	"individual-go-v1": "Go",
	"individual-goat": "GOAT",
	"individual-pro": "Pro",
	"individual-pro-v1": "Pro",
	"individual-provider": "Provider",
	"individual-max": "Max",
	"individual-ultra": "Ultra",
	"teams-pro": "Teams Pro"
};
const COMMAND_CODE_PLAN_IDS = Object.keys(COMMAND_CODE_PLAN_TOTALS).sort((a, b) => b.length - a.length);

/** Resolve a subscription plan id to its display name and monthly credit total. */
export function commandCodePlan(planId) {
	if (typeof planId !== "string" || planId.length === 0) return null;
	const normalized = planId.toLowerCase().replace(/_/g, "-");
	const id = COMMAND_CODE_PLAN_IDS.find((candidate) => normalized.startsWith(candidate));
	if (id === undefined) return { id: normalized, name: planId, totalCredits: null };
	return { id, name: COMMAND_CODE_PLAN_NAMES[id] ?? id, totalCredits: COMMAND_CODE_PLAN_TOTALS[id] ?? null };
}

/** Expand `~` and environment variables in a user-supplied path. */
function expandHome(pathValue) {
	const raw = String(pathValue ?? "").trim();
	if (raw === "") return join(homedir(), ".commandcode", "auth.json");
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
	return raw;
}

/** Read a Command Code CLI auth file and return its API key, if any. */
export function readCommandCodeAuthFile(pathValue) {
	const path = expandHome(pathValue);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		for (const key of ["apiKey", "api_key", "token", "accessToken"]) {
			if (typeof parsed?.[key] === "string" && parsed[key].length > 0) {
				return { key: parsed[key], path, userName: typeof parsed.userName === "string" ? parsed.userName : "" };
			}
		}
	} catch {
		// absent / unreadable auth file is the same as "not configured"
	}
	return null;
}

/**
 * Read Command Code quota from its billing/usage APIs.
 *
 * The CLI's `/alpha/billing/credits` response supplies the 5-hour and weekly
 * windows, `/alpha/billing/subscriptions` supplies the billing period, and
 * `/alpha/usage/summary` supplies period spend. Monthly utilization is
 * `totalCost / (totalCost + remaining credits)`, which is the same relation the
 * official CLI exposes (and what its usage screen displays).
 *
 * @param {{
 *   config: { apiKeyEnv?: string, baseUrl?: string, authFile?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
export async function readCommandCode(input) {
	const { config, resolveCredential, fetchImpl = fetch } = input;
	const refs = uniqueStrings([config.apiKeyEnv, DEFAULT_COMMAND_CODE_API_KEY_ENV]).filter(isCredentialRefName);
	const credential = await resolveCredential(refs);
	let auth = null;
	let source = null;
	let accountRef = "";
	if (credential !== null) {
		auth = credential.value;
		source = `credential:${credential.ref}`;
		accountRef = credential.ref;
	} else {
		const file = readCommandCodeAuthFile(config.authFile);
		if (file !== null) {
			auth = file.key;
			source = "auth-file";
			accountRef = file.path;
		}
	}
	if (auth === null) {
		throw new ProviderError(
			"no-credential",
			`Command Code: no API key (set ${refs[0] ?? DEFAULT_COMMAND_CODE_API_KEY_ENV}, or sign in with the Command Code CLI)`,
			{ account: { ref: refs[0] ?? DEFAULT_COMMAND_CODE_API_KEY_ENV, id: null, name: "" } }
		);
	}

	const baseUrl = String(config.baseUrl || DEFAULT_COMMAND_CODE_BASE_URL).replace(/\/+$/, "");
	const headers = {
		Authorization: `Bearer ${auth}`,
		"Content-Type": "application/json",
		"User-Agent": "dsh-multi-provider-usage/0.1"
	};
	/**
	 * One billing read. The vendor answers HTTP 200 with a `success: false`
	 * envelope for interface-level failures (rate limit, permission, …), which
	 * used to be parsed as data and then surface as a generic "no usable quota
	 * windows" error. Treat the envelope as the error it is.
	 *
	 * `transient` says whether the failure was transport-level (the request
	 * never got an answer). Only those are allowed to disappear into a stale
	 * fallback; a vendor-declared failure is always reported.
	 * @param {string} path
	 */
	const get = async (path) => {
		const label = `Command Code ${path.split("?")[0]}`;
		try {
			const body = await fetchJson(fetchImpl, baseUrl + path, { headers }, label);
			if (body !== null && typeof body === "object" && body.success === false) {
				const detail = body.error?.message ?? body.message ?? body.msg ?? "request unsuccessful";
				return { data: null, error: `${label}: ${detail}`, transient: false };
			}
			return { data: body, error: null, transient: false };
		} catch (error) {
			return {
				data: null,
				error: error instanceof Error ? error.message : String(error),
				transient: isTransientProviderError(error)
			};
		}
	};

	const [whoamiResult, subscriptionResult, creditsResult] = await Promise.all([
		get("/alpha/whoami?limits=1"),
		get("/alpha/billing/subscriptions"),
		get("/alpha/billing/credits")
	]);
	const subscription = subscriptionResult.data?.data ?? null;
	// The subscription owns the billing period. When it fails the summary's own
	// period start still scopes the numbers: the vendor answers the current
	// billing period, and `periodBasis` says so explicitly.
	const subscriptionStart = typeof subscription?.currentPeriodStart === "string" ? subscription.currentPeriodStart : null;
	const summaryResult = await get(`/alpha/usage/summary${subscriptionStart === null ? "" : `?since=${encodeURIComponent(subscriptionStart)}`}`);
	const summary = summaryResult.data ?? null;
	const summaryStart = typeof summary?.periodStart === "string" ? summary.periodStart : null;
	const periodStart = subscriptionStart ?? summaryStart;
	const periodEnd = typeof subscription?.currentPeriodEnd === "string" ? subscription.currentPeriodEnd : null;
	// Trust summary-derived spend only when it is scoped to the billing period:
	// an unscoped summary would otherwise move the plan bar to an arbitrary
	// range without any reset time to explain it.
	const periodScoped = subscriptionStart !== null
		|| (summaryStart !== null && (summary?.periodBasis === undefined || summary?.periodBasis === null || summary?.periodBasis === "billing-period"));
	const credits = creditsResult.data?.credits ?? null;
	const windowLimits = creditsResult.data?.windowLimits ?? null;

	// Every failed call, split by whether it was a transport hiccup or a real
	// answer. A read where every failure was transport-level (`fetch failed`,
	// timeout, 5xx, 429) is `transient`: the host answers with the provider's
	// last good numbers instead of an error card. A missing/rejected key or a
	// vendor `success: false` is never transient, so it still reaches the user.
	const failures = [whoamiResult, subscriptionResult, creditsResult, summaryResult].filter((result) => result.error !== null);
	const errors = failures.map((result) => result.error);
	const hardErrors = failures.filter((result) => result.transient !== true).map((result) => result.error);
	const allTransient = failures.length > 0 && failures.every((result) => result.transient === true);
	if (whoamiResult.data === null && creditsResult.data === null && subscriptionResult.data === null && summaryResult.data === null) {
		throw new ProviderError("read-failed", `Command Code: ${errors.join("; ") || "all billing endpoints failed"}`, { transient: allTransient });
	}

	const whoami = whoamiResult.data ?? null;
	const planId = typeof subscription?.planId === "string" ? subscription.planId : null;
	const planInfo = commandCodePlan(planId);
	const accountName = typeof whoami?.user?.name === "string" && whoami.user.name.length > 0
		? whoami.user.name
		: typeof whoami?.user?.userName === "string" ? whoami.user.userName : "";
	const account = {
		ref: accountRef,
		id: typeof whoami?.user?.id === "string" ? whoami.user.id : null,
		name: accountName
	};
	const plan = planInfo === null ? null : {
		id: planInfo.id,
		name: planInfo.name,
		status: typeof subscription?.status === "string" ? subscription.status : null,
		periodStart,
		periodEnd,
		totalCredits: planInfo.totalCredits
	};

	const windows = [];

	// Monthly credits: the plan bar tracks the plan's own credit pool only.
	// `summary.totalCost` also counts purchased and free ("Extra Credits")
	// spend, so using it as the numerator/denominator moved the plan bar
	// whenever top-up credits were consumed (their sum still = totalCost).
	// Purchased and free credits stay in `meta.monthly` and the top-up balance.
	const used = finiteNumber(summary?.totalCost);
	const planUsed = periodScoped ? finiteNumber(summary?.totalMonthlyCredits) : null;
	const monthlyRemaining = finiteNumber(credits?.monthlyCredits);
	const purchasedRemaining = finiteNumber(credits?.purchasedCredits);
	const freeRemaining = finiteNumber(credits?.freeCredits);
	const planTotal = planInfo === null ? null : planInfo.totalCredits;
	// The credits endpoint is the only source for the top-up balance. When it
	// fails, or answers without either credit pool, the widget still needs to
	// say why instead of leaving the balance slot blank.
	const balanceError = creditsResult.error === null ? null : `Command Code balance: ${creditsResult.error}`;
	const balanceMissing = creditsResult.error === null && purchasedRemaining === null && freeRemaining === null;
	// Plan-scoped spend: the vendor's own counter wins; otherwise derive it
	// from the plan total minus what is left (same relation as the CLI).
	const planSpent = planUsed ?? (planTotal !== null && monthlyRemaining !== null
		? planTotal - Math.max(0, monthlyRemaining)
		: null);
	let monthlyCap = null;
	let monthlyPercent = null;
	if (planSpent !== null && planTotal !== null && monthlyRemaining !== null) {
		// `monthlyRemaining` only arrives with a working credits read; without
		// it there is no balance and no rolling windows either, so the provider
		// reports the failure instead of a lone monthly bar.
		monthlyCap = planTotal;
		monthlyPercent = planTotal > 0 ? (planSpent / planTotal) * 100 : 0;
	} else if (planSpent !== null && monthlyRemaining !== null) {
		monthlyCap = planSpent + monthlyRemaining;
		monthlyPercent = monthlyCap > 0 ? (planSpent / monthlyCap) * 100 : 0;
	} else if (used !== null && monthlyRemaining !== null) {
		// Unknown plan and no plan-scoped counter: best effort over total spend.
		monthlyCap = used + monthlyRemaining;
		monthlyPercent = monthlyCap > 0 ? (used / monthlyCap) * 100 : 0;
	}
	let monthlyWindow = null;
	if (monthlyPercent !== null) {
		const start = periodStart === null ? null : Date.parse(periodStart);
		const end = periodEnd === null ? null : Date.parse(periodEnd);
		// The usage summary spans exactly the billing period, so its token
		// count is the monthly window's token usage. `totalTokens` wins; fall
		// back to in + out when the vendor omits the combined field.
		const summaryTokens = finiteNumber(summary?.totalTokens);
		const tokensIn = finiteNumber(summary?.totalTokensIn);
		const tokensOut = finiteNumber(summary?.totalTokensOut);
		const monthlyTokens = summaryTokens ?? (tokensIn !== null && tokensOut !== null ? tokensIn + tokensOut : null);
		monthlyWindow = makeWindow("monthly", monthlyPercent, {
			status: monthlyPercent >= 100 ? "exceeded" : "ok",
			resetsAt: periodEnd,
			windowMs: Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null,
			tokensUsed: monthlyTokens
		});
	}

	// 5-hour and weekly rolling windows. `resetAt` is epoch milliseconds and 0
	// when the window has not started / is unlimited.
	for (const [key, label] of [["five-hour", "fiveHour"], ["weekly", "weekly"]]) {
		const limit = windowLimits?.[label];
		if (limit === null || typeof limit !== "object") continue;
		const cap = finiteNumber(limit.cap);
		const windowUsed = finiteNumber(limit.used);
		if (cap === null || windowUsed === null || cap <= 0) continue;
		const percent = (windowUsed / cap) * 100;
		windows.push(makeWindow(key, percent, {
			status: limit.exceeded === true || percent >= 100 ? "exceeded" : "ok",
			resetsAt: limit.resetAt
		}));
	}
	// The monthly billing window always renders last for Command Code.
	if (monthlyWindow !== null) windows.push(monthlyWindow);

	const extraCredits = purchasedRemaining !== null || freeRemaining !== null
		? (purchasedRemaining ?? 0) + (freeRemaining ?? 0)
		: null;
	const balance = extraCredits === null ? null : {
		amount: extraCredits,
		currency: "USD",
		labelKey: "balance.extra",
		source: "command-code-credits",
		details: { purchased: purchasedRemaining, free: freeRemaining }
	};

	if (windows.length === 0) {
		// The credits request carries the windows, so a failure there leaves
		// nothing to render; name the underlying error instead of a generic
		// "no usable windows" (the 5xx used to be swallowed into meta.errors).
		const cause = errors.length === 0 ? "" : ` (${errors.join("; ")})`;
		throw new ProviderError("invalid-response", `Command Code: billing responses contained no usable quota windows${cause}`, {
			account,
			plan,
			balance,
			// Only transport-level failures may fall back to the last good read;
			// one hard failure (rejected key, vendor error) keeps the card.
			transient: failures.length > 0 && hardErrors.length === 0,
			meta: { errors, ...(balanceError === null ? {} : { balanceError }) }
		});
	}

	// Useful diagnostics for the settings page and the chat command.
	const totalDays = periodStart !== null && periodEnd !== null
		? (Date.parse(periodEnd) - Date.parse(periodStart)) / 86400e3
		: null;
	const elapsedDays = periodStart !== null
		? (Date.now() - Date.parse(periodStart)) / 86400e3
		: null;
	// The projection answers "when do the plan credits run out", so it follows
	// plan spend only — top-up credits have their own balance.
	const projectedSpend = planSpent ?? used;
	const dailyRate = projectedSpend !== null && elapsedDays !== null && elapsedDays > 0 ? projectedSpend / elapsedDays : null;
	const runsOutInDays = dailyRate !== null && dailyRate > 0 && monthlyRemaining !== null ? monthlyRemaining / dailyRate : null;

	return {
		...providerInfo("command-code"),
		status: "ok",
		account,
		plan,
		source,
		requested: null,
		fallback: null,
		balance,
		windows,
		meta: {
			planId,
			// Only failures worth showing: a transient call (timeout, 5xx, …)
			// that left the rest of the read intact must not turn the health dot
			// amber or put "fetch failed" in the tooltip.
			errors: hardErrors,
			...(balanceError === null ? {} : { balanceError }),
			...(balanceMissing ? { balanceMissing: true } : {}),
			monthly: {
				// `used` stays the whole billing-period spend (it also feeds the
				// top-up story); `planUsed`/`cap`/`percent` are the plan bar.
				used,
				planUsed: planSpent,
				remaining: monthlyRemaining,
				purchased: purchasedRemaining,
				free: freeRemaining,
				extra: extraCredits,
				cap: monthlyCap,
				percent: monthlyPercent,
				periodBasis: summary?.periodBasis ?? null
			},
			totals: summary === null ? null : {
				requests: summary.totalCount ?? null,
				successRate: summary.successRate ?? null,
				completed: summary.completedCount ?? null,
				failed: summary.failedCount ?? null,
				tokensIn: summary.totalTokensIn ?? null,
				tokensOut: summary.totalTokensOut ?? null
			},
			projection: {
				elapsedDays: Number.isFinite(elapsedDays) ? elapsedDays : null,
				totalDays: Number.isFinite(totalDays) ? totalDays : null,
				dailyRate,
				runsOutInDays
			}
		}
	};
}

// ── GLM Code Plan (Z.ai / BigModel) ────────────────────────────────────────

export const DEFAULT_GLM_API_KEY_ENV = "ZAI_API_KEY";
export const GLM_ZAI_BASE_URL = "https://api.z.ai";
export const GLM_BIGMODEL_BASE_URL = "https://open.bigmodel.cn";
export const GLM_KNOWN_REFS = [
	"ZAI_CODING_CN_API_KEY",
	"ZAI_API_KEY",
	"ZHIPU_API_KEY",
	"GLM_API_KEY",
	"BIGMODEL_API_KEY"
];

/** Build the quota URL for a base that may or may not include `/api`. */
export function glmQuotaUrl(baseUrl) {
	const base = String(baseUrl ?? "").replace(/\/+$/, "");
	return base.endsWith("/api")
		? `${base}/monitor/usage/quota/limit`
		: `${base}/api/monitor/usage/quota/limit`;
}

/** Candidate base URLs for the configured region, in probe order. */
export function glmBases(config = {}) {
	const explicit = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
	if (config.region === "custom") return explicit.length === 0 ? [] : [explicit.replace(/\/+$/, "")];
	if (explicit.length > 0) return [explicit.replace(/\/+$/, "")];
	const region = config.region === "bigmodel" || config.region === "zai" ? config.region : "auto";
	if (region === "zai") return [GLM_ZAI_BASE_URL];
	if (region === "bigmodel") return [GLM_BIGMODEL_BASE_URL];
	return [GLM_ZAI_BASE_URL, GLM_BIGMODEL_BASE_URL];
}

/** Which GLM Code Plan version a base URL belongs to (`zai` | `bigmodel` | `custom`). */
export function glmBaseKind(baseUrl) {
	const base = String(baseUrl ?? "").replace(/\/+$/, "");
	if (base === GLM_ZAI_BASE_URL) return "zai";
	if (base === GLM_BIGMODEL_BASE_URL) return "bigmodel";
	return "custom";
}

/** Host without the scheme, for compact "国际版（api.z.ai）" labels. */
function glmHostLabel(baseUrl) {
	return String(baseUrl ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** Localized names for the two GLM Code Plan versions (plus a custom host). */
function glmVersionLabels(locale) {
	const zh = !(typeof locale === "string" && /^en\b/i.test(locale.trim()));
	return zh
		? { zai: "国际版", bigmodel: "国内版", custom: "自定义" }
		: { zai: "international", bigmodel: "China", custom: "custom" };
}

/**
 * Human failure message for GLM: name every version that was probed, not just
 * the last one. Identical answers (the common "this account has no Coding
 * Plan" case) collapse into one sentence instead of repeating themselves.
 * @param {{ kind: string, base: string, error: string }[]} failures
 * @param {string} [locale]
 */
export function glmFailureMessage(failures, locale) {
	const zh = !(typeof locale === "string" && /^en\b/i.test(locale.trim()));
	const labels = glmVersionLabels(locale);
	if (failures.length === 0) return "GLM Code Plan: no endpoint answered";
	if (failures.length === 1) {
		const only = failures[0];
		return `GLM Code Plan (${only.base}): ${only.error}`;
	}
	const open = zh ? "（" : " (";
	const close = zh ? "）" : ")";
	const named = (failure) => `${labels[failure.kind]}${open}${glmHostLabel(failure.base)}${close}`;
	const unique = [...new Set(failures.map((failure) => failure.error))];
	if (unique.length === 1) {
		// Both versions speaking with one voice is the "this account has no
		// Coding Plan" case; keep that line short enough for the sidebar.
		const versions = failures.map((failure) => labels[failure.kind]).join(zh ? "和" : " and ");
		return zh
			? `GLM Code Plan：${versions}都返回「${unique[0]}」`
			: `GLM Code Plan: both the ${versions} versions returned "${unique[0]}"`;
	}
	const detail = failures.map((failure) => `${named(failure)}: ${failure.error}`).join(zh ? "；" : "; ");
	return zh ? `GLM Code Plan：${detail}` : `GLM Code Plan: ${detail}`;
}

/** Extract the `limits` array from the several envelope shapes the API uses. */
export function glmLimits(payload) {
	if (Array.isArray(payload?.limits)) return payload.limits;
	if (Array.isArray(payload?.data?.limits)) return payload.data.limits;
	if (Array.isArray(payload?.data?.data?.limits)) return payload.data.data.limits;
	return null;
}

/**
 * Turn the GLM quota payload into canonical windows.
 *
 * `TOKENS_LIMIT` with `unit: 3, number: 5` is the 5-hour token window and
 * `unit: 6, number: 1` is the weekly one; `TIME_LIMIT` is the monthly MCP tool
 * limit. Unknown limits are still surfaced, labeled by their raw type.
 * @param {unknown} payload
 */
export function normalizeGlmUsage(payload) {
	const limits = glmLimits(payload);
	if (limits === null || limits.length === 0) {
		throw new ProviderError("invalid-response", "GLM Code Plan: response has no limits array");
	}
	const windows = [];
	const seen = new Map();
	for (let index = 0; index < limits.length; index++) {
		const raw = limits[index];
		if (raw === null || typeof raw !== "object") continue;
		const type = typeof raw.type === "string" ? raw.type : "UNKNOWN";
		// The MCP counter is the one limit that may arrive without a percentage;
		// its used/cap pair is the same relation, so use it as the fallback.
		const mcpUsed = type === "TIME_LIMIT" ? finiteNumber(raw.currentValue) : null;
		const mcpCap = type === "TIME_LIMIT" ? finiteNumber(raw.usage) : null;
		const percent = finiteNumber(raw.percentage)
			?? (mcpUsed !== null && mcpCap !== null && mcpCap > 0 ? (mcpUsed / mcpCap) * 100 : null);
		if (percent === null) continue;
		let key;
		let labelKey;
		let hintKey = null;
		let note;
		let used = null;
		let cap = null;
		if (type === "TOKENS_LIMIT") {
			const unit = finiteNumber(raw.unit);
			const number = finiteNumber(raw.number);
			if (unit === 3 && number === 5) {
				key = "five-hour";
			} else if (unit === 6 && number === 1) {
				key = "weekly";
			} else {
				key = "token";
				note = unit !== null && number !== null ? `${unit}/${number}` : undefined;
			}
		} else if (type === "TIME_LIMIT") {
			key = "mcp";
			labelKey = "window.mcp";
			hintKey = "window.mcp.hint";
			// The monthly MCP tool limit counts tool calls: `currentValue` is
			// the used count and `usage` the cap (123/1000 renders as 12.3%).
			used = mcpUsed;
			cap = mcpCap;
		} else {
			key = "other";
			labelKey = "window.other";
			note = type;
		}
		const occurrence = seen.get(key) ?? 0;
		seen.set(key, occurrence + 1);
		if (occurrence > 0) key = `${key}-${occurrence + 1}`;
		windows.push(makeWindow(key, percent, {
			...(labelKey === undefined ? {} : { labelKey }),
			hintKey,
			status: percent >= 100 ? "exceeded" : "ok",
			resetsAt: raw.nextResetTime,
			...(used !== null ? { used, cap } : {}),
			note
		}));
	}
	if (windows.length === 0) {
		throw new ProviderError("invalid-response", "GLM Code Plan: limits contained no percentage values");
	}
	const order = { "five-hour": 0, weekly: 1, mcp: 2, token: 3, other: 4 };
	const baseKey = (key) => String(key).replace(/-\d+$/, "");
	windows.sort((a, b) => (order[/** @type {keyof typeof order} */ (baseKey(a.key))] ?? 9) - (order[/** @type {keyof typeof order} */ (baseKey(b.key))] ?? 9));
	return windows;
}

/**
 * Read GLM Code Plan quota.
 *
 * The API uses a raw `Authorization: <token>` header (no Bearer prefix) and
 * answers HTTP 200 with `{ success: false, msg }` for account-level failures.
 * In `auto` region mode both the international (`api.z.ai`) and China
 * (`open.bigmodel.cn`) versions are probed; when both reject the token the
 * error names each version's answer instead of only the last probe.
 *
 * @param {{
 *   config: { apiKeyEnv?: string, baseUrl?: string, region?: string, locale?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
export async function readGlm(input) {
	const { config, resolveCredential, fetchImpl = fetch } = input;
	const refs = uniqueStrings([config.apiKeyEnv, ...GLM_KNOWN_REFS]).filter(isCredentialRefName);
	const credential = await resolveCredential(refs);
	if (credential === null) {
		throw new ProviderError(
			"no-credential",
			`GLM Code Plan: no API key (set ${refs[0] ?? DEFAULT_GLM_API_KEY_ENV}, or ZAI_CODING_CN_API_KEY / ZHIPU_API_KEY)`,
			{ account: { ref: refs[0] ?? DEFAULT_GLM_API_KEY_ENV, id: null, name: "" } }
		);
	}

	const bases = glmBases(config);
	if (bases.length === 0) {
		throw new ProviderError("no-endpoint", "GLM Code Plan: custom region needs glmBaseUrl", {
			account: { ref: credential.ref, id: null, name: "" }
		});
	}
	/** One failed probe; `kind` names the version for the aggregated message. */
	const failures = [];
	let lastError = null;
	for (const base of bases) {
		const kind = glmBaseKind(base);
		let payload;
		try {
			payload = await fetchJson(
				fetchImpl,
				glmQuotaUrl(base),
				{
					headers: {
						// The GLM quota endpoint expects the raw token, not a Bearer scheme.
						Authorization: String(credential.value).replace(/^Bearer\s+/i, ""),
						"Content-Type": "application/json",
						"Accept-Language": "en-US,en"
					}
				},
				`GLM Code Plan (${base})`
			);
		} catch (error) {
			lastError = error;
			failures.push({
				kind,
				base,
				error: error instanceof Error ? error.message : String(error),
				transient: isTransientProviderError(error)
			});
			continue;
		}
		if (payload?.success === false) {
			const message = typeof payload.msg === "string" && payload.msg.length > 0
				? payload.msg
				: typeof payload.message === "string" && payload.message.length > 0 ? payload.message : "request unsuccessful";
			lastError = new ProviderError("api-error", `GLM Code Plan (${base}): ${message}`);
			failures.push({ kind, base, error: message, transient: false });
			continue;
		}
		let windows;
		try {
			windows = normalizeGlmUsage(payload);
		} catch (error) {
			lastError = error;
			failures.push({
				kind,
				base,
				error: error instanceof Error ? error.message : String(error),
				transient: false
			});
			continue;
		}
		const data = payload?.data !== null && typeof payload?.data === "object" ? payload.data : {};
		const planName = [data.planName, data.plan, data.packageName, data.level]
			.find((value) => typeof value === "string" && value.length > 0) ?? null;
		const accountName = [data.userName, data.user?.name, data.name]
			.find((value) => typeof value === "string" && value.length > 0) ?? "";
		return {
			...providerInfo("glm"),
			status: "ok",
			account: { ref: credential.ref, id: null, name: accountName },
			plan: planName === null ? { id: null, name: "GLM Code Plan", status: null, periodStart: null, periodEnd: null, totalCredits: null } : {
				id: null,
				name: planName,
				status: null,
				periodStart: null,
				periodEnd: null,
				totalCredits: null
			},
			source: `credential:${credential.ref}`,
			requested: null,
			fallback: null,
			windows,
			meta: { region: base, regionKind: kind }
		};
	}

	// Only a read where every probed version failed on the wire is transient:
	// one rejected answer (401/403, a vendor `success: false`) means the setup
	// is wrong and the user has to see it, whatever the last probe happened to
	// return.
	const transient = failures.length > 0 && failures.every((failure) => failure.transient === true);
	throw new ProviderError(
		lastError instanceof ProviderError ? lastError.code : "read-failed",
		glmFailureMessage(failures, config.locale),
		{
			account: { ref: credential.ref, id: null, name: "" },
			...(transient ? { transient: true } : {}),
			// Every probed version's answer stays on the payload for diagnostics
			// (settings tooltips / future row rendering).
			meta: { attempts: failures }
		}
	);
}
