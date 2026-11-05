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
 *   2. OpenCode's local database (`opencode.db`, `credential` table), which is
 *      where current OpenCode releases keep the OAuth grant;
 *   3. OpenCode's legacy `auth.json` (`~/.local/share/opencode/auth.json`, or
 *      `$XDG_DATA_HOME/opencode/auth.json`).
 *
 * Older releases wrote `auth.json`; current releases migrated the grant into
 * the database but often leave the old file behind. The database is therefore
 * preferred, and every usable candidate is tried in turn: a stale
 * `auth.json` token must not shadow the live database grant. API-key logins
 * (`oc_sk_…`, method "API key (service account)") are reported as "not a
 * console session" instead of being sent to the billing endpoint, which only
 * answers 403 for them.
 *
 * Reading the local OpenCode store is optional and can be disabled with
 * `opencodeConsoleEnabled: false`. Values never leave the host process; the
 * settings/detection payload reports only the source, org id and whether a
 * credential was found. `node:sqlite` is used opportunistically (Node 22.5+)
 * and a runtime without it simply falls through to the auth file.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isCredentialRefName, uniqueStrings } from "./util.js";

/** Default credential ref for a manually supplied console token. */
export const DEFAULT_OPENCODE_CONSOLE_API_KEY_ENV = "OPENCODE_CONSOLE_TOKEN";
/** Default OpenCode console origin. */
export const DEFAULT_OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai";

/**
 * A balance read failure with a stable code (no token in the message).
 * `status` carries the console HTTP status when there was one.
 */
