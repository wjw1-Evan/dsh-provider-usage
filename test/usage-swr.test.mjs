// Stale-while-revalidate and negotiated caching (ETag/304) on the usage route.
// A gated dsh-opencode-go service stub plays the controllably slow upstream,
// so the tests can prove which requests wait for it and which do not.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	boot,
	callRoute,
	goEntry,
	loadHost,
	usagePayload,
	usageService
} from "./support/harness.mjs";

const host = await loadHost();

const CREDS = {
	OPENCODE_GO_API_KEY: "sk-go",
	COMMANDCODE_API_KEY: "sk-cc",
	ZAI_API_KEY: "sk-glm"
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Boot with every provider enabled and the OpenCode GO read behind a gate. */
async function bootGated() {
	const gates = [];
	const service = usageService(() => new Promise((resolve) => { gates.push(resolve); }));
	const entry = goEntry();
	const { routes } = await (await import("./support/harness.mjs")).boot({
		entries: [entry],
		services: { opencodeGoUsage: service },
		credentialMap: CREDS,
		config: { cacheMs: 40, opencodeGoSource: "opencode-go" }
	});
	return { gates, entry, routes, service };
}

test("an expired cache answers instantly with stale data, then refreshes in the background", async () => {
	const { gates, routes } = await bootGated();

	// Cold read: the first poll blocks until the upstream answers.
	const p1 = callRoute(routes, "/provider-usage/usage");
	await sleep(10);
	assert.equal(gates.length, 1);
	gates[0](usagePayload({ monthly: { status: "ok", percent: 10, resetsAt: null } }));
	const r1 = await p1;
	assert.equal(r1.status, 200);
	assert.equal(r1.body.servedStale, false);
	assert.equal(r1.body.providers.find((p) => p.id === "opencode-go").windows.find((w) => w.key === "monthly").percent, 10);

	// Expire the cache, then poll again: the request must answer at once with
	// the stale value while the background refresh waits on the upstream.
	await sleep(60);
	const p2 = callRoute(routes, "/provider-usage/usage");
	const r2 = await Promise.race([p2, sleep(1000).then(() => null)]);
	assert.notEqual(r2, null, "the expired-cache poll must not wait for the upstream");
	assert.equal(r2.body.servedStale, true);
	assert.equal(r2.body.providers.find((p) => p.id === "opencode-go").servedStale, true);
	assert.equal(r2.body.providers.find((p) => p.id === "opencode-go").windows.find((w) => w.key === "monthly").percent, 10, "stale data is the last-known value");
	await sleep(10);
	assert.equal(gates.length, 2, "the background refresh must have started");

	// The background refresh lands and the next poll is fresh again.
	gates[1](usagePayload({ monthly: { status: "ok", percent: 42, resetsAt: null } }));
	await sleep(10);
	const r3 = await callRoute(routes, "/provider-usage/usage");
	assert.equal(r3.body.servedStale, false);
	assert.equal(r3.body.providers.find((p) => p.id === "opencode-go").windows.find((w) => w.key === "monthly").percent, 42);
});

test("refresh=1 still blocks on a fresh read (no stale serving)", async () => {
	const { gates, routes } = await bootGated();

	const p1 = callRoute(routes, "/provider-usage/usage");
	await sleep(10);
	gates[0](usagePayload({ monthly: { status: "ok", percent: 10, resetsAt: null } }));
	const r1 = await p1;
	assert.equal(r1.status, 200);
	assert.equal(r1.body.servedStale, false);

	await sleep(60);
	let forceResolved = false;
	const p2 = callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	p2.then(() => { forceResolved = true; });
	await sleep(30);
	assert.equal(forceResolved, false, "force must wait for the fresh upstream read");
	assert.equal(gates.length, 2);
	gates[1](usagePayload({ monthly: { status: "ok", percent: 42, resetsAt: null } }));
	const r2 = await p2;
	assert.equal(r2.body.servedStale, false);
	assert.equal(r2.body.providers.find((p) => p.id === "opencode-go").windows.find((w) => w.key === "monthly").percent, 42);
});

test("an account switch never serves stale data", async () => {
	const { gates, entry, routes } = await bootGated();

	const p1 = callRoute(routes, "/provider-usage/usage");
	await sleep(10);
	gates[0](usagePayload({ monthly: { status: "ok", percent: 10, resetsAt: null } }));
	const r1 = await p1;
	assert.equal(r1.body.servedStale, false);

	// Expire the cache, then switch the active account: the cache key
	// changes, so the request must block on a fresh read of the new account
	// instead of answering with the previous account's data.
	await sleep(60);
	entry.fiber.config.apiKeyEnv = "SECOND_KEY";
	let switchedResolved = false;
	const p2 = callRoute(routes, "/provider-usage/usage");
	p2.then(() => { switchedResolved = true; });
	await sleep(30);
	assert.equal(switchedResolved, false, "an account switch must block on a fresh read");
	assert.equal(gates.length, 2);
	gates[1](usagePayload({ monthly: { status: "ok", percent: 7, resetsAt: null } }));
	const r2 = await p2;
	// The other two providers aged past cacheMs during the wait and are
	// legitimately stale-served; the switched account must not be.
	const go = r2.body.providers.find((p) => p.id === "opencode-go");
	assert.notEqual(go.servedStale, true);
	assert.equal(go.windows.find((w) => w.key === "monthly").percent, 7);
});

test("usage responses negotiate with If-None-Match (304) and revalidate correctly", async () => {
	const { routes } = await (await import("./support/harness.mjs")).boot({
		credentialMap: CREDS,
		config: { cacheMs: 60_000 }
	});

	const r1 = await callRoute(routes, "/provider-usage/usage");
	assert.equal(r1.status, 200);
	const etag = r1.headers.etag;
	assert.equal(typeof etag, "string");
	assert.match(etag, /^"[0-9a-f]{40}"$/);

	// Same document: 304 with no body, for exact and W/-prefixed tags.
	const r2 = await callRoute(routes, "/provider-usage/usage", {
		headers: { "if-none-match": etag }
	});
	assert.equal(r2.status, 304);
	assert.equal(r2.text, "");
	const r3 = await callRoute(routes, "/provider-usage/usage", {
		headers: { "if-none-match": `W/${etag}` }
	});
	assert.equal(r3.status, 304);

	// A different tag revalidates to the full document.
	const r4 = await callRoute(routes, "/provider-usage/usage", {
		headers: { "if-none-match": `"stale-tag"` }
	});
	assert.equal(r4.status, 200);

	// refresh=1 forces a fresh upstream read, bypassing the cache and the
	// tag check.
	const r5 = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	assert.equal(r5.status, 200);
});

test("a poll that arrives while the previous read is still in flight joins it", async () => {
	const { gates, routes } = await bootGated();

	// The first poll blocks on the upstream read.
	const p1 = callRoute(routes, "/provider-usage/usage");
	await sleep(10);
	assert.equal(gates.length, 1);

	// `cacheMs` (40 ms) elapses while that read is STILL in flight: the second
	// poll must join the one upstream read instead of forking a duplicate, and it
	// cannot answer before the read lands (there is no settled value to serve).
	await sleep(60);
	const p2 = callRoute(routes, "/provider-usage/usage");
	const raced = await Promise.race([p2.then(() => "resolved"), sleep(200).then(() => "blocked")]);
	assert.equal(raced, "blocked", "a pending read is joined, not raced with a second one");
	assert.equal(gates.length, 1, "no duplicate upstream read while one is in flight");

	gates[0](usagePayload({ monthly: { status: "ok", percent: 10, resetsAt: null } }));
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1.body.servedStale, false);
	const go = r2.body.providers.find((p) => p.id === "opencode-go");
	assert.notEqual(go.servedStale, true, "a joined read is fresh, never stale-labelled");
	assert.equal(go.windows.find((w) => w.key === "monthly").percent, 10);
});

