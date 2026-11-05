// @ts-check
/**
 * dsh-multi-provider-usage — OpenCode console balance helper.
 *
 * OpenCode GO quota and OpenCode Zen's prepaid balance are served by two
 * different APIs:
 *
 *   - `GET {gateway}/v1/usage`          — GO plan windows (already used above);
 *   - `GET https://opencode.ai/console/api/billing/status` — the account's
 *     prepaid / top-up balance (`balanceMicroCents` / `availableMicroCents`).
 *
 * The console endpoint needs the OpenCode **console** OAuth token, not the GO
 * API key. This module resolves that token, in priority order:
 *
 *   1. a DSH credential ref (`opencodeConsoleApiKeyEnv`);
 *   2. OpenCode's `auth.json` (`~/.local/share/opencode/auth.json`, or
 *      `$XDG_DATA_HOME/opencode/auth.json`);
 *   3. OpenCode's local database (`opencode.db`, `credential` table), which is
 *      where current OpenCode releases keep the OAuth grant.
 *
 * Reading the local OpenCode store is optional and can be disabled with
 * `opencodeConsoleEnabled: false`. Values never leave the host process; the
 * settings/detection payload reports only the source, org id and whether a
 * credential was found. `node:sqlite` is used opportunistically (Node 22.5+)
 * and a runtime without it simply falls through to the auth file.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Default credential ref for a manually supplied console token. */
export const DEFAULT_OPENCODE_CONSOLE_API_KEY_ENV = "OPENCODE_CONSOLE_TOKEN";
/** Default OpenCode console origin. */
export const DEFAULT_OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai";

/** A balance read failure with a stable code (no token in the message). */
export class ConsoleError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ConsoleError";
		this.code = code;
	}
}

/** The OpenCode data directory, honouring XDG_DATA_HOME. */
export function opencodeDataDir(env = process.env) {
	const xdg = typeof env.XDG_DATA_HOME === "string" ? env.XDG_DATA_HOME.trim() : "";
	return xdg.length > 0 ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
}

/** Default OpenCode `auth.json` location. */
export function defaultOpencodeAuthFile(env = process.env) {
	return join(opencodeDataDir(env), "auth.json");
}

/** Default OpenCode `opencode.db` location. */
export function defaultOpencodeDbFile(env = process.env) {
	return join(opencodeDataDir(env), "opencode.db");
}

/** Expand `~` in a user-supplied path. */
function expandHome(pathValue) {
	const raw = String(pathValue ?? "").trim();
	if (raw === "") return "";
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
	return raw;
}

/**
 * Read the console OAuth token from OpenCode's auth.json.
 * Only the `opencode` provider is a console grant; `opencode-go` is the GO API
 * key and returns 403 on the console billing endpoint.
 */
export function readOpencodeAuthJson(pathValue = "") {
	const path = expandHome(pathValue) || defaultOpencodeAuthFile();
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	const entry = parsed?.opencode;
	if (entry === null || entry === undefined) return null;
	const token = typeof entry === "string"
		? entry
		: typeof entry.access === "string" && entry.access.length > 0
			? entry.access
			: typeof entry.key === "string" && entry.key.length > 0 ? entry.key : null;
	if (token === null) return null;
	return {
		token,
		orgId: typeof entry?.metadata?.orgID === "string" ? entry.metadata.orgID : "",
		expires: typeof entry?.expires === "number" ? entry.expires : null,
		source: "opencode-auth-file",
		path
	};
}

/**
 * Read the console OAuth token from OpenCode's local SQLite database.
 * Returns null when node:sqlite is unavailable, the database is absent/locked,
 * or the schema does not contain an active `opencode` credential.
 */
export async function readOpencodeDbCredential(pathValue = "") {
	const path = expandHome(pathValue) || defaultOpencodeDbFile();
	let DatabaseSync;
	try {
		({ DatabaseSync } = await import("node:sqlite"));
	} catch {
		return null;
	}
	if (typeof DatabaseSync !== "function") return null;
	let db;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		try {
			db.exec("PRAGMA busy_timeout=1500");
		} catch {
			// a busy timeout is best-effort; the query still gets one try
		}
		const rows = db.prepare(
			"SELECT integration_id, value FROM credential WHERE active=1 AND integration_id IN ('opencode','opencode-go')"
		).all();
		for (const row of rows) {
			if (row?.integration_id !== "opencode" || typeof row.value !== "string") continue;
			let grant;
			try {
				grant = JSON.parse(row.value);
			} catch {
				continue;
			}
			const token = typeof grant?.access === "string" && grant.access.length > 0
				? grant.access
				: typeof grant?.key === "string" && grant.key.length > 0 ? grant.key : null;
			if (token === null) continue;
			return {
				token,
				orgId: typeof grant?.metadata?.orgID === "string" ? grant.metadata.orgID : "",
				expires: typeof grant?.expires === "number" ? grant.expires : null,
				source: "opencode-db",
				path
			};
		}
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			// closing an already-closed handle is harmless
		}
	}
	return null;
}

/**
 * Resolve the console credential for a provider config.
 *
 * `apiKeyEnv` is tried first through DSH credentials; then the OpenCode auth
 * file and database. `orgId` from config overrides the metadata value.
 * @param {{
 *   config: { apiKeyEnv?: string, orgId?: string, authFile?: string, dbFile?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 * }} input
 */
