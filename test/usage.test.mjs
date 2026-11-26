// GET /provider-usage/usage: multi-provider aggregation, isolation of failures,
// caching, forced refreshes and the optional dsh-opencode-go integration.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	callRoute,
	commandCodeFixture,
	glmFixture,
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

/** Boot with the defaults used by most tests. */
async function bootWith(overrides = {}) {
	const wire = (await import("./support/harness.mjs")).installWire(overrides.wire ?? {});
	const { makeCtx } = await import("./support/harness.mjs");
	const { ctx, routes, commands } = makeCtx({
		entries: overrides.entries ?? [],
		services: overrides.services ?? {},
		credentialMap: overrides.credentialMap ?? CREDS,
		entryConfig: overrides.entryConfig,
		port: 1234
	});
	const config = {
		cacheMs: 0,
		updateCheck: false,
		autoUpdate: false,
		opencodeConsoleEnabled: false,
		commandCodeAuthFile: "/nonexistent/commandcode-auth.json",
		...overrides.config
	};
	host.apply(ctx, config);
	return { wire, ctx, routes, commands, config };
}

test("GET usage returns all three providers in display order", async () => {
	const { routes } = await bootWith();
	const res = await callRoute(routes, "/provider-usage/usage");

	assert.equal(res.status, 200);
	assert.equal(res.body.ok, true);
	assert.deepEqual(res.body.providers.map((provider) => provider.id), ["opencode-go", "command-code", "glm"]);
	assert.deepEqual(res.body.enabled, ["opencode-go", "command-code", "glm"]);
	assert.deepEqual(res.body.providerOrder, ["opencode-go", "command-code", "glm"]);

	const [go, cc, glm] = res.body.providers;
	assert.equal(go.status, "ok");
	assert.equal(go.windows.find((window) => window.key === "monthly").percent, 56);
	assert.equal(cc.status, "ok");
	assert.equal(Math.round(cc.windows.find((window) => window.key === "monthly").percent * 100) / 100, 50.09);
	assert.equal(glm.status, "ok");
	assert.deepEqual(glm.windows.map((window) => window.key), ["five-hour", "weekly", "mcp"]);
	// The 5-hour window uses the same label key for every provider, so the
	// widget and the turn-usage card cannot drift apart again.
	const fiveHourKeys = [
		go.windows.find((window) => window.key === "rolling").labelKey,
		cc.windows.find((window) => window.key === "five-hour").labelKey,
		glm.windows.find((window) => window.key === "five-hour").labelKey
	];
	assert.deepEqual(fiveHourKeys, ["window.five-hour", "window.five-hour", "window.five-hour"]);
	assert.equal(res.body.sessionHeader.active, true);
});

