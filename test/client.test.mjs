// Client-bundle contract: module-loader id, slot registrations, the view
// boundary, exported components and the no-top-level-globals constraint.
// The bundle is a plain factory, so a small window/react stub can load it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { loadHost, readClientText } from "./support/harness.mjs";

const host = await loadHost();
const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));

// ── browser shell stubs ────────────────────────────────────────────────────
const styleTags = [];
globalThis.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, textContent: "" }),
	head: { appendChild: (tag) => styleTags.push(tag) }
};

let captured = null;
globalThis.window = {
	__ModuleLoader__: {
		load: (entry) => { captured = entry; }
	}
};

/** Minimal hook implementation: enough to construct elements, no effects. */
function installHooks() {
	const states = [];
	let cursor = 0;
	return {
		reset() { cursor = 0; states.length = 0; },
		rewind() { cursor = 0; },
		seed(index, value) { states[index] = value; },
		useState(initial) {
			const index = cursor++;
			if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
			return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
		},
		useEffect() {},
		useRef(initial) { return { current: initial }; },
		useCallback(fn) { return fn; },
		Fragment: Symbol("Fragment")
	};
}

const react = installHooks();
const jsxRuntime = {
	jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
	jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
	Fragment: react.Fragment
};

const code = readFileSync(path.resolve("lib/client.js"), "utf8");
const factory = new Function("window", "document", "require", code);
factory(globalThis.window, globalThis.document, (specifier) => {
	if (specifier === "react") return react;
	if (specifier === "react/jsx-runtime") return jsxRuntime;
	throw new Error(`unexpected require in client bundle: ${specifier}`);
});

function loadExports() {
	return captured.factory((specifier) => {
		if (specifier === "react") return react;
		if (specifier === "react/jsx-runtime") return jsxRuntime;
		throw new Error(specifier);
	});
}

test("the bundle registers under the package name", () => {
	assert.ok(captured !== null, "window.__ModuleLoader__.load was called");
	assert.equal(captured.id, pkg.name);
	assert.equal(typeof captured.factory, "function");
});

test("apply registers the sidebar widget and the Plugins-panel config page", () => {
	const exports = loadExports();
	const registrations = [];
	const locales = [];
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register: (ns, tables) => { locales.push({ ns, tables }); return () => {}; } },
		slots: {
			inject: (_name, callback) => { callback(); },
			register: (options, component) => {
				registrations.push({ options, component });
				return () => {};
			}
		}
	};
	exports.apply(ctx);

	assert.deepEqual(locales.map((entry) => entry.ns), ["dsh-multi-provider-usage"]);
	assert.ok(locales[0].tables.zh["widget.brand"]);
	assert.ok(locales[0].tables.en["widget.brand"]);

	const widget = registrations.find((entry) => entry.options.name === "sidebar.footer.action");
	assert.ok(widget !== undefined, "sidebar.footer.action registered");
	assert.equal(widget.options.id, pkg.name);

	const config = registrations.find((entry) => entry.options.name === "plugins.bundle.config");
	assert.ok(config !== undefined, "plugins.bundle.config registered");
	assert.equal(config.options.key, pkg.name, "the config cell is keyed by the package name");
	assert.equal(config.options.locale, "dsh-multi-provider-usage");
});

test("summary view is a plain string; page view mounts the settings page", () => {
	const exports = loadExports();
	const summary = exports.BundleConfig({ view: "summary" });
	assert.equal(typeof summary, "string");
	assert.ok(summary.length > 0);

	const page = exports.BundleConfig({ view: "page" });
	assert.ok(page !== null && typeof page === "object", "page view returns an element");
	assert.equal(page.type, exports.SettingsPage);

	react.reset();
	const loading = exports.SettingsPage({});
	assert.ok(loading !== null && typeof loading === "object");
	assert.equal(loading.props.style.display, "flex");
});