test("concurrent forced refreshes share one upstream read", async () => {
	const { gates, routes } = await bootGated();

	const first = callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	const second = callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	await sleep(20);
	assert.equal(gates.length, 1, "?refresh=1 must not fork a second upstream read while one is in flight");

	gates[0](usagePayload({ monthly: { status: "ok", percent: 33, resetsAt: null } }));
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.body.servedStale, false);
	assert.equal(b.body.servedStale, false, "a forced refresh still answers with fresh data");
	assert.equal(
		b.body.providers.find((p) => p.id === "opencode-go").windows.find((w) => w.key === "monthly").percent,
		33
	);
});

// ── silent fallback for transient failures ─────────────────────────────────
// A momentary network blip must not wipe the widget: the host answers with the
// provider's last good read (no error text) and retries later. Actionable
// failures (a rejected key, a vendor error) still reach the user.

/** The Command Code card of an aggregated usage answer. */
function commandCodeOf(body) {
	return body.providers.find((provider) => provider.id === "command-code");
}

test("a transient Command Code outage keeps the last good numbers and then recovers", async () => {
	const { routes, wire } = await boot({ credentialMap: CREDS, config: { cacheMs: 0 } });

	const first = await callRoute(routes, "/provider-usage/usage");
	const good = commandCodeOf(first.body);
	assert.equal(good.status, "ok");
	const goodMonthly = good.windows.find((window) => window.key === "monthly").percent;

	// Every billing call now fails on the wire — the exact "fetch failed" shape
	// of the intermittent error that used to wipe the card.
	wire.state.commandCodeFail = "/alpha/";
	wire.state.commandCodeFailError = new Error("fetch failed");

	const fallback = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	assert.equal(fallback.status, 200, "one provider's blip does not fail the document");
	const stale = commandCodeOf(fallback.body);
	assert.equal(stale.status, "ok");
	assert.equal(stale.servedStale, true);
	assert.equal(stale.error, undefined, "no error text is sent to the widget");
	assert.deepEqual(stale.windows.map((window) => window.key), good.windows.map((window) => window.key));
	assert.equal(stale.windows.find((window) => window.key === "monthly").percent, goodMonthly);
	assert.equal(stale.balance.amount, good.balance.amount);
	assert.deepEqual(stale.meta.errors, []);
	assert.equal(fallback.body.servedStale, true, "the widget keeps its follow-up refresh");

	// Upstream recovers: the next read is fresh again with no stale marker.
	wire.state.commandCodeFail = null;
	wire.state.commandCodeFailError = null;
	const recovered = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	const fresh = commandCodeOf(recovered.body);
	assert.equal(fresh.status, "ok");
	assert.notEqual(fresh.servedStale, true);
});

