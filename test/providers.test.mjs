// Provider adapters: canonical shapes, vendor quirks and fallback paths.
// Every test uses the hermetic wire from support/harness.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commandCodeFixture,
	glmFixture,
	installWire,
	loadProviders,
	usagePayload,
	usageService
} from "./support/harness.mjs";

const providers = await loadProviders();

/** A resolver over one credential map. */
function resolver(map = {}) {
	return async (refs) => {
		for (const ref of refs) {
			if (Object.hasOwn(map, ref)) return { ref, value: map[ref] };
		}
		return null;
	};
}

test("OpenCode GO normalizes the gateway's three windows", () => {
	const windows = providers.normalizeOpencodeUsage(usagePayload());
	assert.deepEqual(windows.map((window) => window.key), ["rolling", "weekly", "monthly"]);
	assert.equal(windows[0].percent, 12);
	assert.equal(windows[2].windowMs, 30 * 86400e3);
});

test("OpenCode GO accepts the flat service shape as well", () => {
	const windows = providers.normalizeOpencodeUsage({
		rolling: { status: "ok", percent: 1, resetsAt: null },
		weekly: { status: "ok", percent: 2, resetsAt: null },
		monthly: { status: "ok", percent: 3, resetsAt: null }
	});
	assert.deepEqual(windows.map((window) => window.percent), [1, 2, 3]);
});

test("OpenCode GO rejects a payload missing a window instead of inventing zeroes", () => {
	assert.throws(
		() => providers.normalizeOpencodeUsage({ usage: { rolling: { percent: 1 }, weekly: { percent: 2 } } }),
		/invalid usage payload/
	);
});

test("Command Code plan ids resolve longest-first", () => {
	assert.deepEqual(providers.commandCodePlan("individual-goat"), { id: "individual-goat", name: "GOAT", totalCredits: 70 });
	assert.deepEqual(providers.commandCodePlan("individual-go-v1"), { id: "individual-go-v1", name: "Go", totalCredits: 10 });
	assert.deepEqual(providers.commandCodePlan("individual-pro-v1"), { id: "individual-pro-v1", name: "Pro", totalCredits: 80 });
	assert.equal(providers.commandCodePlan(null), null);
});

test("GLM quota normalization maps 5-hour, weekly and MCP limits", () => {
	const windows = providers.normalizeGlmUsage(glmFixture());
	assert.deepEqual(windows.map((window) => window.key), ["five-hour", "weekly", "mcp"]);
	assert.equal(windows[0].percent, 40.5);
	assert.equal(windows[1].windowMs, 7 * 86400e3);
	assert.equal(windows[2].labelKey, "window.mcp");
	assert.equal(windows[0].resetsAt, new Date(1793371200000).toISOString());
});

test("GLM quota rejects an envelope without limits", () => {
	assert.throws(() => providers.normalizeGlmUsage({ success: true }), /no limits array/);
});

test("GLM bases and quota URLs accept a bare host or an /api base", () => {
	assert.deepEqual(providers.glmBases({ region: "zai" }), ["https://api.z.ai"]);
	assert.deepEqual(providers.glmBases({ region: "bigmodel" }), ["https://open.bigmodel.cn"]);
	assert.deepEqual(providers.glmBases({ region: "auto" }), ["https://api.z.ai", "https://open.bigmodel.cn"]);
	assert.equal(providers.glmQuotaUrl("https://api.z.ai"), "https://api.z.ai/api/monitor/usage/quota/limit");
	assert.equal(providers.glmQuotaUrl("https://api.z.ai/api/"), "https://api.z.ai/api/monitor/usage/quota/limit");
});

test("readCommandCode derives the monthly, 5-hour and weekly windows", async () => {
	installWire({ commandCode: commandCodeFixture() });
	const result = await providers.readCommandCode({
		config: { apiKeyEnv: "COMMANDCODE_API_KEY", baseUrl: "https://api.commandcode.ai" },
		resolveCredential: resolver({ COMMANDCODE_API_KEY: "sk-cc" })
	});

	assert.equal(result.id, "command-code");
	assert.equal(result.account.name, "Evan");
	assert.equal(result.plan.name, "GOAT");
	assert.deepEqual(result.windows.map((window) => window.key), ["five-hour", "weekly", "monthly"]);
	const monthly = result.windows.find((window) => window.key === "monthly");
	assert.equal(Math.round(monthly.percent * 100) / 100, 51.86);
	assert.equal(monthly.resetsAt, "2026-11-30T16:48:56.000Z");
	const weekly = result.windows.find((window) => window.key === "weekly");
	assert.equal(weekly.percent, 100);
	assert.equal(weekly.status, "exceeded");
	assert.equal(weekly.resetsAt, new Date(1794070179518).toISOString());
	assert.equal(result.meta.monthly.purchased, 7.444241674);
	assert.equal(result.balance.labelKey, "balance.extra");
	assert.equal(result.balance.amount, 7.444241674);
	assert.equal(result.balance.currency, "USD");
	assert.deepEqual(result.balance.details, { purchased: 7.444241674, free: 0 });
});

