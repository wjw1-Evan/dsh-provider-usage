// Fiber lifecycle: routes and commands are owned by ctx.effect, so a plugin
// reload disposes them cleanly; a leaked pre-fix route is repaired first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installWire, loadHost, makeCtx } from "./support/harness.mjs";

const host = await loadHost();

const CREDS = { OPENCODE_GO_API_KEY: "sk-go", COMMANDCODE_API_KEY: "sk-cc", ZAI_API_KEY: "sk-glm" };

function boot() {
	installWire({});
	const { ctx, routes, commands, listeners, effects, warns, exact, disposeAll } = makeCtx({
		credentialMap: CREDS,
		port: 1234
	});
	const config = { cacheMs: 0, updateCheck: false, autoUpdate: false, commandCodeAuthFile: "/nonexistent/auth.json" };
	host.apply(ctx, config);
	return { ctx, routes, commands, listeners, effects, warns, exact, disposeAll, config };
}

test("routes and commands are disposed with their fiber", () => {
	const first = boot();
	assert.deepEqual(first.routes.map((route) => route.path).sort(), ["/provider-usage/settings", "/provider-usage/usage"]);
	assert.equal(first.commands.length, 1);
	assert.equal(first.listeners.length, 1);
	assert.equal(first.effects.length, 4);

	first.disposeAll();
	assert.equal(first.routes.length, 0);
	assert.equal(first.commands.length, 0);
	assert.equal(first.listeners.length, 0);

	// A second apply in the same context must not hit duplicate routes.
	const { ctx } = first;
	const config = { ...first.config };
	host.apply(ctx, config);
	assert.equal(first.routes.length, 2);
	assert.equal(first.commands.length, 1);
	assert.equal(first.listeners.length, 1);
});

test("a stale route leaked by an older build is repaired before registration", () => {
	installWire({});
	const { ctx, routes, exact } = makeCtx({ credentialMap: CREDS, port: 1234 });
	// Simulate a route row left behind outside the fiber: registration did not
	// go through `webServer.register`, so no disposer owns it.
	exact.set("/provider-usage/usage", { kind: "exact", path: "/provider-usage/usage", handler: () => {} });
	assert.doesNotThrow(() => host.apply(ctx, { cacheMs: 0, updateCheck: false, autoUpdate: false, commandCodeAuthFile: "/nonexistent/auth.json" }));
	assert.equal(routes.length, 2);
	assert.notEqual(exact.get("/provider-usage/usage").handler, undefined);
});

test("a command leaked by an older instance only warns", () => {
	installWire({});
	const { ctx, routes, warns } = makeCtx({ credentialMap: CREDS, port: 1234 });
	ctx.commands.register({ name: "provider-usage", description: "leaked", handler: async () => ({ kind: "success", text: "" }) });
	assert.doesNotThrow(() => host.apply(ctx, { cacheMs: 0, updateCheck: false, autoUpdate: false, commandCodeAuthFile: "/nonexistent/auth.json" }));
	assert.equal(routes.length, 2, "the widget routes still register");
	assert.ok(warns.some((message) => /still owned/.test(message)), warns.join("\n"));
});
