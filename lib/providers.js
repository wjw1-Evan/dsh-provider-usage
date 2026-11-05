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
	rolling: { labelKey: "window.rolling", hintKey: "window.rolling.hint", windowMs: 5 * 3600e3 },
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

/** Finite number or null. */
export function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
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
	const def = WINDOW_DEFS[canonical] ?? WINDOW_DEFS.other;
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
		...(typeof options.note === "string" && options.note.length > 0 ? { note: options.note } : {})
	};
}

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
		throw new ProviderError("http-error", `${label} ${res.status}: ${body.slice(0, 300)}`);
	}
	try {
		return await res.json();
	} catch {
		throw new ProviderError("invalid-response", `${label}: response is not JSON`);
	}
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

/** Start the optional OpenCode console balance read (never rejects). */
function startOpencodeBalance(consoleConfig, resolveCredential, fetchImpl) {
	if (consoleConfig === null || consoleConfig === undefined || consoleConfig.enabled !== true) {
		return Promise.resolve(null);
	}
	return readOpencodeBalance({ config: consoleConfig, resolveCredential, fetchImpl })
		.then((balance) => ({ ok: true, balance }))
		.catch((error) => ({ ok: false, error }));
}

/** Project a settled balance read into public result fields. */
function balanceFields(settled) {
	if (settled === null) return { balance: null, balanceError: null };
	if (settled.ok) return { balance: settled.balance, balanceError: null };
	return {
		balance: null,
		balanceError: settled.error instanceof Error ? settled.error.message : String(settled.error)
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
			...(fields.balanceError === null ? {} : { balanceError: fields.balanceError })
		}
	};
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
				raw = await service.read();
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
		const balance = balanceFields(await balancePromise);
		throw new ProviderError(
			"no-credential",
			`OpenCode GO: no API key (set one of ${refs.join(", ")})${reason ?? ""}`,
			{
				account: { ref: config.apiKeyEnv ?? DEFAULT_OPENCODE_API_KEY_ENV, id: null, name: "" },
				fallback,
				balance: balance.balance,
				meta: { opencodeGo: probe, ...(balance.balanceError === null ? {} : { balanceError: balance.balanceError }) }
			}
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
		const reason = fallback === null ? "" : ` — dsh-opencode-go: ${fallback.reason}: ${fallback.message}`;
		const balance = balanceFields(await balancePromise);
		throw new ProviderError(
			error instanceof ProviderError ? error.code : "read-failed",
			`${error instanceof Error ? error.message : String(error)}${reason}`,
			{
				account: { ref: credential.ref, id: null, name: "" },
				fallback,
				balance: balance.balance,
				meta: { opencodeGo: probe, ...(balance.balanceError === null ? {} : { balanceError: balance.balanceError }) }
			}
		);
	}

	let windows;
	try {
		windows = normalizeOpencodeUsage(payload);
	} catch (error) {
		const balance = balanceFields(await balancePromise);
		throw new ProviderError("invalid-response", error instanceof Error ? error.message : String(error), {
			account: { ref: credential.ref, id: null, name: "" },
			fallback,
			balance: balance.balance,
			meta: { opencodeGo: probe, ...(balance.balanceError === null ? {} : { balanceError: balance.balanceError }) }
		});
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
	/** @param {string} path */
	const get = async (path) => {
		try {
			return { data: await fetchJson(fetchImpl, baseUrl + path, { headers }, `Command Code ${path.split("?")[0]}`), error: null };
		} catch (error) {
			return { data: null, error: error instanceof Error ? error.message : String(error) };
		}
	};

	const [whoamiResult, subscriptionResult, creditsResult] = await Promise.all([
		get("/alpha/whoami?limits=1"),
		get("/alpha/billing/subscriptions"),
		get("/alpha/billing/credits")
	]);
	const subscription = subscriptionResult.data?.data ?? null;
	const periodStart = typeof subscription?.currentPeriodStart === "string" ? subscription.currentPeriodStart : null;
	const summaryResult = await get(`/alpha/usage/summary${periodStart === null ? "" : `?since=${encodeURIComponent(periodStart)}`}`);
	const summary = summaryResult.data ?? null;
	const credits = creditsResult.data?.credits ?? null;
	const windowLimits = creditsResult.data?.windowLimits ?? null;

	const errors = [whoamiResult.error, subscriptionResult.error, creditsResult.error, summaryResult.error].filter(Boolean);
	if (whoamiResult.data === null && creditsResult.data === null && subscriptionResult.data === null && summaryResult.data === null) {
		throw new ProviderError("read-failed", `Command Code: ${errors.join("; ") || "all billing endpoints failed"}`);
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
		periodEnd: typeof subscription?.currentPeriodEnd === "string" ? subscription.currentPeriodEnd : null,
		totalCredits: planInfo.totalCredits
	};

	const windows = [];

	// Monthly credits: `used` is the billing-period spend and `remaining` is
	// the plan's recurring monthly credit balance. Purchased and free credits
	// are extra top-ups, reported separately (the official CLI's usage screen
	// calls them "Extra Credits"); they are not part of the monthly plan bar.
	const used = finiteNumber(summary?.totalCost);
	const monthlyRemaining = finiteNumber(credits?.monthlyCredits);
	const purchasedRemaining = finiteNumber(credits?.purchasedCredits);
	const freeRemaining = finiteNumber(credits?.freeCredits);
	let monthlyCap = null;
	let monthlyPercent = null;
	if (used !== null && monthlyRemaining !== null) {
		monthlyCap = used + monthlyRemaining;
		monthlyPercent = monthlyCap > 0 ? (used / monthlyCap) * 100 : 0;
	} else if (planInfo !== null && monthlyRemaining !== null && planInfo.totalCredits !== null) {
		monthlyCap = planInfo.totalCredits;
		monthlyPercent = monthlyCap > 0 ? ((monthlyCap - Math.max(0, monthlyRemaining)) / monthlyCap) * 100 : 0;
	}
	if (monthlyPercent !== null) {
		const start = periodStart === null ? null : Date.parse(periodStart);
		const end = typeof subscription?.currentPeriodEnd === "string" ? Date.parse(subscription.currentPeriodEnd) : null;
		windows.push(makeWindow("monthly", monthlyPercent, {
			status: monthlyPercent >= 100 ? "exceeded" : "ok",
			resetsAt: subscription?.currentPeriodEnd,
			windowMs: Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null
		}));
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
		throw new ProviderError("invalid-response", "Command Code: billing responses contained no usable quota windows", {
			account,
			plan,
			balance
		});
	}

	// Useful diagnostics for the settings page and the chat command.
	const totalDays = subscription?.currentPeriodStart && subscription?.currentPeriodEnd
		? (Date.parse(subscription.currentPeriodEnd) - Date.parse(subscription.currentPeriodStart)) / 86400e3
		: null;
	const elapsedDays = subscription?.currentPeriodStart
		? (Date.now() - Date.parse(subscription.currentPeriodStart)) / 86400e3
		: null;
	const dailyRate = used !== null && elapsedDays !== null && elapsedDays > 0 ? used / elapsedDays : null;
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
			errors,
			monthly: {
				used,
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
		const percent = finiteNumber(raw.percentage);
		if (percent === null) continue;
		const type = typeof raw.type === "string" ? raw.type : "UNKNOWN";
		let key;
		let labelKey;
		let hintKey = null;
		let note;
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
			note
		}));
	}
	if (windows.length === 0) {
		throw new ProviderError("invalid-response", "GLM Code Plan: limits contained no percentage values");
	}
	const order = { "five-hour": 0, weekly: 1, mcp: 2, token: 3, other: 4 };
	windows.sort((a, b) => (order[/** @type {keyof typeof order} */ (a.key)] ?? 9) - (order[/** @type {keyof typeof order} */ (b.key)] ?? 9));
	return windows;
}