export class ConsoleError extends Error {
	constructor(code, message, status = null) {
		super(message);
		this.name = "ConsoleError";
		this.code = code;
		this.status = status;
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
 * Normalize an `expires` value (OpenCode stores epoch milliseconds) to ms.
 * Values below 10^10 are treated as seconds, defensively.
 */
function expiryMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return value < 10_000_000_000 ? value * 1000 : value;
}

/**
 * Classify a stored token. Console OAuth access tokens are `st_…`; OpenCode
 * service-account keys (the GO API-key login) are `oc_sk_…`. An explicit
 * `type` wins; unknown shapes are treated as OAuth so a manually pasted
 * console token still works.
 */
function tokenKind(token, type) {
	const normalized = String(type ?? "").toLowerCase();
	if (normalized === "key" || normalized === "api" || normalized === "api-key") return "api-key";
	if (normalized === "oauth") return "oauth";
	if (/^st_/.test(token)) return "oauth";
	// Service-account keys (`oc_sk_…`) authenticate the API, not the console.
	if (/^oc_sk_/.test(token)) return "api-key";
	return "oauth";
}

/** Console metadata carried by an OpenCode credential grant. */
function grantMetadata(entry) {
	return {
		orgId: typeof entry?.metadata?.orgID === "string" ? entry.metadata.orgID : "",
		server: typeof entry?.metadata?.server === "string" ? entry.metadata.server : ""
	};
}

/**
 * Read the console OAuth token from OpenCode's auth.json.
 * Only the `opencode` integration is a console grant; `opencode-go` is the GO
 * API key and returns 403 on the console billing endpoint.
 *
 * Returns a candidate (with `kind`) or null. API-key entries are returned too,
 * so the caller can explain that no console session exists instead of sending
 * the key to an endpoint that only rejects it.
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
	let token = null;
	let type = null;
	if (typeof entry === "string") {
		token = entry.trim();
	} else {
		type = typeof entry.type === "string" ? entry.type : null;
		if (typeof entry.access === "string" && entry.access.trim() !== "") {
			token = entry.access.trim();
		} else if (typeof entry.key === "string" && entry.key.trim() !== "") {
			token = entry.key.trim();
		}
	}
	if (token === null || token === "") return null;
	const metadata = grantMetadata(entry);
	return {
		token,
		kind: tokenKind(token, type),
		orgId: metadata.orgId,
		server: metadata.server,
		expires: expiryMs(entry?.expires),
		source: "opencode-auth-file",
		path
	};
}

/** Process-wide `node:sqlite` probe, resolved once per process. */
let sqliteDatabasePromise = null;

/** Resolve `node:sqlite`'s DatabaseSync, or null when it is unavailable. */
function sqliteDatabase() {
	if (sqliteDatabasePromise === null) {
		sqliteDatabasePromise = import("node:sqlite")
			.then((module) => (typeof module.DatabaseSync === "function" ? module.DatabaseSync : null))
			.catch(() => null);
	}
	return sqliteDatabasePromise;
}

/**
 * The database file OpenCode uses.
 *
 * Explicit configuration wins; then `$OPENCODE_DB`; then the data directory's
 * `opencode.db`, then a channel build (`opencode-beta.db`, `opencode-dev.db`,
 * …). Current channels use the plain name, but a beta install stores a
 * suffixed one and would otherwise look unauthenticated. A relative
 * `$OPENCODE_DB` resolves against the search directory — the auth file's
 * directory when `opencodeConsoleAuthFile` is set, else the data directory.
 *
 * @param {string} [pathValue] - explicit path (`opencodeConsoleDbFile`)
 * @param {string} [fallbackDir] - directory to search when no path is set
 */
export function resolveOpencodeDbFile(pathValue = "", fallbackDir = "") {
	const explicit = expandHome(pathValue);
	if (explicit !== "") return explicit;
	const dir = fallbackDir !== "" ? fallbackDir : opencodeDataDir();
	const fromEnv = typeof process.env.OPENCODE_DB === "string" ? process.env.OPENCODE_DB.trim() : "";
	if (fromEnv !== "" && fromEnv !== ":memory:") return isAbsolute(fromEnv) ? fromEnv : join(dir, fromEnv);
	const preferred = join(dir, "opencode.db");
	try {
		statSync(preferred);
		return preferred;
	} catch {
		// fall through to a channel build
	}
	try {
		const found = readdirSync(dir)
			.filter((name) => /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/.test(name))
			.map((name) => {
				const path = join(dir, name);
				return { path, at: statSync(path).mtimeMs };
			})
			.sort((a, b) => b.at - a.at);
		if (found.length > 0) return found[0].path;
	} catch {
		// no data directory: the read below fails and falls through to auth.json
	}
	return preferred;
}

/**
 * Read every console grant from OpenCode's local SQLite database.
 * Returns [] when node:sqlite is unavailable, the database is absent/locked,
 * or the schema does not contain an `opencode` credential.
 *
 * @returns {Promise<Array<{ token: string, kind: string, orgId: string, server: string, expires: number | null, source: string, path: string }>>}
 */
export async function readOpencodeDbCredentials(pathValue = "") {
	const path = resolveOpencodeDbFile(pathValue);
	const DatabaseSync = await sqliteDatabase();
	if (DatabaseSync === null) return [];
	let db;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		try {
			db.exec("PRAGMA busy_timeout=1500");
		} catch {
			// a busy timeout is best-effort; the query still gets one try
		}
		// `active` and `time_created` were added over time; fall back to the
		// plain table for very old databases. A query that runs is
		// authoritative even when it returns no rows: an empty `active=1`
		// result means logged out, not an old schema — the later queries
		// drop the `active` filter and would resurrect a revoked grant.
		const queries = [
			"SELECT integration_id, value FROM credential WHERE active=1 AND integration_id='opencode' ORDER BY time_created DESC",
			"SELECT integration_id, value FROM credential WHERE integration_id='opencode' ORDER BY time_created DESC",
			"SELECT integration_id, value FROM credential WHERE integration_id='opencode'"
		];
		let rows = null;
		for (const query of queries) {
			try {
				rows = db.prepare(query).all();
				// the schema works; an empty result is the real answer
				break;
			} catch {
				// try the next, older schema
			}
		}
		if (rows === null) return [];
		const credentials = [];
		for (const row of rows) {
			if (row?.integration_id !== "opencode" || typeof row.value !== "string") continue;
			let grant;
			try {
				grant = JSON.parse(row.value);
			} catch {
				continue;
			}
			const type = typeof grant?.type === "string" ? grant.type : null;
			let token = null;
			if (typeof grant?.access === "string" && grant.access.trim() !== "") {
				token = grant.access.trim();
			} else if (typeof grant?.key === "string" && grant.key.trim() !== "") {
				token = grant.key.trim();
			}
			if (token === null) continue;
			const metadata = grantMetadata(grant);
			credentials.push({
				token,
				kind: tokenKind(token, type),
				orgId: metadata.orgId,
				server: metadata.server,
				expires: expiryMs(grant?.expires),
				source: "opencode-db",
				path
			});
		}
		return credentials;
	} catch {
		return [];
	} finally {
		try {
			db?.close();
		} catch {
			// closing an already-closed handle is harmless
		}
	}
}

