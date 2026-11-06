// Stale-while-revalidate and negotiated caching (ETag/304) on the usage route.
// A gated dsh-opencode-go service stub plays the controllably slow upstream,
// so the tests can prove which requests wait for it and which do not.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