/**
 * Read GLM Code Plan quota.
 *
 * The API uses a raw `Authorization: <token>` header (no Bearer prefix) and
 * answers HTTP 200 with `{ success: false, msg }` for account-level failures.
 * In `auto` region mode both the international (`api.z.ai`) and China
 * (`open.bigmodel.cn`) hosts are probed.
 *
 * @param {{
 *   config: { apiKeyEnv?: string, baseUrl?: string, region?: string },
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
	let lastError = null;
	for (const base of bases) {
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
			continue;
		}
		if (payload?.success === false) {
			const message = typeof payload.msg === "string" && payload.msg.length > 0
				? payload.msg
				: typeof payload.message === "string" && payload.message.length > 0 ? payload.message : "request unsuccessful";
			lastError = new ProviderError("api-error", `GLM Code Plan (${base}): ${message}`);
			continue;
		}
		let windows;
		try {
			windows = normalizeGlmUsage(payload);
		} catch (error) {
			lastError = error;
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
			meta: { region: base }
		};
	}

	const message = lastError instanceof Error ? lastError.message : String(lastError ?? "no endpoint answered");
	throw new ProviderError(lastError instanceof ProviderError ? lastError.code : "read-failed", message, {
		account: { ref: credential.ref, id: null, name: "" }
	});
}

// ── shared utilities ───────────────────────────────────────────────────────

/** Deduplicate strings, dropping blanks. */
export function uniqueStrings(values) {
	const out = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length === 0 || out.includes(trimmed)) continue;
		out.push(trimmed);
	}
	return out;
}

/** Whether a string is a valid DSH credential reference. */
export function isCredentialRefName(value) {
	return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