test("a background refresh that fails on the wire does not replace the cached document", async () => {
	const { routes, wire } = await boot({ credentialMap: CREDS, config: { cacheMs: 40 } });

	const first = await callRoute(routes, "/provider-usage/usage");
	assert.notEqual(commandCodeOf(first.body).servedStale, true);
	const goodMonthly = commandCodeOf(first.body).windows.find((window) => window.key === "monthly").percent;

	wire.state.commandCodeFail = "/alpha/";
	wire.state.commandCodeFailError = new Error("fetch failed");
	await sleep(60);

	// Expired cache: the answer is stale and the background refresh starts; the
	// failing refresh must not poison the entry with an error result.
	const second = await callRoute(routes, "/provider-usage/usage");
	assert.equal(commandCodeOf(second.body).servedStale, true);
	await sleep(30);

	const third = await callRoute(routes, "/provider-usage/usage");
	const stillThere = commandCodeOf(third.body);
	assert.equal(stillThere.status, "ok", "the failed refresh kept the last good read");
	assert.equal(stillThere.windows.find((window) => window.key === "monthly").percent, goodMonthly);
});

test("a rejected Command Code key still reaches the widget instead of stale numbers", async () => {
	const { routes, wire } = await boot({ credentialMap: CREDS, config: { cacheMs: 0 } });
	const first = await callRoute(routes, "/provider-usage/usage");
	assert.equal(commandCodeOf(first.body).status, "ok");

	wire.state.commandCodeFail = "/alpha/";
	wire.state.commandCodeFailStatus = 401;
	const res = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	const cc = commandCodeOf(res.body);
	assert.equal(res.status, 200, "the other providers still render");
	assert.equal(cc.status, "error");
	assert.equal(cc.transient, undefined, "a rejected key is not papered over");
	assert.match(cc.error, /401/);
});