test("readCommandCode fails loudly without a credential or auth file", async () => {
	installWire({});
	await assert.rejects(
		providers.readCommandCode({
			config: { apiKeyEnv: "COMMANDCODE_API_KEY", baseUrl: "https://api.commandcode.ai", authFile: "/nonexistent/auth.json" },
			resolveCredential: resolver({})
		}),
		(error) => error.code === "no-credential"
	);
});

test("readGlm falls back from z.ai to bigmodel in auto mode and sends the raw token", async () => {
	const wire = installWire({ glm: { zai: { success: false, msg: "当前用户不存在coding plan" }, bigmodel: glmFixture() } });
	const result = await providers.readGlm({
		config: { apiKeyEnv: "ZAI_API_KEY", region: "auto" },
		resolveCredential: resolver({ ZAI_API_KEY: "sk-glm" })
	});

	assert.equal(result.id, "glm");
	assert.deepEqual(result.windows.map((window) => window.key), ["five-hour", "weekly", "mcp"]);
	assert.match(result.source, /^credential:/);
	assert.equal(result.meta.region, "https://open.bigmodel.cn");
	const request = wire.requests.find((entry) => entry.url.includes("open.bigmodel.cn"));
	assert.equal(request.headers.get("authorization"), "sk-glm", "GLM expects the raw token, not a Bearer scheme");
});

test("readGlm requires a base URL for the custom region", async () => {
	installWire({});
	await assert.rejects(
		providers.readGlm({
			config: { apiKeyEnv: "ZAI_API_KEY", region: "custom" },
			resolveCredential: resolver({ ZAI_API_KEY: "sk-glm" })
		}),
		(error) => error.code === "no-endpoint"
	);
});

test("readGlm surfaces an account-level failure when every region rejects it", async () => {
	installWire({ glm: { zai: { success: false, msg: "no plan" }, bigmodel: { success: false, msg: "still no plan" } } });
	await assert.rejects(
		providers.readGlm({
			config: { apiKeyEnv: "ZAI_API_KEY", region: "auto" },
			resolveCredential: resolver({ ZAI_API_KEY: "sk-glm" })
		}),
		(error) => error.code === "api-error" && /no plan/.test(error.message)
	);
});

test("readOpencodeGo uses the built-in endpoint with a resolved credential", async () => {
	const wire = installWire({ opencode: usagePayload({ monthly: { status: "ok", percent: 42, resetsAt: null } }) });
	const result = await providers.readOpencodeGo({
		config: { source: "builtin", apiKeyEnv: "OPENCODE_GO_API_KEY", baseUrl: "https://opencode.ai/zen/go" },
		resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
		entry: null
	});

	assert.equal(result.source, "builtin");
	assert.equal(result.requested, "builtin");
	assert.equal(result.fallback, null);
	assert.equal(result.windows.find((window) => window.key === "monthly").percent, 42);
	const call = wire.requests.find((request) => request.url.includes("/v1/usage"));
	assert.equal(call.headers.get("authorization"), "Bearer sk-go");
});

test("readOpencodeGo prefers the dsh-opencode-go service and skips the gateway", async () => {
	const wire = installWire({});
	const service = usageService(() => usagePayload({ monthly: { status: "ok", percent: 73, resetsAt: null } }));
	const result = await providers.readOpencodeGo({
		config: { source: "opencode-go", apiKeyEnv: "OPENCODE_GO_API_KEY", baseUrl: "https://opencode.ai/zen/go" },
		resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
		service,
		entry: {
			found: true,
			enabled: true,
			account: { ref: "OPENCODE_API_KEY", id: "legacy:OPENCODE_API_KEY", name: "mekki" },
			ref: "OPENCODE_API_KEY"
		}
	});

	assert.equal(result.source, "opencode-go");
	assert.equal(result.account.name, "mekki");
	assert.equal(result.windows.find((window) => window.key === "monthly").percent, 73);
	assert.equal(wire.requests.filter((request) => request.url.includes("/v1/usage")).length, 0);
});

test("readOpencodeGo falls back to builtin when the service read throws", async () => {
	const wire = installWire({ opencode: usagePayload({ monthly: { status: "ok", percent: 61, resetsAt: null } }) });
	const service = usageService(() => { throw new Error("boom"); });
	const result = await providers.readOpencodeGo({
		config: { source: "opencode-go", apiKeyEnv: "OPENCODE_GO_API_KEY", baseUrl: "https://opencode.ai/zen/go" },
		resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
		service,
		entry: { found: true, enabled: true, account: { ref: "OPENCODE_API_KEY", name: "mekki" }, ref: "OPENCODE_API_KEY" }
	});

	assert.equal(result.source, "builtin");
	assert.equal(result.requested, "opencode-go");
	assert.equal(result.fallback.reason, "read-failed");
	assert.match(result.fallback.message, /boom/);
	assert.equal(result.windows.find((window) => window.key === "monthly").percent, 61);
	assert.equal(wire.requests.filter((request) => request.url.includes("/v1/usage")).length, 1);
});


