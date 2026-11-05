// GET/POST /provider-usage/settings: descriptor passthrough, detection,
// revision conflicts, write whitelist and cross-origin refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
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
	installWire({});
	const services = settings === undefined ? {} : { settings };
	const { ctx, routes, commands } = makeCtx({ entries, services, credentialMap, port });
	const resolved = config;
	if (resolved.cacheMs === undefined) resolved.cacheMs = 0;
	if (resolved.updateCheck === undefined) resolved.updateCheck = false;
	if (resolved.commandCodeAuthFile === undefined) resolved.commandCodeAuthFile = "/nonexistent/commandcode-auth.json";
	if (resolved.opencodeConsoleEnabled === undefined) resolved.opencodeConsoleEnabled = false;
	host.apply(ctx, resolved);
	return { ctx, routes, commands, config: resolved };
}

const DEFAULTS = {
	opencodeGoEnabled: true,
	commandCodeEnabled: true,
	glmEnabled: true,
	defaultProvider: "auto"
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
	assert.equal(res.body.detection.defaultProvider, "auto");
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
				defaultProvider: "glm",
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
	assert.deepEqual(settings.updates[0].patch, { commandCodeEnabled: false, defaultProvider: "glm" });
	assert.deepEqual(res.body.detection.enabled, ["opencode-go", "glm"]);
	assert.equal(res.body.detection.defaultProvider, "glm");
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