test("a rejected key invalidates the last good read", async () => {
	const { routes, wire } = await boot({ credentialMap: CREDS, config: { cacheMs: 0 } });
	await callRoute(routes, "/provider-usage/usage");

	wire.state.commandCodeFail = "/alpha/";
	wire.state.commandCodeFailStatus = 401;
	const denied = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	assert.equal(commandCodeOf(denied.body).status, "error");

	// The vendor already rejected the key, so the old numbers are not "the last
	// good read" any more: a later network blip must not bring them back.
	wire.state.commandCodeFailStatus = 502;
	const blip = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	assert.equal(commandCodeOf(blip.body).status, "error");
	assert.equal(commandCodeOf(blip.body).transient, true);
});

test("a poll that joins an in-flight outage read still gets the fallback", async () => {
	const { routes, wire } = await boot({ credentialMap: CREDS, config: { cacheMs: 0 } });
	await callRoute(routes, "/provider-usage/usage");

	wire.state.commandCodeFail = "/alpha/";
	wire.state.commandCodeFailError = new Error("fetch failed");
	const [a, b] = await Promise.all([
		callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" }),
		callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" })
	]);
	// One request owns the upstream read, the other joins its promise; both
	// must receive the effective (fallback) value, not the raw error result.
	for (const res of [a, b]) {
		const cc = commandCodeOf(res.body);
		assert.equal(cc.status, "ok");
		assert.equal(cc.servedStale, true);
	}
});

test("a throttled Command Code read also falls back", async () => {
	const { routes, wire } = await boot({ credentialMap: CREDS, config: { cacheMs: 0 } });
	const first = await callRoute(routes, "/provider-usage/usage");
	const monthly = commandCodeOf(first.body).windows.find((window) => window.key === "monthly").percent;

	wire.state.commandCodeFail = "/alpha/";
	wire.state.commandCodeFailStatus = 429;
	const res = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	const cc = commandCodeOf(res.body);
	assert.equal(cc.status, "ok");
	assert.equal(cc.servedStale, true);
	assert.equal(cc.windows.find((window) => window.key === "monthly").percent, monthly);
});

test("a revoked OpenCode GO key is shown, not hidden behind stale numbers", async () => {
	const { routes, wire } = await boot({ credentialMap: CREDS, config: { cacheMs: 0 } });
	const first = await callRoute(routes, "/provider-usage/usage");
	const goOf = (body) => body.providers.find((provider) => provider.id === "opencode-go");
	assert.equal(goOf(first.body).status, "ok");

	wire.state.opencodeStatus = 401;
	const denied = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	const go = goOf(denied.body);
	assert.equal(go.status, "error");
	assert.equal(go.transient, undefined, "a 401 is actionable, not a blip");
	assert.match(go.error, /401/);
	assert.equal(goOf(first.body).status, "ok");
	wire.state.opencodeStatus = 200;
});

test("a balance blip keeps the last known balance", async () => {
	const { routes, wire } = await boot({
		credentialMap: { ...CREDS, OPENCODE_CONSOLE_TOKEN: "sk-console" },
		config: {
			cacheMs: 0,
			opencodeConsoleEnabled: true,
			opencodeConsoleApiKeyEnv: "OPENCODE_CONSOLE_TOKEN",
			opencodeConsoleAuthFile: "/nonexistent/console-auth.json",
			opencodeConsoleDbFile: "/nonexistent/console.db"
		}
	});
	const goOf = (body) => body.providers.find((provider) => provider.id === "opencode-go");
	const first = await callRoute(routes, "/provider-usage/usage");
	assert.equal(goOf(first.body).balance.amount, 5.01495352);

	wire.state.consoleError = new Error("fetch failed");
	const blip = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	const go = goOf(blip.body);
	assert.equal(go.status, "ok");
	assert.equal(go.balance.amount, 5.01495352, "the old balance survives an auxiliary wire miss");
	assert.equal(go.meta.balanceError, undefined);
	assert.equal(JSON.stringify(blip.body).includes("fetch failed"), false, "no error text reaches the widget");

	wire.state.consoleError = null;
	const recovered = await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	assert.equal(goOf(recovered.body).balance.amount, 5.01495352);
});
