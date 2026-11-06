// GET/POST /provider-usage/settings: descriptor passthrough, detection,
// revision conflicts, write whitelist and cross-origin refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	callRoute,
	installWire,
	loadHost,
	makeCtx,
	makeSettings
} from "./support/harness.mjs";

const host = await loadHost();

const CREDS = {
	OPENCODE_GO_API_KEY: "sk-go",
	COMMANDCODE_API_KEY: "sk-cc",
	ZAI_API_KEY: "sk-glm"
};

/** Boot one plugin instance with a fake settings service. */
function boot({ config = {}, entries = [], credentialMap = CREDS, settings, port = 1234 } = {}) {
	const wire = installWire({});
	const services = settings === undefined ? {} : { settings };
	const { ctx, routes, commands } = makeCtx({ entries, services, credentialMap, port });
	const resolved = config;
	if (resolved.cacheMs === undefined) resolved.cacheMs = 0;
	if (resolved.commandCodeAuthFile === undefined) resolved.commandCodeAuthFile = "/nonexistent/commandcode-auth.json";
	if (resolved.opencodeConsoleEnabled === undefined) resolved.opencodeConsoleEnabled = false;
	if (resolved.autoUpdate === undefined) resolved.autoUpdate = false;
	host.apply(ctx, resolved);
	return { ctx, routes, commands, config: resolved, wire };
}

const DEFAULTS = {
	opencodeGoEnabled: true,
	commandCodeEnabled: true,
	glmEnabled: true,
	providerOrder: ["glm", "opencode-go", "command-code"]
};

test("GET settings returns the descriptor value, revision and detection", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 7 });
	const { routes } = boot({ settings });
	const res = await callRoute(routes, "/provider-usage/settings");

	assert.equal(res.status, 200);
	assert.equal(res.body.ok, true);
	assert.equal(res.body.namespace, "dsh-multi-provider-usage");
	assert.equal(res.body.revision, 7);
	assert.equal(res.body.value.opencodeGoEnabled, true);
	assert.deepEqual(res.body.detection.providerOrder, ["opencode-go", "command-code", "glm"]);
	assert.deepEqual(res.body.detection.enabled, ["opencode-go", "command-code", "glm"]);

	const detection = res.body.detection.providers;
	assert.equal(detection["opencode-go"].configured, true);
	assert.equal(detection["opencode-go"].credentialRef, "OPENCODE_GO_API_KEY");
	assert.equal(detection["opencode-go"].entryFound, false);
	assert.equal(detection["opencode-go"].fallback.reason, "not-installed");
	assert.equal(detection["command-code"].configured, true);
	assert.equal(detection["command-code"].credentialRef, "COMMANDCODE_API_KEY");
	assert.equal(detection.glm.configured, true);
	assert.equal(detection.glm.credentialRef, "ZAI_API_KEY");
	assert.equal(detection.glm.region, "auto", "the GLM version mode is reported");
});

test("GET settings reports the OpenCode console balance source", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 1 });
	const { routes } = boot({
		settings,
		credentialMap: { ...CREDS, OPENCODE_CONSOLE_TOKEN: "sk-console" },
		config: { opencodeConsoleEnabled: true }
	});
	const res = await callRoute(routes, "/provider-usage/settings");
	assert.equal(res.status, 200);
	const consoleInfo = res.body.detection.providers["opencode-go"].console;
	assert.equal(consoleInfo.enabled, true);
	assert.equal(consoleInfo.configured, true);
	assert.equal(consoleInfo.source, "credential:OPENCODE_CONSOLE_TOKEN");
});