export async function resolveOpencodeConsoleCredential(input) {
	const { config, resolveCredential } = input;
	const refs = [config.apiKeyEnv, DEFAULT_OPENCODE_CONSOLE_API_KEY_ENV]
		.filter((ref) => typeof ref === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref));
	const credential = await resolveCredential(unique(refs));
	if (credential !== null) {
		return {
			token: credential.value,
			orgId: typeof config.orgId === "string" ? config.orgId.trim() : "",
			source: `credential:${credential.ref}`,
			expires: null,
			path: null
		};
	}
	const authFile = readOpencodeAuthJson(config.authFile);
	if (authFile !== null) {
		return {
			...authFile,
			orgId: typeof config.orgId === "string" && config.orgId.trim().length > 0 ? config.orgId.trim() : authFile.orgId
		};
	}
	const dbFile = resolveDbPath(config);
	const db = await readOpencodeDbCredential(dbFile);
	if (db !== null) {
		return {
			...db,
			orgId: typeof config.orgId === "string" && config.orgId.trim().length > 0 ? config.orgId.trim() : db.orgId
		};
	}
	return null;
}

/** Derive the database path, preferring one next to an explicit auth file. */
function resolveDbPath(config) {
	const explicit = expandHome(config.dbFile);
	if (explicit.length > 0) return explicit;
	const authFile = expandHome(config.authFile);
	if (authFile.length > 0) return join(dirname(authFile), "opencode.db");
	return defaultOpencodeDbFile();
}

/**
 * Non-network detection report for the settings page.
 * @returns {Promise<{ enabled: boolean, configured: boolean, source: string | null, orgId: string | null, error: string | null }>}
 */
export async function opencodeConsoleStatus(input) {
	const { config, resolveCredential } = input;
	const enabled = config.enabled !== false;
	if (!enabled) return { enabled: false, configured: false, source: null, orgId: null, error: null };
	try {
		const credential = await resolveOpencodeConsoleCredential({ config, resolveCredential });
		return {
			enabled: true,
			configured: credential !== null,
			source: credential?.source ?? null,
			orgId: credential?.orgId ?? (typeof config.orgId === "string" && config.orgId.trim().length > 0 ? config.orgId.trim() : null),
			error: null
		};
	} catch (error) {
		return {
			enabled: true,
			configured: false,
			source: null,
			orgId: null,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

/** Pick the first finite number from `values` (numeric strings accepted). */
function finite(values) {
	for (const value of values) {
		const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
		if (Number.isFinite(number)) return number;
	}
	return null;
}

/**
 * Fetch the OpenCode console billing status and normalize the prepaid balance.
 *
 * `balanceMicroCents` and `availableMicroCents` are 1/100,000,000 USD.
 * @param {{
 *   config: { apiKeyEnv?: string, orgId?: string, authFile?: string, dbFile?: string, baseUrl?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
export async function readOpencodeBalance(input) {
	const { config, resolveCredential, fetchImpl = fetch } = input;
	const credential = await resolveOpencodeConsoleCredential({ config, resolveCredential });
	if (credential === null) {
		throw new ConsoleError(
			"no-console-credential",
			"OpenCode balance: no console credential (set OPENCODE_CONSOLE_TOKEN, or sign in with OpenCode)"
		);
	}
	const baseUrl = String(config.baseUrl || DEFAULT_OPENCODE_CONSOLE_BASE_URL).replace(/\/+$/, "");
	const headers = {
		Accept: "application/json",
		Authorization: `Bearer ${credential.token}`
	};
	if (typeof credential.orgId === "string" && credential.orgId.length > 0) {
		headers["x-org-id"] = credential.orgId;
	}
	let res;
	try {
		res = await fetchImpl(`${baseUrl}/console/api/billing/status`, {
			headers,
			signal: AbortSignal.timeout(8_000)
		});
	} catch (error) {
		throw new ConsoleError("network-error", `OpenCode balance: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new ConsoleError("http-error", `OpenCode balance ${res.status}: ${body.slice(0, 300)}`);
	}
	let payload;
	try {
		payload = await res.json();
	} catch {
		throw new ConsoleError("invalid-response", "OpenCode balance: response is not JSON");
	}
	const microCents = finite([payload?.availableMicroCents, payload?.balanceMicroCents]);
	const cents = finite([payload?.availableCents, payload?.balanceCents]);
	const direct = finite([payload?.balance, payload?.available]);
	const amount = microCents !== null ? microCents / 100_000_000 : cents !== null ? cents / 100 : direct;
	if (amount === null) {
		throw new ConsoleError("invalid-response", "OpenCode balance: response has no numeric balance");
	}
	return {
		amount,
		currency: typeof payload?.currency === "string" && payload.currency.length > 0 ? payload.currency : "USD",
		labelKey: "balance.zen",
		source: credential.source,
		details: {
			billingMode: typeof payload?.billingMode === "string" ? payload.billingMode : null,
			mode: typeof payload?.mode === "string" ? payload.mode : null,
			canPurchaseCredits: payload?.canPurchaseCredits === true,
			canEnableAutoRecharge: payload?.canEnableAutoRecharge === true,
			microCents: microCents
		}
	};
}

/** Deduplicate a list of strings. */
function unique(values) {
	const out = [];
	for (const value of values) if (!out.includes(value)) out.push(value);
	return out;
}