test("the widget renders a collapsed rail and an expanded panel", () => {
	const exports = loadExports();
	react.reset();
	const rail = exports.Widget({ wide: false, t: (key) => key });
	assert.equal(rail.type, "div");
	assert.equal(rail.props.className, "dpu-rail");
	assert.ok(typeof rail.props.title === "string");

	react.reset();
	const panel = exports.Widget({ wide: true, t: (key) => key });
	assert.equal(panel.type, "div");
	assert.equal(panel.props.className, "dpu-widget");
});

test("all providers render in one column and each header collapses independently", () => {
	const exports = loadExports();
	const provider = (id, name, percent, amount) => ({
		id,
		name,
		short: id,
		status: "ok",
		account: { name: "", ref: "REF", id: null },
		plan: null,
		fallback: null,
		balance: { amount, currency: "USD", labelKey: "balance.extra", source: "test" },
		windows: [{ key: "monthly", labelKey: "window.monthly", percent, status: "ok", resetsAt: null, windowMs: null }],
		meta: {}
	});
	const data = {
		providers: [
			provider("opencode-go", "OpenCode GO", 56, 4.88),
			provider("command-code", "Command Code", 51.9, 7.44),
			provider("glm", "GLM Code Plan", 12.3, 0)
		],
		defaultProvider: "auto",
		autoUpdate: { status: "updated", restartRequired: true, version: "0.3.1" }
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());

	const first = exports.Widget({ wide: true, t: (key) => key });
	const providers = first.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	assert.equal(providers.props.children.length, 3);
	const names = providers.props.children.map((section) => section.props.children[0].props.children[2].props.children);
	assert.deepEqual(names, ["OpenCode GO", "Command Code", "GLM Code Plan"]);
	assert.match(JSON.stringify(first), /autoUpdate\.updated/);
	const firstSection = providers.props.children[0];
	const head = firstSection.props.children[0];
	assert.equal(head.props.className, "dpu-provider-head");
	assert.equal(head.props["aria-expanded"], true);
	assert.ok(firstSection.props.children[1] !== null, "expanded by default");

	head.props.onClick();
	react.rewind();
	const second = exports.Widget({ wide: true, t: (key) => key });
	const secondProviders = second.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	assert.equal(secondProviders.props.children[0].props.children[1], null, "clicked header collapsed only its body");
	assert.ok(secondProviders.props.children[1].props.children[1] !== null, "sibling stays expanded");
});

test("balance deltas are computed from the turn-start snapshot", () => {
	const exports = loadExports();
	const baseline = { "opencode-go": { amount: 5.14, currency: "USD" } };
	const current = { id: "opencode-go", balance: { amount: 4.88, currency: "USD" } };
	const change = exports.balanceChangeFor(baseline, current);
	assert.deepEqual(change, { amount: -0.26, currency: "USD", from: 5.14, to: 4.88 });
	assert.equal(exports.formatSignedMoney(change), "-$0.26");
	assert.equal(exports.formatSignedMoney({ amount: 1.5, currency: "USD" }), "+$1.50");
	assert.equal(exports.formatSignedMoney({ amount: 0, currency: "USD" }), "$0.00");
	assert.equal(exports.balanceChangeFor(null, current), null);
	assert.equal(exports.balanceChangeFor(baseline, { id: "glm", status: "error" }), null);
});

test("turn events collect only quota-provider usage and fire on turn end", () => {
	const exports = loadExports();
	let state = { used: new Set(), show: null };
	const apply = (event) => { state = exports.turnUsageStep(state.used, event); };
	apply({ type: "turn/start" });
	apply({ type: "assistant/message", data: { message: { source: { provider: "deepseek-official" } } } });
	assert.deepEqual(state.show, null);
	apply({ type: "assistant/message", data: { message: { source: { provider: "opencode-go" } } } });
	apply({ type: "assistant/message", data: { message: { source: { provider: "zai-coding-cn" } } } });
	apply({ type: "turn/end" });
	assert.deepEqual(state.show, ["opencode-go", "glm"]);
	assert.equal(state.used.size, 0);
	apply({ type: "turn/start" });
	apply({ type: "turn/end" });
	assert.equal(state.show, null, "empty turns do not pop up");
});