/** A live llm-pi-ai entry: the GLM model route names the Code Plan version. */
function piAiEntry(providers) {
	return {
		id: "llm-pi-ai",
		options: { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" },
		disabled: false,
		fiber: { uid: 77, config: { providers } }
	};
}

test("auto GLM asks and badges the plan its model route names", async () => {
	const { routes, wire } = await bootWith({
		entries: [piAiEntry({ "zai-coding-cn": { apiKeyEnv: "ZAI_CODING_CN_API_KEY" } })],
		// The user's only GLM credential is the China plan key; both hosts answer
		// it with the same quota, so the probe order must follow the model route.
		credentialMap: { OPENCODE_GO_API_KEY: "sk-go", COMMANDCODE_API_KEY: "sk-cc", ZAI_CODING_CN_API_KEY: "sk-cn" },
		wire: { glm: { zai: glmFixture(), bigmodel: glmFixture() } }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const glm = res.body.providers.find((provider) => provider.id === "glm");

	assert.equal(glm.status, "ok");
	assert.equal(glm.account.ref, "ZAI_CODING_CN_API_KEY");
	assert.equal(glm.meta.regionKind, "bigmodel", "the China plan is badged as China even though api.z.ai answers too");
	assert.equal(glm.meta.regionHint, "bigmodel");
	const firstGlmCall = wire.requests.find((request) => request.url.includes("/monitor/usage/quota/limit"));
	assert.match(firstGlmCall.url, /open\.bigmodel\.cn/, "the plan's own host is asked first");
});

test("a changed GLM model route invalidates the cached region badge", async () => {
	const entry = piAiEntry({ zai: { apiKeyEnv: "ZAI_API_KEY" } });
	const { ctx, routes } = await bootWith({
		entries: [entry],
		config: { cacheMs: 60_000 },
		wire: { glm: { zai: glmFixture(), bigmodel: glmFixture() } }
	});

	const first = await callRoute(routes, "/provider-usage/usage");
	assert.equal(first.body.providers.find((provider) => provider.id === "glm").meta.regionKind, "zai");

	// Same credential, different route: the quota cache must not keep serving
	// the previous version's badge.
	entry.fiber.config.providers = { "zai-coding-cn": { apiKeyEnv: "ZAI_API_KEY" } };
	const second = await callRoute(routes, "/provider-usage/usage");
	assert.equal(second.body.providers.find((provider) => provider.id === "glm").meta.regionKind, "bigmodel");
	assert.ok(ctx);
});

test("both GLM keys present: the model route's key answers instead of the default ref", async () => {
	const { routes, wire } = await bootWith({
		entries: [piAiEntry({ "zai-coding-cn": { apiKeyEnv: "ZAI_CODING_CN_API_KEY" } })],
		credentialMap: {
			OPENCODE_GO_API_KEY: "sk-go",
			COMMANDCODE_API_KEY: "sk-cc",
			ZAI_API_KEY: "sk-intl",
			ZAI_CODING_CN_API_KEY: "sk-cn"
		},
		wire: { glm: { zai: glmFixture(), bigmodel: glmFixture() } }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const glm = res.body.providers.find((provider) => provider.id === "glm");

	assert.equal(glm.status, "ok");
	assert.equal(glm.account.ref, "ZAI_CODING_CN_API_KEY", "the route's China key wins over the schema-default ZAI_API_KEY");
	assert.equal(glm.meta.regionKind, "bigmodel");
	const firstGlmCall = wire.requests.find((request) => request.url.includes("/monitor/usage/quota/limit"));
	assert.match(firstGlmCall.url, /open\.bigmodel\.cn/);
});

test("both GLM keys present without a model route: the China-first order answers", async () => {
	const { routes } = await bootWith({
		entries: [],
		credentialMap: {
			OPENCODE_GO_API_KEY: "sk-go",
			COMMANDCODE_API_KEY: "sk-cc",
			ZAI_API_KEY: "sk-intl",
			ZAI_CODING_CN_API_KEY: "sk-cn"
		},
		wire: { glm: { zai: glmFixture(), bigmodel: glmFixture() } }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const glm = res.body.providers.find((provider) => provider.id === "glm");

	assert.equal(glm.account.ref, "ZAI_CODING_CN_API_KEY", "the documented ZAI_CODING_CN_API_KEY-first order still applies");
	assert.equal(glm.meta.regionKind, "bigmodel");
});

test("an explicitly pinned GLM credential outranks the model route", async () => {
	const { routes } = await bootWith({
		entries: [piAiEntry({ "zai-coding-cn": { apiKeyEnv: "ZAI_CODING_CN_API_KEY" } })],
		entryConfig: { glmApiKeyEnv: "ZAI_API_KEY" },
		credentialMap: {
			OPENCODE_GO_API_KEY: "sk-go",
			COMMANDCODE_API_KEY: "sk-cc",
			ZAI_API_KEY: "sk-intl",
			ZAI_CODING_CN_API_KEY: "sk-cn"
		},
		wire: { glm: { zai: glmFixture(), bigmodel: glmFixture() } }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const glm = res.body.providers.find((provider) => provider.id === "glm");

	assert.equal(glm.account.ref, "ZAI_API_KEY", "a ref saved in settings decides, not the model route");
	assert.equal(glm.meta.regionKind, "zai");
});

test("one broken provider does not hide the other two", async () => {
	const { routes } = await bootWith({ wire: { commandCodeFail: "alpha" } });
	const res = await callRoute(routes, "/provider-usage/usage");

	assert.equal(res.status, 200);
	assert.equal(res.body.ok, true);
	const byId = Object.fromEntries(res.body.providers.map((provider) => [provider.id, provider]));
	assert.equal(byId["opencode-go"].status, "ok");
	assert.equal(byId.glm.status, "ok");
	assert.equal(byId["command-code"].status, "error");
	assert.equal(byId["command-code"].code, "read-failed");
	assert.match(byId["command-code"].error, /Command Code/);
});

test("all providers failing returns 502 with per-provider errors", async () => {
	const { routes } = await bootWith({ credentialMap: {} });
	const res = await callRoute(routes, "/provider-usage/usage");

	assert.equal(res.status, 502);
	assert.equal(res.body.ok, false);
	assert.equal(res.body.providers.length, 3);
	for (const provider of res.body.providers) {
		assert.equal(provider.status, "error");
		assert.equal(provider.code, "no-credential");
	}
	assert.match(res.body.error, /OpenCode GO/);
});

test("a disabled provider is omitted entirely", async () => {
	const { routes } = await bootWith({ config: { commandCodeEnabled: false } });
	const res = await callRoute(routes, "/provider-usage/usage");
	assert.equal(res.status, 200);
	assert.deepEqual(res.body.enabled, ["opencode-go", "glm"]);
	assert.deepEqual(res.body.providers.map((provider) => provider.id), ["opencode-go", "glm"]);
});

test("no enabled provider is a successful empty response, not an error", async () => {
	const { routes } = await bootWith({
		config: { opencodeGoEnabled: false, commandCodeEnabled: false, glmEnabled: false }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	// An all-disabled configuration is a state, not a failure: the widget
	// renders its own localized empty hint for an empty provider list, and a
	// string `error` here would make it show raw host text instead.
	assert.equal(res.status, 200);
	assert.deepEqual(res.body.providers, []);
	assert.deepEqual(res.body.enabled, []);
	assert.equal(res.body.ok, false);
	assert.equal(res.body.error, undefined);
	assert.equal(typeof res.headers.etag, "string", "the empty state is negotiated like any other document");
});

test("the host cache collapses repeated polls and refresh=1 bypasses it", async () => {
	const { wire, routes } = await bootWith({ config: { cacheMs: 60_000 } });
	await callRoute(routes, "/provider-usage/usage");
	await callRoute(routes, "/provider-usage/usage");
	const usageCalls = () => wire.requests.filter((request) => request.url.includes("/v1/usage")).length;
	assert.equal(usageCalls(), 1, "the second poll must be served from cache");

	await callRoute(routes, "/provider-usage/usage", { url: "/provider-usage/usage?refresh=1" });
	assert.equal(usageCalls(), 2, "refresh=1 must bypass the cache");
});

test("opencodeGoSource=opencode-go reads the live service and reports the account", async () => {
	const service = usageService(() => usagePayload({ monthly: { status: "ok", percent: 73, resetsAt: null } }));
	const { wire, routes } = await bootWith({
		entries: [goEntry()],
		services: { opencodeGoUsage: service },
		config: { opencodeGoSource: "opencode-go" }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const go = res.body.providers.find((provider) => provider.id === "opencode-go");

	assert.equal(go.source, "opencode-go");
	assert.equal(go.account.name, "mekki");
	assert.equal(go.windows.find((window) => window.key === "monthly").percent, 73);
	assert.equal(wire.requests.filter((request) => request.url.includes("/v1/usage")).length, 0);
});

test("opencodeGoSource=builtin never reads the dsh-opencode-go service", async () => {
	const service = usageService(() => usagePayload({ monthly: { status: "ok", percent: 99, resetsAt: null } }));
	const { wire, routes } = await bootWith({
		entries: [goEntry()],
		services: { opencodeGoUsage: service },
		config: { opencodeGoSource: "builtin" }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const go = res.body.providers.find((provider) => provider.id === "opencode-go");

	assert.equal(go.source, "builtin");
	assert.equal(go.fallback, null);
	assert.equal(service.calls, 0);
	assert.equal(wire.requests.filter((request) => request.url.includes("/v1/usage")).length, 1);
});

test("a service failure is reported on the provider while the built-in fallback succeeds", async () => {
	const service = usageService(() => { throw new Error("boom from read"); });
	const { routes } = await bootWith({
		entries: [goEntry()],
		services: { opencodeGoUsage: service },
		config: { opencodeGoSource: "opencode-go" }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const go = res.body.providers.find((provider) => provider.id === "opencode-go");

	assert.equal(go.status, "ok");
	assert.equal(go.source, "builtin");
	assert.equal(go.fallback.reason, "read-failed");
	assert.match(go.fallback.message, /boom from read/);
	assert.equal(go.meta.opencodeGo.reason, "read-failed");
});


test("GET usage includes the OpenCode GO and Command Code top-up balances", async () => {
	const { routes } = await bootWith({
		credentialMap: { ...CREDS, OPENCODE_CONSOLE_TOKEN: "sk-console" },
		config: { opencodeConsoleEnabled: true },
		wire: { console: { availableMicroCents: "501495352" } }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	const go = res.body.providers.find((provider) => provider.id === "opencode-go");
	const cc = res.body.providers.find((provider) => provider.id === "command-code");

	assert.equal(go.balance.amount, 5.01495352);
	assert.equal(go.balance.labelKey, "balance.zen");
	assert.equal(cc.balance.amount, 7.444241674);
	assert.equal(cc.balance.labelKey, "balance.extra");
});

test("the chat command reports missing and partial balances instead of omitting them", async () => {
	const command = (booted) => booted.commands.find((candidate) => candidate.name === "provider-usage");

	const missing = await bootWith({
		config: {
			opencodeConsoleEnabled: true,
			opencodeConsoleApiKeyEnv: "MISSING_CONSOLE_REF",
			opencodeConsoleAuthFile: "/nonexistent/auth.json",
			opencodeConsoleDbFile: "/nonexistent/opencode.db"
		}
	});
	const missingText = (await command(missing).handler()).text;
	assert.match(missingText, /未配置/);
	assert.match(missingText, /opencode auth login/);

	const fixture = commandCodeFixture();
	const noTopUp = await bootWith({
		wire: {
			commandCode: {
				...fixture,
				credits: { credits: { monthlyCredits: 34.9 }, windowLimits: fixture.credits.windowLimits }
			}
		}
	});
	const noTopUpText = (await command(noTopUp).handler()).text;
	assert.match(noTopUpText, /无充值额度/);

	// A rejected call (4xx) is a real answer worth reporting; a transport blip
	// is not (that path is covered by the stale-fallback tests).
	const partial = await bootWith({ wire: { commandCodeFail: "/alpha/whoami", commandCodeFailStatus: 403 } });
	const partialText = (await command(partial).handler()).text;
	assert.match(partialText, /部分接口失败/);
	assert.match(partialText, /whoami/);
	assert.match(partialText, /购买 \$7\.44 \+ 免费 \$0\.00/, "the balance line names purchased and free credits");
});

test("the chat command names a missing OpenCode GO subscription instead of quoting the gateway", async () => {
	const { commands } = await bootWith({
		wire: {
			opencode: { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } },
			opencodeStatus: 403
		}
	});
	const command = commands.find((candidate) => candidate.name === "provider-usage");
	const text = (await command.handler()).text;
	assert.match(text, /没有 OpenCode GO 订阅/);
	assert.doesNotMatch(text, /EntitlementError|subscription required/);
});

test("the chat command follows the configured provider order", async () => {
	// The widget sorts cards by `providerOrder`; the command output must tell
	// the same story instead of always listing the canonical order.
	const { commands } = await bootWith({
		config: { providerOrder: ["glm", "command-code", "opencode-go"] }
	});
	const command = commands.find((candidate) => candidate.name === "provider-usage");
	const text = (await command.handler()).text;
	const glm = text.indexOf("GLM Code Plan");
	const cc = text.indexOf("Command Code");
	const go = text.indexOf("OpenCode GO");
	assert.ok(glm !== -1 && cc !== -1 && go !== -1, "all three providers render");
	assert.ok(glm < cc && cc < go, `saved order is followed (glm ${glm} < cc ${cc} < go ${go})`);
});

test("the chat command guides API-key and expired console logins to re-authenticate", async () => {
	const command = (booted) => booted.commands.find((candidate) => candidate.name === "provider-usage");
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const nodePath = await import("node:path");
	const dir = await mkdtemp(nodePath.join(tmpdir(), "dpu-console-"));
	try {
		// An API-key-only login (oc_sk_…) carries no console balance; the
		// command must name the fix instead of a generic failure.
		const authFile = nodePath.join(dir, "auth.json");
		await writeFile(authFile, JSON.stringify({ opencode: { type: "api", key: "oc_sk_local" } }));
		const apiKeyOnly = await bootWith({
			config: {
				opencodeConsoleEnabled: true,
				opencodeConsoleAuthFile: authFile,
				opencodeConsoleDbFile: nodePath.join(dir, "missing.db")
			}
		});
		const apiKeyText = (await command(apiKeyOnly).handler()).text;
		assert.match(apiKeyText, /API Key 登录/);
		assert.match(apiKeyText, /opencode auth login/);
		assert.match(apiKeyText, /OpenCode Console/);

		// A rejected console session (401/403 from the billing endpoint) is an
		// expired sign-in; the command names re-authentication.
		const expiredFile = nodePath.join(dir, "expired.json");
		await writeFile(expiredFile, JSON.stringify({ opencode: { access: "st_expired", expires: Date.now() - 1000 } }));
		const expired = await bootWith({
			wire: { console: null },
			config: {
				opencodeConsoleEnabled: true,
				opencodeConsoleAuthFile: expiredFile,
				opencodeConsoleDbFile: nodePath.join(dir, "missing.db")
			}
		});
		const expiredText = (await command(expired).handler()).text;
		assert.match(expiredText, /已过期/);
		assert.match(expiredText, /opencode auth login/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a Command Code error card keeps the plan it already resolved", async () => {
	const { routes } = await bootWith({ wire: { commandCodeFail: "/alpha/billing/credits" } });
	const res = await callRoute(routes, "/provider-usage/usage");
	const cc = res.body.providers.find((provider) => provider.id === "command-code");
	assert.equal(cc.status, "error");
	assert.equal(cc.plan.name, "GOAT", "the known plan is not thrown away with the failure");
	assert.match(cc.error, /alpha\/billing\/credits 500/, "the error names the failing call");
});

test("the usage ETag ignores the volatile session-header diagnostics", async () => {
	const session = await import("../lib/opencode-session.js");
	const { routes } = await bootWith({ config: { cacheMs: 60_000 } });
	const first = await callRoute(routes, "/provider-usage/usage");
	assert.equal(first.status, 200);

	// One llm/stream observation moves the diagnostics only; the quota document
	// is unchanged, so the negotiated cache must still answer 304. A tag folded
	// over the counters would re-download the document on every chat turn and
	// reset the client's idle backoff each time.
	session.recordStream({ provider: "opencode-go", hasSessionId: true, base: "https://opencode.ai/zen/go", baseFrom: "settings" });
	const second = await callRoute(routes, "/provider-usage/usage", {
		headers: { "if-none-match": first.headers.etag }
	});
	assert.equal(second.status, 304);
	assert.equal(second.text, "");

	// The response body itself still carries the diagnostics for the widget.
	const full = await callRoute(routes, "/provider-usage/usage");
	assert.equal(typeof full.body.sessionHeader.active, "boolean");
	assert.equal(typeof full.body.sessionHeader.count, "number");
	assert.equal(typeof full.body.sessionHeader.diag.streamSeen, "number");
	assert.ok(full.body.sessionHeader.diag.streamSeen >= 1);
});

test("two unchanged quota polls answer 304 even though the derived estimates moved", async () => {
	// `meta.projection.elapsedDays` / `runsOutInDays` are floats recomputed from
	// Date.now() on every read, and Command Code always carries them. Folding
	// them into the tag made every poll a new document, so the negotiated cache
	// never answered 304 for that provider.
	const { routes } = await bootWith({ config: { cacheMs: 0 } });
	const first = await callRoute(routes, "/provider-usage/usage");
	assert.equal(first.status, 200);
	const second = await callRoute(routes, "/provider-usage/usage", {
		headers: { "if-none-match": first.headers.etag }
	});
	assert.equal(second.status, 304, "the upstream quota document did not change");
	assert.equal(second.text, "");
});

test("the chat command renders a sub-0.1% window like the widget", async () => {
	const { glmFixture } = await import("./support/harness.mjs");
	// A tiny but non-zero share used to print as "0%", which reads as "no usage
	// at all"; the widget already renders "<0.1", so the command must too.
	const tiny = glmFixture({
		limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0.04, nextResetTime: 1793371200000 }]
	});
	const { commands } = await bootWith({ wire: { glm: { zai: tiny, bigmodel: null } } });
	const command = commands.find((candidate) => candidate.name === "provider-usage");
	const text = (await command.handler()).text;
	// Scope the check to the GLM card: Command Code's own 0% five-hour window is
	// a genuine zero and must keep reading as "0%".
	const glmSection = text.slice(text.indexOf("GLM Code Plan"));
	assert.match(glmSection, /5 小时窗口: <0\.1%/);
	assert.doesNotMatch(glmSection, /5 小时窗口: 0%/);
});

test("the chat command keeps a regional English locale fully English", async () => {
	const localeEntry = {
		id: "locale",
		options: { id: "locale", name: "@deepseek-ai/dsh-client-locale" },
		disabled: false,
		fiber: { uid: 7, config: { preference: "en-US" } }
	};
	const { commands, routes } = await bootWith({
		entries: [localeEntry],
		wire: { registry: { version: "9.9.9" } },
		config: { updateCheck: true }
	});
	// Prime the npm update state the command reports on.
	await callRoute(routes, "/provider-usage/usage");
	await new Promise((resolve) => { setTimeout(resolve, 20); });

	const command = commands.find((candidate) => candidate.name === "provider-usage");
	const text = (await command.handler()).text;
	assert.match(text, /^Provider usage:/m);
	assert.match(text, /Update available: v9\.9\.9/);
	assert.doesNotMatch(text, /发现新版本/, "the update line follows the same locale rule as the report");
});