test("readOpencodeGo attaches the OpenCode console top-up balance", async () => {
	const wire = installWire({
		console: {
			availableMicroCents: "501495352",
			balanceMicroCents: "501495352",
			billingMode: "prepaid",
			mode: "pay-as-you-go",
			canPurchaseCredits: true
		}
	});
	const result = await providers.readOpencodeGo({
		config: {
			source: "builtin",
			apiKeyEnv: "OPENCODE_GO_API_KEY",
			baseUrl: "https://opencode.ai/zen/go",
			console: {
				enabled: true,
				apiKeyEnv: "OPENCODE_CONSOLE_TOKEN",
				orgId: "org-1",
				authFile: "/nonexistent/auth.json",
				dbFile: "/nonexistent/opencode.db",
				baseUrl: "https://opencode.ai"
			}
		},
		resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go", OPENCODE_CONSOLE_TOKEN: "sk-console" }),
		entry: null
	});

	assert.equal(result.status, "ok");
	assert.equal(result.balance.labelKey, "balance.zen");
	assert.equal(result.balance.amount, 5.01495352);
	assert.equal(result.balance.currency, "USD");
	assert.equal(result.balance.source, "credential:OPENCODE_CONSOLE_TOKEN");
	const call = wire.requests.find((request) => request.url.includes("/console/api/billing/status"));
	assert.equal(call.headers.get("authorization"), "Bearer sk-console");
	assert.equal(call.headers.get("x-org-id"), "org-1");
});

test("a failed balance read never hides the OpenCode GO quota", async () => {
	installWire({ console: null });
	const result = await providers.readOpencodeGo({
		config: {
			source: "builtin",
			apiKeyEnv: "OPENCODE_GO_API_KEY",
			baseUrl: "https://opencode.ai/zen/go",
			console: {
				enabled: true,
				apiKeyEnv: "OPENCODE_CONSOLE_TOKEN",
				authFile: "/nonexistent/auth.json",
				dbFile: "/nonexistent/opencode.db",
				baseUrl: "https://opencode.ai"
			}
		},
		resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go", OPENCODE_CONSOLE_TOKEN: "sk-console" }),
		entry: null
	});

	assert.equal(result.status, "ok");
	assert.equal(result.balance, null);
	assert.match(result.meta.balanceError, /403/);
	assert.equal(result.windows.find((window) => window.key === "monthly").percent, 56);
});

test("OpenCode console token falls back to the local auth.json", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	const authFile = join(dir, "auth.json");
	try {
		writeFileSync(authFile, JSON.stringify({
			opencode: { type: "oauth", access: "sk-console-file", metadata: { orgID: "org-file" } }
		}));
		const wire = installWire({ console: { availableMicroCents: "1230000000" } });
		const result = await providers.readOpencodeGo({
			config: {
				source: "builtin",
				apiKeyEnv: "OPENCODE_GO_API_KEY",
				baseUrl: "https://opencode.ai/zen/go",
				console: {
					enabled: true,
					apiKeyEnv: "MISSING_CONSOLE_REF",
					authFile,
					dbFile: join(dir, "missing.db"),
					baseUrl: "https://opencode.ai"
				}
			},
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});
		assert.equal(result.balance.amount, 12.3);
		assert.equal(result.balance.source, "opencode-auth-file");
		const call = wire.requests.find((request) => request.url.includes("/console/api/billing/status"));
		assert.equal(call.headers.get("authorization"), "Bearer sk-console-file");
		assert.equal(call.headers.get("x-org-id"), "org-file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("OpenCode console balance is skipped when disabled or no credential exists", async () => {
	installWire({});
	const disabled = await providers.readOpencodeGo({
		config: {
			source: "builtin",
			apiKeyEnv: "OPENCODE_GO_API_KEY",
			baseUrl: "https://opencode.ai/zen/go",
			console: { enabled: false }
		},
		resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
		entry: null
	});
	assert.equal(disabled.balance, null);
	assert.equal(disabled.meta.balanceError, undefined);

	const missing = await providers.readOpencodeGo({
		config: {
			source: "builtin",
			apiKeyEnv: "OPENCODE_GO_API_KEY",
			baseUrl: "https://opencode.ai/zen/go",
			console: {
				enabled: true,
				apiKeyEnv: "MISSING_CONSOLE_REF",
				authFile: "/nonexistent/auth.json",
				dbFile: "/nonexistent/opencode.db"
			}
		},
		resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
		entry: null
	});
	assert.equal(missing.status, "ok");
	assert.equal(missing.balance, null);
	assert.match(missing.meta.balanceError, /no console credential/);
});