test("provider routes map to the three quota providers", () => {
	const exports = loadExports();
	assert.equal(exports.usageProviderFor("opencode-go"), "opencode-go");
	assert.equal(exports.usageProviderFor("opencode"), "opencode-go");
	assert.equal(exports.usageProviderFor("zai-coding-cn"), "glm");
	assert.equal(exports.usageProviderFor("z-ai"), "glm");
	assert.equal(exports.usageProviderFor("command-code"), "command-code");
	assert.equal(exports.usageProviderFor("commandcode"), "command-code");
	assert.equal(exports.usageProviderFor("deepseek-official"), null);
	assert.equal(exports.usageProviderFor(""), null);
});

test("the turn-usage card registers in the shell overlay and renders windows", () => {
	const exports = loadExports();
	const registrations = [];
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register: () => () => {} },
		slots: {
			inject: (_name, callback) => { callback(); },
			register: (options, component) => {
				registrations.push({ options, component });
				return () => {};
			}
		},
		get: (name) => name === "sessions"
			? { binding: () => null }
			: name === "uiSession"
				? { current: { getSnapshot: () => ({ key: undefined }), subscribe: () => () => {} } }
				: undefined
	};
	exports.apply(ctx);
	const toast = registrations.find((entry) => entry.options.name === "shell.overlay");
	assert.ok(toast !== undefined, "shell.overlay registered");
	assert.equal(toast.options.id, pkg.name + ":turn-usage");

	react.reset();
	react.seed(0, "session-1");
	react.seed(1, {
		status: "ready",
		providers: [{
			id: "opencode-go",
			name: "OpenCode GO",
			status: "ok",
			balance: { amount: 4.88, currency: "USD" },
			balanceChange: { amount: -0.26, currency: "USD", from: 5.14, to: 4.88 },
			windows: [
				{ key: "rolling", percent: 0, status: "ok" },
				{ key: "weekly", percent: 0, status: "ok" },
				{ key: "monthly", percent: 100, status: "rate-limited" }
			]
		}]
	});
	const Component = exports.createTurnUsageToast({ sessions: {}, uiSession: {} });
	const card = Component({ t: (key) => key });
	assert.equal(card.type, "div");
	assert.equal(card.props.className, "dpu-toast");
	const text = JSON.stringify(card);
	assert.match(text, /OpenCode GO/);
	assert.match(text, /turnUsage.window.5h/);
	assert.match(text, /dpu-toast-window dpu-over/);
	assert.match(text, /turnUsage.balanceChange/);
	assert.match(text, /-\$0\.26/);
});

test("top-level bundle code does not collide with another plugin's globals", () => {
	// The shell evaluates every client bundle as a classic script in one shared
	// global lexical scope. Another plugin may declare `PACKAGE_NAME` at top
	// level; ours must keep its identifiers factory-local.
	const context = vm.createContext({
		window: { __ModuleLoader__: { load() {} } }
	});
	vm.runInContext('var PACKAGE_NAME = "@astervolans/dsh-opencode-go-usage"; var CONFIG_KEY = PACKAGE_NAME;', context);
	assert.doesNotThrow(
		() => vm.runInContext(code, context),
		"client bundle must not declare top-level lexical identifiers"
	);
});

test("host and client agree on the routes and provider ids", async () => {
	const text = await readClientText();
	assert.ok(text.includes(host.PROVIDER_USAGE_INFO.usageRoute), "client polls the usage route");
	assert.ok(text.includes(host.PROVIDER_USAGE_INFO.settingsRoute), "client calls the settings route");
	for (const id of host.PROVIDER_USAGE_INFO.providerIds) {
		assert.ok(text.includes(`"${id}"`), `client mentions provider ${id}`);
	}
	assert.ok(text.includes("plugins.bundle.config"), "client uses the official config slot");
	assert.ok(text.includes("sidebar.footer.action"), "client uses the sidebar footer slot");
});
