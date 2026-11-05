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
	assert.equal(locales[0].tables.zh["window.rolling"], "5 小时窗口");
	assert.equal(locales[0].tables.zh["window.five-hour"], "5 小时窗口");
	assert.equal(locales[0].tables.zh["cfg.invite"], "推广链接");
	assert.equal(locales[0].tables.en["cfg.invite"], "Referral link");
	assert.ok(locales[0].tables.zh["cfg.invite.copy"]);
	assert.ok(locales[0].tables.en["cfg.invite.copy"]);

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
	data.providers[0].fallback = { from: "opencode-go", reason: "not-installed", message: "fixture" };
	data.providers[1].account = { name: "Evan", ref: "REF", id: null };
	data.providers[1].plan = { id: "individual-goat", name: "GOAT", status: "active" };
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());
	react.seed(4, { "opencode-go": { amount: -0.26, currency: "USD", from: 5.14, to: 4.88 } });

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
	assert.match(JSON.stringify(head), /dpu-badge/, "the fallback badge belongs in the header");
	assert.match(JSON.stringify(head), /dpu-provider-balance dpu-hit/, "the balance value pulses");
	assert.match(JSON.stringify(head), /dpu-balance-float dpu-down-text/, "the delta flies away in red");
	assert.match(JSON.stringify(head), /-0\.26/, "the flying delta is compact");
	assert.doesNotMatch(JSON.stringify(firstSection.props.children[1]), /dpu-sub/, "metadata must not wrap to a second line");
	assert.ok(firstSection.props.children[1] !== null, "expanded by default");

	head.props.onClick();
	react.rewind();
	const second = exports.Widget({ wide: true, t: (key) => key });
	const secondProviders = second.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	assert.equal(secondProviders.props.children[0].props.children[1], null, "clicked header collapsed only its body");
	assert.ok(secondProviders.props.children[1].props.children[1] !== null, "sibling stays expanded");
	const ccHead = secondProviders.props.children[1].props.children[0];
	assert.match(JSON.stringify(ccHead), /dpu-account/);
	assert.match(JSON.stringify(ccHead), /dpu-plan/);
	assert.match(JSON.stringify(ccHead), /GOAT/);
});

test("a missing console credential renders a clickable balance setup chip", () => {
	const exports = loadExports();
	const opened = [];
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register: () => () => {} },
		slots: {
			inject: (_name, callback) => { callback(); },
			register: () => () => {}
		},
		get: (name) => name === "pluginNavigation"
			? { openBundle: (packageName) => opened.push(packageName) }
			: undefined
	};
	exports.apply(ctx);

	const provider = (id, meta) => ({
		id,
		name: id,
		short: id,
		status: "ok",
		account: { name: "", ref: "REF", id: null },
		plan: null,
		fallback: null,
		balance: null,
		windows: [{ key: "rolling", labelKey: "window.five-hour", percent: 10, status: "ok", resetsAt: null, windowMs: null }],
		meta
	});
	const data = {
		providers: [
			provider("opencode-go", {
				balanceError: "OpenCode balance: no console credential (set OPENCODE_CONSOLE_TOKEN, or sign in with OpenCode)"
			}),
			provider("command-code", { balanceError: "Command Code 403: forbidden" })
		],
		defaultProvider: "auto"
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());

	const widget = exports.Widget({ wide: true, t: (key) => key });
	const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	const goHead = providers.props.children[0].props.children[0];
	const chip = goHead.props.children.find((child) => child && child.props && child.props.className === "dpu-balance-setup");
	assert.ok(chip !== undefined, "the missing credential is visible as an action, not hidden");
	assert.equal(chip.props.role, "button", "the chip is exposed as a button");
	assert.equal(chip.props.tabIndex, 0, "the chip is keyboard reachable");
	assert.equal(chip.props.children, "balance.setup");
	assert.equal(chip.props.title, "balance.setup.title");

	// The click must not bubble into the header's collapse toggle.
	let stopped = 0;
	chip.props.onClick({ preventDefault: () => {}, stopPropagation: () => { stopped += 1; } });
	assert.equal(stopped, 1, "the balance click does not toggle the provider card");
	assert.deepEqual(opened, [pkg.name], "clicking the chip opens this bundle in the Plugins panel");

	chip.props.onKeyDown({ key: "Enter", preventDefault: () => {}, stopPropagation: () => { stopped += 1; } });
	assert.deepEqual(opened, [pkg.name, pkg.name], "Enter activates the chip as well");
	chip.props.onKeyDown({ key: "Tab", preventDefault: () => {}, stopPropagation: () => { stopped += 1; } });
	assert.equal(stopped, 2, "other keys do not activate the chip");

	// A real balance failure still renders the muted badge and never the chip.
	const ccHead = providers.props.children[1].props.children[0];
	const ccTree = JSON.stringify(ccHead);
	assert.match(ccTree, /dpu-provider-balance dpu-muted/);
	assert.match(ccTree, /balance\.none\.title/);
	assert.doesNotMatch(ccTree, /dpu-balance-setup/);
});

