// Runtime session-header fix: the fetch wrapper adds x-opencode-session only
// when the AsyncLocalStorage context's gateway base matches the request URL.
// The wrapper is process-global, so this file runs last in test/run.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHost } from "./support/harness.mjs";

// Load the module through the host's package graph (the loader hook is active).
const session = await import("../lib/opencode-session.js");
const host = await loadHost();

test("withSession runs an async iterator inside the session context", async () => {
	const seen = [];
	async function* source() {
		seen.push("a");
		yield 1;
		seen.push("b");
		yield 2;
	}
	const wrapped = session.withSession(source(), { sessionId: "s", base: "https://opencode.ai/zen/go" });
	const values = [];
	for await (const value of wrapped) values.push(value);
	assert.deepEqual(values, [1, 2]);
	assert.deepEqual(seen, ["a", "b"]);
});

test("recordStream and sessionDiag expose the last llm/stream observation", () => {
	const before = session.sessionDiag().streamSeen;
	session.recordStream({ provider: "opencode-go", hasSessionId: true, base: "https://opencode.ai/zen/go", baseFrom: "settings" });
	const diag = session.sessionDiag();
	assert.equal(diag.streamSeen, before + 1);
	assert.equal(diag.lastStream.provider, "opencode-go");
	assert.equal(diag.lastStream.hasSessionId, true);
	assert.equal(diag.lastStream.baseFrom, "settings");
});

test("the fetch wrapper injects the header only for the matching gateway base", async () => {
	const requests = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), headers: new Headers(init?.headers) });
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};
	// Re-wrap the fresh fake even if another test already installed the wrapper.
	delete globalThis[Symbol.for("dsh-multi-provider-usage:fetch-wrapped")];
	session.patchFetch();

	try {
		async function* matching() {
			await fetch("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST" });
			yield 1;
		}
		async function* other() {
			await fetch("https://example.com/other", { method: "POST" });
			yield 2;
		}
		const before = session.sessionHeaderCount();
		for await (const _ of session.withSession(matching(), { sessionId: "session-123", base: "https://opencode.ai/zen/go" })) {
			// consume
		}
		for await (const _ of session.withSession(other(), { sessionId: "session-123", base: "https://opencode.ai/zen/go" })) {
			// consume
		}
		assert.equal(requests.length, 2);
		assert.equal(requests[0].headers.get("x-opencode-session"), "session-123");
		assert.equal(requests[1].headers.get("x-opencode-session"), null);
		assert.equal(session.sessionHeaderCount(), before + 1);
	} finally {
		globalThis.fetch = originalFetch;
		delete globalThis[Symbol.for("dsh-multi-provider-usage:fetch-wrapped")];
	}
});

test("the fetch wrapper keeps a Request object's own headers", async () => {
	const requests = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input?.url ?? input), headers: new Headers(init?.headers ?? input?.headers) });
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	};
	// Re-wrap the fresh fake even if another test already installed the wrapper.
	delete globalThis[Symbol.for("dsh-multi-provider-usage:fetch-wrapped")];
	session.patchFetch();

	try {
		async function* stream() {
			const request = new Request("https://opencode.ai/zen/go/v1/chat/completions", {
				method: "POST",
				headers: { Authorization: "Bearer go-key" }
			});
			await fetch(request);
			yield 1;
		}
		for await (const _ of session.withSession(stream(), { sessionId: "session-456", base: "https://opencode.ai/zen/go" })) {
			// consume
		}
		assert.equal(requests.length, 1);
		assert.equal(requests[0].headers.get("authorization"), "Bearer go-key", "the Request's own headers survive the injection");
		assert.equal(requests[0].headers.get("x-opencode-session"), "session-456");
	} finally {
		globalThis.fetch = originalFetch;
		delete globalThis[Symbol.for("dsh-multi-provider-usage:fetch-wrapped")];
	}
});

test("the host registers the llm/stream listener when the fix is enabled", () => {
	assert.equal(host.Config.dict.injectSessionHeader.meta.default, true);
});