/** First console grant from OpenCode's database (kept for compatibility). */
export async function readOpencodeDbCredential(pathValue = "") {
	const credentials = await readOpencodeDbCredentials(pathValue);
	return credentials.find((credential) => credential.kind === "oauth") ?? credentials[0] ?? null;
}

/**
 * Every usable console credential for a provider config.
 *
 * The database comes before the legacy auth file on purpose: OpenCode writes
 * rotated grants to the database, and an old auth.json token would otherwise
 * produce a 401 and hide the live balance. Duplicate tokens are collapsed and
 * OAuth sessions are returned separately from API-key logins.
 *
 * @param {{
 *   config: { apiKeyEnv?: string, orgId?: string, authFile?: string, dbFile?: string, baseUrl?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 * }} input
 * @returns {Promise<{
 *   credentials: Array<{ token: string, kind: string, orgId: string, server: string, expires: number | null, source: string, path: string | null }>,
 *   apiKey: { token: string, kind: string, orgId: string, server: string, expires: number | null, source: string, path: string | null } | null,
 * }>}
 */
export async function resolveOpencodeConsoleCredentials(input) {
	const { config, resolveCredential } = input;
	const explicitOrg = typeof config.orgId === "string" ? config.orgId.trim() : "";
	const withOrg = (credential) => ({
		...credential,
		orgId: explicitOrg !== "" ? explicitOrg : credential.orgId
	});

	const candidates = [];
	const refs = uniqueStrings([config.apiKeyEnv, DEFAULT_OPENCODE_CONSOLE_API_KEY_ENV]).filter(isCredentialRefName);
	const credential = await resolveCredential(refs);
	if (credential !== null && typeof credential.value === "string" && credential.value.trim() !== "") {
		const token = credential.value.trim();
		candidates.push(withOrg({
			token,
			kind: tokenKind(token, null),
			orgId: "",
			server: "",
			expires: null,
			source: `credential:${credential.ref}`,
			path: null
		}));
	}

	const authDir = typeof config.authFile === "string" && config.authFile.trim() !== ""
		? dirname(expandHome(config.authFile))
		: "";
	const dbFile = resolveOpencodeDbFile(config.dbFile, authDir);
	for (const stored of await readOpencodeDbCredentials(dbFile)) candidates.push(withOrg(stored));

	const authFile = readOpencodeAuthJson(config.authFile);
	if (authFile !== null) candidates.push(withOrg(authFile));

	const seen = new Set();
	const unique = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.token)) continue;
		seen.add(candidate.token);
		unique.push(candidate);
	}
	const credentials = unique.filter((candidate) => candidate.kind === "oauth");
	const apiKey = unique.find((candidate) => candidate.kind !== "oauth") ?? null;
	return { credentials, apiKey };
}

/**
 * Resolve the preferred console credential for a provider config.
 * @param {{
 *   config: { apiKeyEnv?: string, orgId?: string, authFile?: string, dbFile?: string, baseUrl?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 * }} input
 */
export async function resolveOpencodeConsoleCredential(input) {
	const { credentials } = await resolveOpencodeConsoleCredentials(input);
	return credentials[0] ?? null;
}

/**
 * Non-network detection report for the settings page.
 * @returns {Promise<{ enabled: boolean, configured: boolean, source: string | null, orgId: string | null, error: string | null, reason: string | null, expired: boolean }>}
 */