test("GET settings explains an API-key-only or expired OpenCode console login", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-provider-usage-"));
	try {
		const authFile = join(dir, "auth.json");
		const dbFile = join(dir, "missing.db");
		const readConsole = async () => {
			const settings = makeSettings({ value: DEFAULTS, revision: 1 });
			const { routes } = boot({
				settings,
				config: { opencodeConsoleEnabled: true, opencodeConsoleAuthFile: authFile, opencodeConsoleDbFile: dbFile }
			});
			const res = await callRoute(routes, "/provider-usage/settings");
			return res.body.detection.providers["opencode-go"].console;
		};

		writeFileSync(authFile, JSON.stringify({ opencode: { type: "key", key: "oc_sk_service_account" } }));
		const apiKey = await readConsole();
		assert.equal(apiKey.configured, false);
		assert.equal(apiKey.reason, "api-key", "the settings page can explain the API-key login");

		writeFileSync(authFile, JSON.stringify({
			opencode: { type: "oauth", access: "st-expired", expires: Date.now() - 60_000 }
		}));
		const expired = await readConsole();
		assert.equal(expired.configured, true);
		assert.equal(expired.expired, true);
		assert.equal(expired.reason, "expired");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("GET settings marks a provider unconfigured when its credential is missing", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 1 });
	const { routes } = boot({ settings, credentialMap: {} });
	const res = await callRoute(routes, "/provider-usage/settings");
	assert.equal(res.status, 200);
	assert.equal(res.body.detection.providers["command-code"].configured, false);
	assert.equal(res.body.detection.providers.glm.configured, false);
});

test("GET settings returns 503 when the settings service or namespace is absent", async () => {
	const absent = boot({});
	const noService = await callRoute(absent.routes, "/provider-usage/settings");
	assert.equal(noService.status, 503);
	assert.equal(noService.body.ok, false);

	const emptySettings = { describe: () => [], update: async () => {} };
	const noNamespace = boot({ settings: emptySettings });
	const noDescriptor = await callRoute(noNamespace.routes, "/provider-usage/settings");
	assert.equal(noDescriptor.status, 503);
	assert.match(String(noDescriptor.body.hint), /Config/);
});

test("POST settings writes only whitelisted fields and answers with the new revision", async () => {
	const config = { ...DEFAULTS, cacheMs: 0, updateCheck: false, commandCodeAuthFile: "/nonexistent/commandcode-auth.json" };
	const settings = makeSettings({
		value: DEFAULTS,
		revision: 7,
		onUpdate: (patch, next) => {
			Object.assign(config, next);
		}
	});
	const { routes } = boot({ settings, config });
	const res = await callRoute(routes, "/provider-usage/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			patch: {
				commandCodeEnabled: false,
				providerOrder: ["glm", "bogus", "opencode-go", "glm"],
				apiKeyEnv: "HACKED",
				baseUrl: "https://evil.example",
				notAField: true
			},
			expectedRevision: 7
		})
	});

	assert.equal(res.status, 200);
	assert.equal(res.body.ok, true);
	assert.equal(res.body.revision, 8);
	assert.equal(settings.updates.length, 1);
	assert.deepEqual(settings.updates[0].patch, {
		commandCodeEnabled: false,
		providerOrder: ["glm", "opencode-go", "command-code"]
	});
	assert.deepEqual(res.body.detection.enabled, ["opencode-go", "glm"]);
	assert.deepEqual(res.body.detection.providerOrder, ["glm", "opencode-go", "command-code"]);
});

test("POST settings accepts the console balance fields", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 4 });
	const { routes } = boot({ settings });
	const res = await callRoute(routes, "/provider-usage/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			patch: {
				opencodeConsoleEnabled: false,
				opencodeConsoleApiKeyEnv: "MY_OPENCODE_CONSOLE_TOKEN",
				opencodeConsoleOrgId: "org_123",
				opencodeConsoleAuthFile: "/tmp/auth.json",
				opencodeConsoleDbFile: "/tmp/opencode.db",
				opencodeConsoleBaseUrl: "https://console.example"
			},
			expectedRevision: 4
		})
	});
	assert.equal(res.status, 200);
	assert.deepEqual(settings.updates[0].patch, {
		opencodeConsoleEnabled: false,
		opencodeConsoleApiKeyEnv: "MY_OPENCODE_CONSOLE_TOKEN",
		opencodeConsoleOrgId: "org_123",
		opencodeConsoleAuthFile: "/tmp/auth.json",
		opencodeConsoleDbFile: "/tmp/opencode.db",
		opencodeConsoleBaseUrl: "https://console.example"
	});
});