test("a credits response without top-up pools renders a no-top-up badge", () => {
	const exports = loadExports();
	const data = {
		providers: [{
			id: "command-code",
			name: "Command Code",
			status: "ok",
			account: { name: "", ref: "REF", id: null },
			plan: null,
			fallback: null,
			balance: null,
			windows: [{ key: "monthly", labelKey: "window.monthly", percent: 51.9, status: "ok", resetsAt: null, windowMs: null }],
			meta: { balanceMissing: true }
		}],
		defaultProvider: "auto"
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());

	const widget = exports.Widget({ wide: true, t: (key) => key });
	const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	const head = providers.props.children[0].props.children[0];
	const badge = head.props.children.find((child) => child && child.props && child.props.className === "dpu-provider-balance dpu-muted");
	assert.ok(badge !== undefined, "the missing pools are visible instead of blank");
	assert.equal(badge.props.children, "balance.missing");
	assert.equal(badge.props.title, "balance.missing.title");
	assert.doesNotMatch(JSON.stringify(head), /dpu-balance-setup/, "this is not a credential problem");
});

test("partial endpoint failures warn in the header and the tooltip breaks down the balance", () => {
	const exports = loadExports();
	const tt = (key, params) => (params ? key + JSON.stringify(params) : key);
	const data = {
		providers: [{
			id: "command-code",
			name: "Command Code",
			status: "ok",
			account: { name: "", ref: "REF", id: null },
			plan: null,
			fallback: null,
			balance: {
				amount: 7.44,
				currency: "USD",
				labelKey: "balance.extra",
				source: "command-code-credits",
				details: { purchased: 7.44, free: 0 }
			},
			windows: [{ key: "monthly", labelKey: "window.monthly", percent: 51.9, status: "ok", resetsAt: null, windowMs: null }],
			meta: { errors: ["Command Code /alpha/whoami 500: boom"] }
		}],
		defaultProvider: "auto"
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());

	const widget = exports.Widget({ wide: true, t: tt });
	const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	const head = providers.props.children[0].props.children[0];
	assert.match(JSON.stringify(head), /dpu-dot dpu-warn/, "partial data is not shown as healthy");
	assert.match(head.props.title, /widget\.partial\.title/, "the tooltip names the failed endpoints");
	assert.match(head.props.title, /whoami 500/);

	const badge = head.props.children.find((child) => child && child.props && child.props.className === "dpu-provider-balance");
	assert.ok(badge !== undefined);
	assert.match(badge.props.title, /balance\.details\.extra/, "the tooltip explains purchased + free");
	assert.match(badge.props.title, /\$7\.44/, "purchased credits are named");
	assert.match(badge.props.title, /\$0\.00/, "free credits are named even when zero");
});

test("balance deltas compare only providers with a changed balance", () => {
	const exports = loadExports();
	const previous = { "opencode-go": { amount: 5.14, currency: "USD" } };
	const current = [{ id: "opencode-go", balance: { amount: 4.88, currency: "USD" } }];
	const change = exports.balanceDeltasBetween(previous, current)["opencode-go"];
	assert.deepEqual(change, { amount: -0.26, currency: "USD", from: 5.14, to: 4.88 });
	assert.equal(exports.formatSignedMoney(change), "-$0.26");
	assert.equal(exports.formatSignedMoney({ amount: 1.5, currency: "USD" }), "+$1.50");
	assert.equal(exports.formatSignedMoney({ amount: 0, currency: "USD" }), "$0.00");
	assert.equal(exports.formatDeltaShort({ amount: -0.1, currency: "USD" }), "-0.1");
	assert.equal(exports.formatDeltaShort({ amount: -0.26, currency: "USD" }), "-0.26");
	assert.equal(exports.formatDeltaShort({ amount: 1.5, currency: "USD" }), "+1.5");
	assert.deepEqual(exports.balanceDeltasBetween(null, current), {});
	assert.deepEqual(exports.balanceDeltasBetween(previous, [{ id: "glm", status: "error" }]), {});
});

