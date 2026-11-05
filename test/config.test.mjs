// Config schema and normalizers: the public knobs stay backward compatible and
// every field is volatile (DSH 2.x exposes those through settings.describe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHost } from "./support/harness.mjs";

const host = await loadHost();

test("the exported Config schema carries every provider knob", () => {
	const dict = host.Config.dict;
	assert.ok(dict && typeof dict === "object");
	for (const key of [
		"opencodeGoEnabled",
		"opencodeGoSource",
		"opencodeGoApiKeyEnv",
		"opencodeGoBaseUrl",
		"opencodeConsoleEnabled",
		"opencodeConsoleApiKeyEnv",
		"opencodeConsoleOrgId",
		"opencodeConsoleAuthFile",
		"opencodeConsoleDbFile",
		"opencodeConsoleBaseUrl",
		"commandCodeEnabled",
		"commandCodeApiKeyEnv",
		"commandCodeBaseUrl",
		"commandCodeAuthFile",
		"glmEnabled",
		"glmApiKeyEnv",
		"glmBaseUrl",
		"glmRegion",
		"cacheMs",
		"updateCheck",
		"autoUpdate",
		"autoUpdateCheckHours",
		"injectSessionHeader",
		"defaultProvider"
	]) {
		assert.ok(Object.hasOwn(dict, key), `Config has ${key}`);
	}
});

test("normalizers are closed sets with documented defaults", () => {
	assert.equal(host.normalizeOpencodeGoSource("builtin"), "builtin");
	assert.equal(host.normalizeOpencodeGoSource("bogus"), "opencode-go");
	assert.equal(host.normalizeDefaultProvider("glm"), "glm");
	assert.equal(host.normalizeDefaultProvider("bogus"), "auto");
	assert.equal(host.normalizeGlmRegion("bigmodel"), "bigmodel");
	assert.equal(host.normalizeGlmRegion("bogus"), "auto");
});

test("the exported runtime info names the routes and command", () => {
	assert.equal(host.PROVIDER_USAGE_INFO.usageRoute, "/provider-usage/usage");
	assert.equal(host.PROVIDER_USAGE_INFO.settingsRoute, "/provider-usage/settings");
	assert.equal(host.PROVIDER_USAGE_INFO.commandName, "provider-usage");
	assert.deepEqual(host.PROVIDER_USAGE_INFO.providerIds, ["opencode-go", "command-code", "glm"]);
});
