// @ts-check
/**
 * dsh-multi-provider-usage — runtime `x-opencode-session` injection (host half).
 *
 * The OpenCode GO gateway rejects chat-completion requests without the
 * `x-opencode-session` header (HTTP 400 `{"type":"MissingSessionID"}`), and
 * DSH's `llm-pi-ai` adapter never sends it. Instead of patching DSH's installed
 * files (wiped by every upgrade), this module injects the header at runtime:
 *
 *   1. `patchFetch()` wraps `globalThis.fetch` once. A request receives the
 *      header only when the AsyncLocalStorage context carries a session AND the
 *      request URL starts with that call's gateway base.
 *   2. `withSession()` runs a stream inside that context. Standing on DSH's
 *      official `llm/stream` waterfall event, the host captures the per-call
 *      `options.sessionId` and resolves the wire base from
 *      `llm-pi-ai.providers.<route>.baseURL`, falling back to this plugin's
 *      configured OpenCode GO base.
 *
 * The header value is the real per-conversation harness session id — never a
 * fixed fake — and only requests to the configured gateway base of the call
 * being streamed ever receive it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Marks `globalThis.fetch` as already wrapped by this module (HMR-safe). */
const FETCH_WRAPPED = Symbol.for("dsh-multi-provider-usage:fetch-wrapped");

/**
 * Process-global session state: the AsyncLocalStorage bridging an LLM call to
 * its wire fetch, plus the observability counters.
 *
 * It lives on `globalThis` rather than in module scope on purpose. The wrapper
 * and the module generation that installed it can diverge: DSH's HMR clears the
 * ESM cache and re-imports the plugin, producing a NEW module instance whose
 * `patchFetch()` no-ops (the process-wide marker is already set) while its
 * `withSession()` would write a store the surviving wrapper never reads. One
 * shared object keeps every generation — and the wrapper — on the same store,
 * so `x-opencode-session` injection survives a live reload.
 */
const SESSION_STATE = Symbol.for("dsh-multi-provider-usage:session-state");
const state = (() => {
	const shared = globalThis[SESSION_STATE];
	if (shared !== undefined && shared !== null && typeof shared === "object" && shared.store !== undefined) return shared;
	const created = {
		store: new AsyncLocalStorage(),
		/** How many OpenCode gateway requests actually received the session header. */
		count: 0,
		diag: {
			streamSeen: 0,
			/** @type {{ at: number, provider: string | null, hasSessionId: boolean, base: string | null, baseFrom: "settings" | "config" | null } | null} */
			lastStream: null,
			requests: 0,
			injected: 0,
			missed: 0
		}
	};
	globalThis[SESSION_STATE] = created;
	return created;
})();

/**
 * Per-process AsyncLocalStorage bridging the LLM call to the wire fetch.
 * Store shape: `{ sessionId: string, base: string }`.
 */
const sessionStore = state.store;

/**
 * Runtime observability: the waterfall handler records every `llm/stream` it
 * sees, and the fetch wrapper counts wire calls that carried the context
 * (`requests`), got the header (`injected`), or fell through because the URL
 * did not match that call's base (`missed`).
 */
const diag = state.diag;

/** @returns {number} count of requests that got `x-opencode-session`. */
export function sessionHeaderCount() {
	return state.count;
}

/** Record one `llm/stream` observation. */
export function recordStream(info) {
	diag.streamSeen += 1;
	diag.lastStream = { at: Date.now(), ...info };
}

/** Snapshot of the runtime diagnostics (safe for JSON responses). */
export function sessionDiag() {
	return { ...diag, lastStream: diag.lastStream === null ? null : { ...diag.lastStream } };
}

/**
 * Wrap `globalThis.fetch` once. Requests whose URL starts with the gateway
 * base carried in the ALS context get `x-opencode-session` added. Idempotent.
 */
export function patchFetch() {
	if (globalThis[FETCH_WRAPPED]) return;
	const nativeFetch = globalThis.fetch;
	globalThis[FETCH_WRAPPED] = true;
	globalThis.fetch = function sessionFetch(input, init) {
		const meta = sessionStore.getStore();
		if (meta?.sessionId !== undefined) {
			if (matchesBase(input, meta.base)) {
				// When the caller passed a Request, its own headers are the base:
				// per the fetch spec an `init.headers` would otherwise replace them
				// wholesale and drop e.g. Authorization.
				const base = init?.headers ?? (input !== null && typeof input === "object" && input.headers !== null && typeof input.headers === "object" ? input.headers : undefined);
				const headers = new Headers(base);
				if (!headers.has("x-opencode-session")) {
					headers.set("x-opencode-session", String(meta.sessionId));
					state.count += 1;
				}
				init = { ...init, headers };
				diag.injected += 1;
			} else {
				diag.missed += 1;
			}
			diag.requests += 1;
		}
		return nativeFetch.call(this, input, init);
	};
}

/**
 * True when the request URL targets the given gateway base (trailing slashes
 * ignored; the base itself or `base/...` both match).
 */
function matchesBase(input, base) {
	const url = typeof input === "string"
		? input
		: input instanceof URL
			? input.href
			: typeof input?.url === "string" ? input.url : String(input);
	const normalized = String(base ?? "").replace(/\/+$/, "");
	return normalized.length > 0 && (url === normalized || url.startsWith(normalized + "/"));
}

/**
 * Run a stream's iteration inside the given session context, so async work
 * created while the adapter pulls chunks resolves the context from the ALS
 * store. Implements the async-iterator protocol.
 * @template T
 * @param {AsyncIterable<T>} stream
 * @param {{ sessionId: string, base: string }} meta
 * @returns {AsyncIterable<T>}
 */
export function withSession(stream, meta) {
	const iterator = stream[Symbol.asyncIterator]();
	const run = (method, args) => {
		const fn = iterator[method];
		if (typeof fn !== "function") {
			return Promise.resolve(method === "throw" ? { done: true } : void 0);
		}
		return sessionStore.run(meta, () => Promise.resolve(fn.call(iterator, ...args)));
	};
	return {
		[Symbol.asyncIterator]() { return this; },
		next: (...args) => run("next", args),
		return: (...args) => run("return", args),
		throw: (...args) => run("throw", args)
	};
}