test("the GLM card on the settings page carries the referral link", () => {
	const exports = loadExports();
	const value = {
		opencodeGoEnabled: true,
		opencodeGoApiKeyEnv: "OPENCODE_GO_API_KEY",
		commandCodeEnabled: true,
		commandCodeApiKeyEnv: "COMMANDCODE_API_KEY",
		glmEnabled: true,
		glmApiKeyEnv: "ZAI_API_KEY",
		providerOrder: ["opencode-go", "command-code", "glm"]
	};
	// SettingsPage hooks: state, form, busy, message, draggingId, then two refs.
	react.reset();
	react.seed(0, { phase: "ready", revision: 3, value: value, detection: null, error: null });
	react.seed(1, value);
	react.seed(2, { save: false, reload: false });
	react.seed(3, null);
	react.seed(4, null);

	const page = exports.SettingsPage({ t: (key) => key });
	const tree = JSON.stringify(page);
	assert.match(tree, /https:\/\/zcode\.z\.ai\/invite\/SMBZKGEF/, "the invitation URL is rendered in the GLM card");
	assert.match(tree, /"key":"invite"/, "the GLM card gets the invite row");
});

test("the settings page explains how to enable the balance when it is missing", () => {
	const exports = loadExports();
	const value = {
		opencodeGoEnabled: true,
		opencodeGoApiKeyEnv: "OPENCODE_GO_API_KEY",
		commandCodeEnabled: true,
		commandCodeApiKeyEnv: "COMMANDCODE_API_KEY",
		glmEnabled: true,
		glmApiKeyEnv: "ZAI_API_KEY",
		providerOrder: ["opencode-go", "command-code", "glm"]
	};
	const render = (consoleInfo) => {
		react.reset();
		react.seed(0, {
			phase: "ready",
			revision: 3,
			value: value,
			detection: { providers: { "opencode-go": { console: consoleInfo } } },
			error: null
		});
		react.seed(1, value);
		react.seed(2, { save: false, reload: false });
		react.seed(3, null);
		react.seed(4, null);
		return JSON.stringify(exports.SettingsPage({ t: (key) => key }));
	};
	assert.match(render({ configured: false, source: null }), /cfg\.console\.hint/, "an unconfigured balance links the fix on the same card");
	assert.doesNotMatch(render({ configured: true, source: "opencode-db" }), /cfg\.console\.hint/, "a working balance hides the hint");
});

test("the referral row links out and offers a copy button", () => {
	const exports = loadExports();
	assert.equal(exports.GLM_INVITE_URL, "https://zcode.z.ai/invite/SMBZKGEF");

	react.reset();
	const row = exports.InviteLink({ t: (key) => key, url: exports.GLM_INVITE_URL });
	const tree = JSON.stringify(row);
	assert.match(tree, /"type":"a"/, "the URL is a real anchor");
	assert.match(tree, /"href":"https:\/\/zcode\.z\.ai\/invite\/SMBZKGEF"/);
	assert.match(tree, /"target":"_blank"/);
	assert.match(tree, /"rel":"noreferrer"/);
	assert.match(tree, /cfg\.invite\.copy/, "a copy button is present");
	assert.doesNotMatch(tree, /方便|积分|首单/, "no marketing copy is rendered");
});

test("the settings button opens this bundle in the Plugins panel", () => {
	const exports = loadExports();
	const opened = [];
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register: () => () => {} },
		slots: {
			inject: (_name, callback) => { callback(); },
			register: () => () => {}
		},
		get: (name) => name === "pluginNavigation"
			? { openBundle: (packageName) => opened.push(packageName) }
			: undefined
	};
	exports.apply(ctx);
	react.reset();
	react.seed(0, { providers: [], defaultProvider: "auto" });
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());
	react.seed(4, { "opencode-go": { amount: -0.26, currency: "USD", from: 5.14, to: 4.88 } });
	const widget = exports.Widget({ wide: true, t: (key) => key });
	const head = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-head");
	const right = head.props.children[1];
	const classes = right.props.children.map((child) => child && child.props && child.props.className);
	assert.ok(classes.indexOf("dpu-settings") > classes.indexOf("dpu-refresh"), "settings sits right of refresh");
	const button = right.props.children.find((child) => child && child.props && child.props.className === "dpu-settings");
	button.props.onClick();
	assert.deepEqual(opened, [pkg.name]);
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
