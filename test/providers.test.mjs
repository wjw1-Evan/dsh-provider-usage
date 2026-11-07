// Provider adapters: canonical shapes, vendor quirks and fallback paths.
// Every test uses the hermetic wire from support/harness.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commandCodeFixture,
	glmFixture,
	installWire,
	jsonResponse,
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

test("GLM base kinds tell the international and China versions apart", () => {
	assert.equal(providers.glmBaseKind("https://api.z.ai"), "zai");
	assert.equal(providers.glmBaseKind("https://open.bigmodel.cn/"), "bigmodel");
	assert.equal(providers.glmBaseKind("https://glm.example.test"), "custom");
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
	assert.equal(monthly.tokensUsed, 1977073179, "the billing-period token count rides on the monthly window");
	const fiveHour = result.windows.find((window) => window.key === "five-hour");
	assert.equal("tokensUsed" in fiveHour, false, "no vendor reports 5h tokens; the field stays absent");
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

test("readCommandCode falls back to tokensIn + tokensOut when the summary omits totalTokens", async () => {
	const fixture = commandCodeFixture();
	installWire({
		commandCode: {
			...fixture,
			summary: { ...fixture.summary, totalTokens: undefined, totalTokensIn: 1000, totalTokensOut: 2000 }
		}
	});
	const result = await providers.readCommandCode({
		config: { apiKeyEnv: "COMMANDCODE_API_KEY" },
		resolveCredential: resolver({ COMMANDCODE_API_KEY: "sk-cc" })
	});
	const monthly = result.windows.find((body) => body.key === "monthly");
	assert.equal(monthly.tokensUsed, 3000, "in + out fills in for a missing combined field");
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

test("a Command Code credits failure names the cause instead of a generic empty response", async () => {
	installWire({ commandCodeFail: "/alpha/billing/credits" });
	await assert.rejects(
		providers.readCommandCode({
			config: { apiKeyEnv: "COMMANDCODE_API_KEY" },
			resolveCredential: resolver({ COMMANDCODE_API_KEY: "sk-cc" })
		}),
		(error) => {
			assert.equal(error.code, "invalid-response");
			assert.match(error.message, /no usable quota windows/);
			assert.match(error.message, /alpha\/billing\/credits 500/, "the underlying 500 is part of the message");
			assert.match(error.meta.balanceError, /^Command Code balance: .*credits/, "the header badge can explain the missing balance");
			return true;
		}
	);
});

test("a Command Code credits response without top-up pools reports no balance", async () => {
	const fixture = commandCodeFixture();
	installWire({
		commandCode: {
			...fixture,
			credits: { credits: { monthlyCredits: 34.9 }, windowLimits: fixture.credits.windowLimits }
		}
	});
	const result = await providers.readCommandCode({
		config: { apiKeyEnv: "COMMANDCODE_API_KEY" },
		resolveCredential: resolver({ COMMANDCODE_API_KEY: "sk-cc" })
	});
	assert.equal(result.status, "ok");
	assert.ok(result.windows.length > 0, "the quota windows still render");
	assert.equal(result.balance, null);
	assert.equal(result.meta.balanceMissing, true);
	assert.equal(result.meta.balanceError, undefined);
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
	assert.equal(result.meta.regionKind, "bigmodel", "the answered version travels with the payload");
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

test("readGlm names both GLM versions when neither has a Coding Plan", async () => {
	const msg = "当前用户不存在coding plan";
	installWire({ glm: { zai: { success: false, msg }, bigmodel: { success: false, msg } } });
	await assert.rejects(
		providers.readGlm({
			config: { apiKeyEnv: "ZAI_API_KEY", region: "auto", locale: "zh" },
			resolveCredential: resolver({ ZAI_API_KEY: "sk-glm" })
		}),
		(error) => {
			assert.equal(error.code, "api-error");
			assert.match(error.message, /国际版和国内版都返回/);
			assert.match(error.message, new RegExp(msg));
			assert.equal(error.meta.attempts.length, 2, "each probed version is recorded");
			assert.deepEqual(error.meta.attempts.map((attempt) => attempt.kind), ["zai", "bigmodel"]);
			return true;
		}
	);
});

test("readGlm lists each version's own answer in English when they differ", async () => {
	installWire({ glm: { zai: { success: false, msg: "invalid token" }, bigmodel: { success: false, msg: "no plan" } } });
	await assert.rejects(
		providers.readGlm({
			config: { apiKeyEnv: "ZAI_API_KEY", region: "auto", locale: "en" },
			resolveCredential: resolver({ ZAI_API_KEY: "sk-glm" })
		}),
		(error) => /international \(api\.z\.ai\): invalid token/.test(error.message)
			&& /China \(open\.bigmodel\.cn\): no plan/.test(error.message)
			&& /GLM Code Plan: international/.test(error.message)
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

/** Write an OpenCode-shaped credential database for the balance tests. */
function writeOpencodeDb(path, grants) {
	const db = new DatabaseSync(path);
	try {
		db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)");
		const insert = db.prepare("INSERT INTO credential (id, integration_id, value, active, time_created) VALUES (?, ?, ?, ?, ?)");
		grants.forEach((entry, index) => {
			const grant = entry.grant ?? entry;
			insert.run(`cred-${index}`, "opencode", JSON.stringify(grant), entry.active ?? 1, Date.now() + index);
		});
	} finally {
		db.close();
	}
}

/** Provider config for an OpenCode GO balance test. */
function opencodeGoConfig(consoleConfig) {
	return {
		source: "builtin",
		apiKeyEnv: "OPENCODE_GO_API_KEY",
		baseUrl: "https://opencode.ai/zen/go",
		console: { enabled: true, apiKeyEnv: "MISSING_CONSOLE_REF", ...consoleConfig }
	};
}

test("a stale legacy auth.json token does not shadow the live database grant", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	const authFile = join(dir, "auth.json");
	const dbFile = join(dir, "opencode.db");
	try {
		writeFileSync(authFile, JSON.stringify({
			opencode: { type: "oauth", access: "st-stale", metadata: { orgID: "org-stale" } }
		}));
		writeOpencodeDb(dbFile, [
			{ type: "oauth", access: "st-live", metadata: { orgID: "org-live", server: "https://opencode.ai/console" } }
		]);
		const wire = installWire({ console: { availableMicroCents: "2500000000" } });
		const wireFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const authorization = new Headers(init?.headers).get("authorization");
			if (String(input).includes("/console/api/billing/status") && authorization === "Bearer st-stale") {
				return jsonResponse({ _tag: "Unauthorized" }, 401);
			}
			return wireFetch(input, init);
		};

		const result = await providers.readOpencodeGo({
			config: opencodeGoConfig({ authFile, dbFile, baseUrl: "https://opencode.ai" }),
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});

		assert.equal(result.balance.amount, 25);
		assert.equal(result.balance.source, "opencode-db", "the live database grant wins over the stale file");
		const calls = wire.requests.filter((request) => request.url.includes("/console/api/billing/status"));
		assert.equal(calls.length, 1, "the stale auth.json token is never sent first");
		assert.equal(calls[0].headers.get("authorization"), "Bearer st-live");
		assert.equal(calls[0].headers.get("x-org-id"), "org-live");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rejected database grant falls back to the next console credential", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	const authFile = join(dir, "auth.json");
	const dbFile = join(dir, "opencode.db");
	try {
		writeFileSync(authFile, JSON.stringify({
			opencode: { type: "oauth", access: "st-fresh", metadata: { orgID: "org-file" } }
		}));
		writeOpencodeDb(dbFile, [
			{ type: "oauth", access: "st-revoked", metadata: { orgID: "org-db" } }
		]);
		installWire({ console: { availableMicroCents: "2500000000" } });
		const wireFetch = globalThis.fetch;
		const consoleCalls = [];
		globalThis.fetch = async (input, init) => {
			const authorization = new Headers(init?.headers).get("authorization");
			if (String(input).includes("/console/api/billing/status")) consoleCalls.push(authorization);
			if (String(input).includes("/console/api/billing/status") && authorization === "Bearer st-revoked") {
				return jsonResponse({ _tag: "Unauthorized" }, 401);
			}
			return wireFetch(input, init);
		};

		const result = await providers.readOpencodeGo({
			config: opencodeGoConfig({ authFile, dbFile, baseUrl: "https://opencode.ai" }),
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});

		assert.equal(result.balance.amount, 25);
		assert.equal(result.balance.source, "opencode-auth-file");
		assert.deepEqual(consoleCalls, ["Bearer st-revoked", "Bearer st-fresh"], "a 401 retries on the next candidate");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a revoked (active=0) database grant is never sent to the billing endpoint", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	const authFile = join(dir, "auth.json");
	const dbFile = join(dir, "opencode.db");
	try {
		// A revoked grant plus a live auth.json session: the file grant answers.
		writeOpencodeDb(dbFile, [
			{ grant: { type: "oauth", access: "st-revoked", metadata: { orgID: "org-db" } }, active: 0 }
		]);
		writeFileSync(authFile, JSON.stringify({
			opencode: { type: "oauth", access: "st-live", metadata: { orgID: "org-live" } }
		}));
		const wire = installWire({ console: { availableMicroCents: "2500000000" } });
		const result = await providers.readOpencodeGo({
			config: opencodeGoConfig({ authFile, dbFile, baseUrl: "https://opencode.ai" }),
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});
		assert.equal(result.balance.amount, 25);
		assert.equal(result.balance.source, "opencode-auth-file");
		const calls = wire.requests.filter((request) => request.url.includes("/console/api/billing/status"));
		assert.equal(calls.length, 1, "the revoked grant is not sent to the console");
		assert.equal(calls[0].headers.get("authorization"), "Bearer st-live");

		// A revoked grant alone reads as logged out, not as an expired session.
		rmSync(dbFile);
		writeOpencodeDb(dbFile, [
			{ grant: { type: "oauth", access: "st-revoked", metadata: { orgID: "org-db" } }, active: 0 }
		]);
		rmSync(authFile);
		installWire({});
		const loggedOut = await providers.readOpencodeGo({
			config: opencodeGoConfig({ authFile, dbFile, baseUrl: "https://opencode.ai" }),
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});
		assert.equal(loggedOut.status, "ok", "the missing balance never hides the quota");
		assert.equal(loggedOut.meta.balanceSetup, "no-credential", "a revoked-only store reads as logged out");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an API-key-only OpenCode login is reported as an actionable setup state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	const authFile = join(dir, "auth.json");
	try {
		writeFileSync(authFile, JSON.stringify({
			opencode: { type: "key", key: "oc_sk_service_account" }
		}));
		const wire = installWire({});
		const result = await providers.readOpencodeGo({
			config: opencodeGoConfig({ authFile, dbFile: join(dir, "missing.db") }),
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});

		assert.equal(result.status, "ok", "the missing console balance never hides the quota");
		assert.equal(result.balance, null);
		assert.equal(result.meta.balanceSetup, "api-key");
		assert.match(result.meta.balanceError, /API key/);
		assert.match(result.meta.balanceError, /opencode auth login/);
		assert.equal(
			wire.requests.filter((request) => request.url.includes("/console/api/billing/status")).length,
			0,
			"an API key is not sent to the console billing endpoint that rejects it"
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the console host recorded in the grant is used for the billing request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	const authFile = join(dir, "auth.json");
	try {
		writeFileSync(authFile, JSON.stringify({
			opencode: {
				type: "oauth",
				access: "st-custom",
				metadata: { orgID: "org-custom", server: "https://console.example.com/console" }
			}
		}));
		const wire = installWire({ console: { availableMicroCents: "100000000" } });
		const result = await providers.readOpencodeGo({
			config: opencodeGoConfig({ authFile, dbFile: join(dir, "missing.db"), baseUrl: "https://opencode.ai" }),
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});

		assert.equal(result.balance.amount, 1);
		const call = wire.requests.find((request) => request.url.includes("/console/api/billing/status"));
		assert.equal(call.url, "https://console.example.com/console/api/billing/status");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a channel database (opencode-beta.db) is discovered when opencode.db is absent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	try {
		writeOpencodeDb(join(dir, "opencode-beta.db"), [
			{ type: "oauth", access: "st-beta", metadata: { orgID: "org-beta" } }
		]);
		installWire({ console: { availableMicroCents: "1230000000" } });
		const result = await providers.readOpencodeGo({
			config: opencodeGoConfig({ authFile: join(dir, "missing-auth.json"), dbFile: "" }),
			resolveCredential: resolver({ OPENCODE_GO_API_KEY: "sk-go" }),
			entry: null
		});

		assert.equal(result.balance.amount, 12.3);
		assert.equal(result.balance.source, "opencode-db");
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