test("POST settings accepts the GLM Code Plan version", async () => {
	const config = { ...DEFAULTS, cacheMs: 0, updateCheck: false, commandCodeAuthFile: "/nonexistent/commandcode-auth.json" };
	const settings = makeSettings({
		value: DEFAULTS,
		revision: 2,
		onUpdate: (patch, next) => {
			Object.assign(config, next);
		}
	});
	const { routes } = boot({ settings, config });
	const res = await callRoute(routes, "/provider-usage/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ patch: { glmRegion: "zai" }, expectedRevision: 2 })
	});

	assert.equal(res.status, 200);
	assert.deepEqual(settings.updates[0].patch, { glmRegion: "zai" });
	assert.equal(res.body.detection.providers.glm.region, "zai");
	assert.equal(res.body.detection.providers.glm.baseUrl, "https://api.z.ai");
});

test("POST settings rejects an empty or invalid patch", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 2 });
	const { routes } = boot({ settings });
	const res = await callRoute(routes, "/provider-usage/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ patch: { nonsense: 1 }, expectedRevision: 2 })
	});
	assert.equal(res.status, 400);
	assert.match(res.body.error, /missing or invalid/);
});

test("a stale expectedRevision yields 409 with the current revision", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 9 });
	const { routes } = boot({ settings });
	const res = await callRoute(routes, "/provider-usage/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ patch: { glmEnabled: false }, expectedRevision: 3 })
	});
	assert.equal(res.status, 409);
	assert.equal(res.body.conflict, true);
	assert.equal(res.body.currentRevision, 9);
});

test("a cross-origin settings write is refused", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 1 });
	const { routes } = boot({ settings });
	const res = await callRoute(routes, "/provider-usage/settings", {
		method: "POST",
		headers: { origin: "https://evil.example", "content-type": "application/json" },
		body: JSON.stringify({ patch: { glmEnabled: false }, expectedRevision: 1 })
	});
	assert.equal(res.status, 403);
	assert.equal(settings.updates.length, 0);
});

test("the command is registered and renders all providers", async () => {
	const settings = makeSettings({ value: DEFAULTS, revision: 1 });
	const { commands } = boot({ settings });
	const command = commands.find((candidate) => candidate.name === "provider-usage");
	assert.ok(command !== undefined);
	const result = await command.handler();
	assert.equal(result.kind, "success");
	assert.match(result.text, /OpenCode GO/);
	assert.match(result.text, /Command Code/);
	assert.match(result.text, /GLM Code Plan/);
	assert.match(result.text, /充值余额/);
});

test("saving settings clears the usage cache so a changed apikey is served fresh", async () => {
	const config = { ...DEFAULTS, cacheMs: 60_000, updateCheck: false, commandCodeAuthFile: "/nonexistent/commandcode-auth.json" };
	const settings = makeSettings({
		value: DEFAULTS,
		revision: 3,
		onUpdate: (patch, next) => {
			Object.assign(config, next);
		}
	});
	const { routes, wire } = boot({ settings, config });
	const upstreamReads = () => wire.requests.filter((request) =>
		request.url.includes("/v1/usage")
		|| request.url.includes("api.commandcode.ai")
		|| request.url.includes("api.z.ai")
		|| request.url.includes("open.bigmodel.cn")).length;

	await callRoute(routes, "/provider-usage/usage");
	const first = upstreamReads();
	assert.ok(first >= 3, "the first read reaches every enabled provider");

	await callRoute(routes, "/provider-usage/usage");
	assert.equal(upstreamReads(), first, "the TTL serves the immediate follow-up read from cache");

	const saved = await callRoute(routes, "/provider-usage/settings", {
		method: "POST",
		headers: { "content-type": "application/json", origin: "http://127.0.0.1:1234" },
		body: JSON.stringify({ patch: { glmEnabled: true }, expectedRevision: 3 })
	});
	assert.equal(saved.status, 200);

	await callRoute(routes, "/provider-usage/usage");
	assert.ok(upstreamReads() > first, "a save must drop the cache so the next read hits upstream with the saved credentials");
});
