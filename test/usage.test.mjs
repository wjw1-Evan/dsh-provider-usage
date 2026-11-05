// GET /provider-usage/usage: multi-provider aggregation, isolation of failures,
// caching, forced refreshes and the optional dsh-opencode-go integration.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	callRoute,
	commandCodeFixture,
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
	assert.equal(Math.round(cc.windows.find((window) => window.key === "monthly").percent * 100) / 100, 51.86);
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

test("no enabled provider is a successful empty response, not a crash", async () => {
	const { routes } = await bootWith({
		config: { opencodeGoEnabled: false, commandCodeEnabled: false, glmEnabled: false }
	});
	const res = await callRoute(routes, "/provider-usage/usage");
	assert.equal(res.status, 502);
	assert.deepEqual(res.body.providers, []);
	assert.equal(res.body.ok, false);
	assert.equal(res.body.error, "no providers enabled");
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

	const partial = await bootWith({ wire: { commandCodeFail: "/alpha/whoami" } });
	const partialText = (await command(partial).handler()).text;
	assert.match(partialText, /部分接口失败/);
	assert.match(partialText, /whoami/);
	assert.match(partialText, /购买 \$7\.44 \+ 免费 \$0\.00/, "the balance line names purchased and free credits");
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