export async function opencodeConsoleStatus(input) {
	const { config, resolveCredential } = input;
	const enabled = config.enabled !== false;
	if (!enabled) return { enabled: false, configured: false, source: null, orgId: null, error: null, reason: null, expired: false };
	try {
		const resolved = await resolveOpencodeConsoleCredentials({ config, resolveCredential });
		const credential = resolved.credentials[0] ?? null;
		if (credential === null) {
			return {
				enabled: true,
				configured: false,
				source: null,
				orgId: typeof config.orgId === "string" && config.orgId.trim() !== "" ? config.orgId.trim() : null,
				error: null,
				reason: resolved.apiKey === null ? null : "api-key",
				expired: false
			};
		}
		const expired = typeof credential.expires === "number" && credential.expires <= Date.now();
		return {
			enabled: true,
			configured: true,
			source: credential.source,
			orgId: credential.orgId || (typeof config.orgId === "string" && config.orgId.trim() !== "" ? config.orgId.trim() : null),
			error: null,
			reason: expired ? "expired" : null,
			expired
		};
	} catch (error) {
		return {
			enabled: true,
			configured: false,
			source: null,
			orgId: null,
			error: error instanceof Error ? error.message : String(error),
			reason: null,
			expired: false
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
 * The console origin for a credential: an explicit override wins, then the
 * server recorded in the grant (`https://opencode.ai/console` or a
 * self-hosted console), then the public default.
 */
function consoleBaseUrl(config, credential) {
	const configured = typeof config.baseUrl === "string" ? config.baseUrl.trim().replace(/\/+$/, "") : "";
	// The config carries the public default even when the user never touched it,
	// so an explicit non-default override wins while the default still lets a
	// self-hosted `metadata.server` grant pick its own origin.
	if (configured !== "" && configured !== DEFAULT_OPENCODE_CONSOLE_BASE_URL) return configured;
	const server = typeof credential.server === "string" && credential.server.trim() !== ""
		? credential.server.trim()
		: DEFAULT_OPENCODE_CONSOLE_BASE_URL;
	try {
		return new URL(server).origin;
	} catch {
		return DEFAULT_OPENCODE_CONSOLE_BASE_URL;
	}
}

/** Fetch and normalize the billing status for one credential. */
async function fetchOpencodeBalance(config, credential, fetchImpl) {
	const baseUrl = consoleBaseUrl(config, credential);
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
		if (res.status === 401 || res.status === 403) {
			throw new ConsoleError(
				"console-unauthorized",
				`OpenCode balance ${res.status}: the saved OpenCode Console session is expired or not a Console login — run \`opencode auth login\` again (or set OPENCODE_CONSOLE_TOKEN) [source: ${credential.source}]`,
				res.status
			);
		}
		throw new ConsoleError("http-error", `OpenCode balance ${res.status}: ${body.slice(0, 300)}`, res.status);
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

/**
 * Fetch the OpenCode console billing status and normalize the prepaid balance.
 *
 * `balanceMicroCents` and `availableMicroCents` are 1/100,000,000 USD.
 *
 * Every discovered OAuth session is tried (newest storage first); a stale
 * legacy `auth.json` token therefore cannot hide a live database grant. At
 * most four candidates are tried before the first authentication failure is
 * reported. When only an API-key login exists, the error says so instead of
 * forwarding the key to an endpoint that rejects it.
 *
 * @param {{
 *   config: { apiKeyEnv?: string, orgId?: string, authFile?: string, dbFile?: string, baseUrl?: string },
 *   resolveCredential: (refs: string[]) => Promise<{ ref: string, value: string } | null>,
 *   fetchImpl?: typeof fetch,
 * }} input
 */
export async function readOpencodeBalance(input) {
	const { config, resolveCredential, fetchImpl = fetch } = input;
	const { credentials, apiKey } = await resolveOpencodeConsoleCredentials({ config, resolveCredential });
	if (credentials.length === 0) {
		if (apiKey !== null) {
			throw new ConsoleError(
				"console-api-key",
				"OpenCode balance: the local OpenCode login is an API key, not an OpenCode Console session — run `opencode auth login` and choose the OpenCode Console account (or set OPENCODE_CONSOLE_TOKEN)"
			);
		}
		throw new ConsoleError(
			"no-console-credential",
			"OpenCode balance: no console credential (set OPENCODE_CONSOLE_TOKEN, or sign in with OpenCode)"
		);
	}
	const failures = [];
	for (const credential of credentials.slice(0, 4)) {
		try {
			return await fetchOpencodeBalance(config, credential, fetchImpl);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			failures.push(failure);
			const status = failure instanceof ConsoleError ? failure.status : null;
			// Only an authentication failure is worth retrying on the next
			// candidate. A network or schema failure is shared by all sources
			// (and a retry would only multiply the wait).
			if (status !== 401 && status !== 403) break;
		}
	}
	const unauthorized = failures.find((failure) => failure instanceof ConsoleError && (failure.status === 401 || failure.status === 403));
	throw unauthorized ?? failures[0];
}
