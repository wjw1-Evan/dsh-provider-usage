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
		/** Read one state slot without re-rendering (assertions). */
		peek(index) { return states[index]; },
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

/** Collect every element of one component type in a rendered element tree. */
function findType(node, type, found = []) {
	if (!node || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const child of node) findType(child, type, found);
		return found;
	}
	if (node.type === type) found.push(node);
	if (node.props && node.props.children !== undefined) findType(node.props.children, type, found);
	return found;
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
	const names = providers.props.children.map((section) => section.props.children[0].props.children[1].props.children);
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
	assert.match(chip.props.title, /^balance\.setup\.title/, "the tooltip explains the fix");

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

test("the host balanceSetup marker renders the setup chip for an API-key login", () => {
	const exports = loadExports();
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		locale: { register: () => () => {} },
		slots: {
			inject: (_name, callback) => { callback(); },
			register: () => () => {}
		},
		get: () => undefined
	};
	exports.apply(ctx);

	const data = {
		providers: [{
			id: "opencode-go",
			name: "OpenCode GO",
			status: "ok",
			account: { name: "", ref: "REF", id: null },
			plan: null,
			fallback: null,
			balance: null,
			windows: [{ key: "rolling", labelKey: "window.five-hour", percent: 10, status: "ok", resetsAt: null, windowMs: null }],
			meta: {
				balanceSetup: "api-key",
				balanceError: "OpenCode balance: the local OpenCode login is an API key, not an OpenCode Console session"
			}
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
	const chip = head.props.children.find((child) => child && child.props && child.props.className === "dpu-balance-setup");
	assert.ok(chip !== undefined, "an API-key-only login is actionable, not a mute dash");
	assert.equal(chip.props.children, "balance.setup");
	assert.match(chip.props.title, /API key/, "the tooltip carries the host explanation");
	assert.doesNotMatch(JSON.stringify(head), /dpu-provider-balance dpu-muted/, "it is not rendered as a balance error");
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
	// SettingsPage hooks: state, form, busy, message, draggingId, usage, then refs.
	react.reset();
	react.seed(0, { phase: "ready", revision: 3, value: value, detection: null, error: null });
	react.seed(1, value);
	react.seed(2, { save: false, reload: false });
	react.seed(3, null);
	react.seed(4, null);
	react.seed(5, { phase: "idle", data: null, error: null });

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
		return exports.SettingsPage({ t: (key) => key });
	};
	const guide = (consoleInfo) => findType(render(consoleInfo), exports.ConsoleGuide);
	// An unconfigured or fixable balance mounts the step-by-step guide.
	assert.equal(guide({ configured: false, source: null }).length, 1, "an unconfigured balance mounts the guide");
	assert.equal(guide({ configured: true, source: "opencode-db" }).length, 0, "a working balance hides the guide");
	assert.equal(guide({ configured: false, source: null, reason: "api-key" })[0]?.props.reason, "api-key", "an API-key login names the precise fix");
	assert.equal(guide({ configured: true, source: "opencode-db", reason: "expired" })[0]?.props.reason, "expired", "an expired sign-in names the fix");
	// The guide is wired to the page's re-check flow.
	assert.equal(typeof guide({ configured: false, source: null })[0]?.props.onRecheck, "function");
});

test("the console guide carries the state-specific fix and copy actions", () => {
	const exports = loadExports();
	const t = (key) => key;
	const render = (props) => {
		react.reset();
		return JSON.stringify(exports.ConsoleGuide({ t, ...props }));
	};
	const generic = render({ reason: "", onRecheck: async () => {} });
	assert.match(generic, /cfg\.console\.guide\.title/);
	assert.match(generic, /cfg\.console\.hint/, "the generic lead-in for an unconfigured balance");
	assert.match(generic, /opencode auth login/, "the CLI sign-in command is shown");
	assert.match(generic, /cfg\.console\.copy\.command/, "the command has a copy button");
	assert.match(generic, /cfg\.console\.recheck/, "the guide offers re-check");

	// A specific reason replaces the generic hint instead of stacking on it.
	assert.match(render({ reason: "api-key", onRecheck: async () => {} }), /cfg\.console\.apiKey/);
	assert.doesNotMatch(render({ reason: "api-key", onRecheck: async () => {} }), /cfg\.console\.hint/);
	assert.match(render({ reason: "expired", onRecheck: async () => {} }), /cfg\.console\.expired/);
	assert.doesNotMatch(render({ reason: "expired", onRecheck: async () => {} }), /cfg\.console\.hint/);

	// The referral row and the guide share one CopyButton implementation.
	react.reset();
	const inviteRow = exports.InviteLink({ t, url: exports.GLM_INVITE_URL });
	assert.equal(findType(inviteRow, exports.CopyButton).length, 1, "the referral row reuses CopyButton");
	// The new guide copy ships in both locales.
	const locales = [];
	exports.apply({
		effect: (fn) => { fn(); return () => {}; },
		locale: { register: (ns, tables) => { locales.push({ ns, tables }); return () => {}; } },
		slots: { inject: (_name, callback) => { callback(); }, register: () => () => {} }
	});
	for (const key of ["cfg.console.guide.title", "cfg.console.guide.step1", "cfg.console.guide.step2", "cfg.console.copy.command", "cfg.console.recheck", "cfg.console.rechecking", "cfg.console.copied", "cfg.console.copyFailed"]) {
		assert.ok(locales[0].tables.zh[key], `zh ${key} exists`);
		assert.ok(locales[0].tables.en[key], `en ${key} exists`);
	}
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
	assert.equal(findType(row, exports.CopyButton).length, 1, "a copy button is present");
	assert.doesNotMatch(tree, /方便|积分|首单/, "no marketing copy is rendered");
});

test("the usage section renders quota windows, balance and a failed provider", () => {
	const exports = loadExports();
	const tt = (key, params) => (params ? key + ":" + JSON.stringify(params) : key);
	const okProvider = {
		id: "command-code",
		name: "Command Code",
		status: "ok",
		balance: { amount: 7.44, currency: "USD", source: "command-code-credits", details: { purchased: 7.44, free: 0 } },
		windows: [
			{ key: "five-hour", labelKey: "window.five-hour", percent: 12.5, status: "ok", resetsAt: null, windowMs: null },
			{ key: "monthly", labelKey: "window.monthly", percent: 56, status: "ok", resetsAt: null, windowMs: null }
		],
		meta: {}
	};

	react.reset();
	const ready = JSON.stringify(exports.UsageSection({ t: tt, enabled: true, provider: okProvider, phase: "ready" }));
	assert.match(ready, /"key":"five-hour"/, "each quota window gets its own row");
	assert.match(ready, /12\.5%/);
	assert.match(ready, /56%/);
	assert.match(ready, /cfg\.usage\.balance/, "the balance row is labeled");
	assert.match(ready, /\$7\.44/, "the balance value is money-formatted");
	assert.match(ready, /balance\.details\.extra/, "the composition is explained");
	assert.match(ready, /\$0\.00/, "a zero free pool is still named");

	react.reset();
	const errored = JSON.stringify(exports.UsageSection({
		t: tt,
		enabled: true,
		provider: { id: "glm", name: "GLM Code Plan", status: "error", error: "GLM 500: boom", windows: [], meta: null },
		phase: "ready"
	}));
	assert.match(errored, /cfg\.usage\.error/, "a failed provider renders the error");
	assert.match(errored, /GLM 500: boom/);
});

test("the usage section falls back to placeholders, not blanks", () => {
	const exports = loadExports();
	const tt = (key, params) => (params ? key + ":" + JSON.stringify(params) : key);
	const show = (props) => JSON.stringify(exports.UsageSection({ t: tt, ...props }));

	assert.match(show({ enabled: false, provider: null, phase: "ready" }), /cfg\.usage\.disabled/, "a disabled provider explains itself");
	assert.match(show({ enabled: true, provider: null, phase: "loading" }), /cfg\.usage\.loading/, "loading shows a placeholder");
	assert.match(show({ enabled: true, provider: null, phase: "error", error: "HTTP 502" }), /cfg\.usage\.loadFailed/, "a failed snapshot is named");
	assert.match(show({ enabled: true, provider: null, phase: "error", error: "HTTP 502" }), /HTTP 502/, "the route failure detail is carried");
	assert.match(show({ enabled: true, provider: null, phase: "idle" }), /cfg\.usage\.loading/, "the initial idle phase reads as loading");

	const noBalance = show({
		enabled: true,
		phase: "ready",
		provider: {
			id: "opencode-go",
			name: "OpenCode GO",
			status: "ok",
			balance: null,
			windows: [{ key: "monthly", labelKey: "window.monthly", percent: 10, status: "ok", resetsAt: null, windowMs: null }],
			meta: { balanceSetup: "api-key", balanceError: "the local OpenCode login is an API key" }
		}
	});
	assert.match(noBalance, /cfg\.usage\.noBalance/, "a setup-blocked balance renders muted instead of blank");
	assert.doesNotMatch(noBalance, /the local OpenCode login/, "the console hints above carry the precise fix");
});

test("the settings page renders live usage in every provider card", () => {
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
	const usage = {
		phase: "ready",
		at: 0,
		data: {
			providers: [
				{
					id: "opencode-go",
					name: "OpenCode GO",
					status: "ok",
					balance: { amount: 0.5, currency: "USD", source: "test" },
					windows: [{ key: "monthly", labelKey: "window.monthly", percent: 56, status: "ok", resetsAt: null, windowMs: null }],
					meta: {}
				},
				{ id: "command-code", name: "Command Code", status: "error", error: "Command Code 500: boom", windows: [], meta: null },
				{ id: "glm", name: "GLM Code Plan", status: "ok", balance: null, windows: [], meta: { balanceMissing: true } }
			]
		},
		error: null
	};
	react.reset();
	react.seed(0, { phase: "ready", revision: 3, value: value, detection: null, error: null });
	react.seed(1, value);
	react.seed(2, { save: false, reload: false });
	react.seed(3, null);
	react.seed(4, null);
	react.seed(5, usage);

	const tree = JSON.stringify(exports.SettingsPage({ t: (key) => key }));
	assert.equal((tree.match(/"key":"usage"/g) ?? []).length, 3, "each provider card embeds a usage section");
	assert.match(tree, /"provider":\{"id":"opencode-go"/, "the OpenCode GO card gets its usage slice");
	assert.match(tree, /"provider":\{"id":"command-code"/, "the Command Code card gets its usage slice");
	assert.match(tree, /"provider":\{"id":"glm"/, "the GLM card gets its usage slice");
	assert.match(tree, /"balance":\{"amount":0\.5/, "the balance reaches the section");
	assert.match(tree, /Command Code 500: boom/, "the failed provider reaches the section");
	assert.match(tree, /cfg\.usage\.refresh/, "a refresh control is present");
});

test("a low balance renders amber and a critical balance renders red", () => {
	const exports = loadExports();
	const data = {
		providers: [
			{ id: "a", name: "Healthy", status: "ok", account: null, plan: null, fallback: null, balance: { amount: 42, currency: "USD", source: "test" }, windows: [], meta: {} },
			{ id: "b", name: "Low", status: "ok", account: null, plan: null, fallback: null, balance: { amount: 4.88, currency: "USD", source: "test" }, windows: [], meta: {} },
			{ id: "c", name: "Critical", status: "ok", account: null, plan: null, fallback: null, balance: { amount: 0.5, currency: "CNY", source: "test" }, windows: [], meta: {} }
		],
		defaultProvider: "auto"
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());
	react.seed(4, {});

	const widget = exports.Widget({ wide: true, t: (key) => key });
	const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	const healthy = JSON.stringify(providers.props.children[0].props.children[0]);
	const low = JSON.stringify(providers.props.children[1].props.children[0]);
	const critical = JSON.stringify(providers.props.children[2].props.children[0]);
	assert.doesNotMatch(healthy, /dpu-low|dpu-critical/, "a healthy balance keeps the default green");
	assert.match(low, /dpu-provider-balance dpu-low/, "at or below 5 the chip turns amber");
	assert.match(critical, /dpu-provider-balance dpu-critical/, "at or below 1 the chip turns red");
	assert.doesNotMatch(low, /dpu-critical/, "amber does not leak into red");
});

test("an exhausted window keeps its countdown and labels the status after the percentage", () => {
	const exports = loadExports();
	const tt = (key, params) => (params ? key + ":" + JSON.stringify(params) : key);
	// 3 days, 2 hours and 5 minutes out, so the countdown lands on 3d2h even
	// with the milliseconds the render consumes.
	const resetsAt = new Date(Date.now() + ((3 * 24 + 2) * 3600 + 5 * 60) * 1000).toISOString();
	const data = {
		providers: [{
			id: "command-code",
			name: "Command Code",
			status: "ok",
			account: null,
			plan: null,
			fallback: null,
			balance: null,
			windows: [
				{ key: "weekly", labelKey: "window.weekly", percent: 100, status: "exceeded", resetsAt, windowMs: 7 * 864e5 },
				{ key: "monthly", labelKey: "window.monthly", percent: 52.3, status: "ok", resetsAt: null, windowMs: null },
				{ key: "five-hour", labelKey: "window.five-hour", percent: 100, status: "exceeded", resetsAt: null, windowMs: null, hintKey: "window.five-hour.hint" }
			],
			meta: {}
		}],
		defaultProvider: "auto"
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());
	react.seed(4, {});

	const widget = exports.Widget({ wide: true, t: tt });
	const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	// div.dpu-provider → body → Fragment → one .dpu-row per window.
	const rows = providers.props.children[0].props.children[1].props.children[0].props.children;

	const weekly = rows[0].props.children[1].props.children[1];
	assert.equal(weekly.props.children, 'time.days:{"n":3,"m":2}', "an exhausted window still counts down");
	assert.match(weekly.props.title, /time\.resetsAt/, "the tooltip carries the absolute reset time");
	assert.match(weekly.props.title, /exceeded/, "the exhausted state is still named in the tooltip");

	const weeklyValue = rows[0].props.children[0].props.children[1];
	assert.equal(weeklyValue.props.children[0].props.children, "100%", "the percentage is still shown");
	const chip = weeklyValue.props.children[1];
	assert.equal(chip.props.children, "exceeded", "the status sits right after the percentage");
	assert.equal(chip.props.className, "dpu-window-status dpu-status-exceeded", "an exhausted window reads as an error chip");

	const monthly = rows[1].props.children[1].props.children[1];
	assert.equal(monthly.props.children, "", "a window without a reset time and without a hint stays empty");
	assert.equal(rows[1].props.children[0].props.children[1].props.children[1], null, "a healthy window carries no status chip");

	const noReset = rows[2].props.children[1].props.children[1];
	assert.equal(noReset.props.children, "exceeded", "without a reset time the status label fills the slot");
});

test("a window with tokensUsed shows the full token count after its label", () => {
	const exports = loadExports();
	const tt = (key, params) => (params ? key + ":" + JSON.stringify(params) : key);
	const data = {
		providers: [{
			id: "command-code",
			name: "Command Code",
			status: "ok",
			account: null,
			plan: null,
			fallback: null,
			balance: null,
			windows: [
				{ key: "monthly", labelKey: "window.monthly", percent: 51.9, status: "ok", resetsAt: null, windowMs: null, tokensUsed: 1977073179 },
				{ key: "weekly", labelKey: "window.weekly", percent: 100, status: "exceeded", resetsAt: null, windowMs: null }
			],
			meta: {}
		}],
		defaultProvider: "auto"
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 0);
	react.seed(3, new Set());
	react.seed(4, {});

	const widget = exports.Widget({ wide: true, t: tt });
	const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	const rows = providers.props.children[0].props.children[1].props.children[0].props.children;

	const monthlyLabel = rows[0].props.children[0].props.children;
	assert.equal(monthlyLabel[1].props.className, "dpu-row-tokens", "the token count sits between the label and the percentage");
	assert.equal(monthlyLabel[1].props.children, "1,977,073,179", "the full grouped number renders");
	assert.equal(monthlyLabel[1].props.title, "window.tokens.title: 1,977,073,179", "the tooltip names the metric");
	assert.equal(monthlyLabel[2].props.className, "dpu-row-value", "the percentage slot follows the token count");

	const weeklyLabel = rows[1].props.children[0].props.children;
	assert.equal(weeklyLabel.length, 2, "a window without tokensUsed keeps the two-element label");
	assert.equal(weeklyLabel[1].props.className, "dpu-row-value");
});

test("an error line is a keyboard-reachable retry control", () => {
	const exports = loadExports();
	const data = {
		providers: [{
			id: "glm",
			name: "GLM Code Plan",
			status: "error",
			error: "GLM 500: boom",
			account: null,
			plan: null,
			fallback: null,
			balance: null,
			windows: [],
			meta: null
		}],
		defaultProvider: "auto"
	};
	react.reset();
	react.seed(0, data);
	react.seed(1, null);
	react.seed(2, 5);
	react.seed(3, new Set());
	react.seed(4, {});

	const widget = exports.Widget({ wide: true, t: (key) => key });
	const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
	const section = providers.props.children[0];
	const body = section.props.children[1];
	const errorLine = body.props.children[0];
	assert.equal(errorLine.props.className, "dpu-provider-error dpu-retry");
	assert.equal(errorLine.props.role, "button");
	assert.equal(errorLine.props.tabIndex, 0, "the retry is keyboard reachable");
	assert.match(errorLine.props.title, /error\.retry/);

	// Enter and Space activate the retry; other keys do not.
	const stampBefore = react.peek(2);
	errorLine.props.onKeyDown({ key: "Enter", preventDefault: () => {} });
	assert.equal(react.peek(2), stampBefore + 1, "Enter forces a refresh");
	errorLine.props.onKeyDown({ key: "Tab", preventDefault: () => {} });
	assert.equal(react.peek(2), stampBefore + 1, "Tab does not force a refresh");
});

test("the settings page reloads usage after saving and can force a refresh", async () => {
	const text = await readClientText();
	assert.match(text, /USAGE_PATH \+ \(force \? "\?refresh=1" : ""\)/, "usage reads honor the host's forced-refresh flag");
	assert.match(text, /void loadUsage\(true\)/, "saving forces one upstream re-read so a changed apikey shows its own numbers");
	assert.match(text, /void loadUsage\(false\)/, "the page loads the usage snapshot when it mounts");
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

test("the GLM card names the Code Plan version that answered", () => {
	const exports = loadExports();
	const tt = (key, params) => (params ? key + ":" + JSON.stringify(params) : key);
	const render = (meta) => {
		react.reset();
		react.seed(0, {
			providers: [{
				id: "glm",
				name: "GLM Code Plan",
				status: "ok",
				account: null,
				plan: null,
				fallback: null,
				balance: null,
				windows: [{ key: "five-hour", labelKey: "window.five-hour", percent: 12, status: "ok", resetsAt: null, windowMs: null }],
				meta
			}],
			defaultProvider: "auto"
		});
		react.seed(1, null);
		react.seed(2, 0);
		react.seed(3, new Set());
		react.seed(4, {});
		const widget = exports.Widget({ wide: true, t: tt });
		const providers = widget.props.children.find((child) => child && child.props && child.props.className === "dpu-providers");
		return JSON.stringify(providers.props.children[0]);
	};

	const international = render({ region: "https://api.z.ai", regionKind: "zai" });
	assert.match(international, /"children":"region\.zai"/, "the international version is badged");
	assert.match(international, /api\.z\.ai/, "the badge tooltip names the host");
	const china = render({ region: "https://open.bigmodel.cn" });
	assert.match(china, /"children":"region\.bigmodel"/, "older payloads derive the version from the base URL");
	assert.doesNotMatch(render({ attempts: [] }), /region\.(zai|bigmodel|custom)/, "an unknown version shows no badge");
});

test("the GLM settings card offers the version choice and reports the detected one", () => {
	const exports = loadExports();
	const value = {
		opencodeGoEnabled: true,
		opencodeGoApiKeyEnv: "OPENCODE_GO_API_KEY",
		commandCodeEnabled: true,
		commandCodeApiKeyEnv: "COMMANDCODE_API_KEY",
		glmEnabled: true,
		glmApiKeyEnv: "ZAI_API_KEY",
		glmRegion: "auto",
		providerOrder: ["opencode-go", "command-code", "glm"]
	};
	react.reset();
	react.seed(0, {
		phase: "ready",
		revision: 3,
		value,
		detection: { providers: { glm: { configured: true, credentialRef: "ZAI_API_KEY", region: "zai", baseUrl: "https://api.z.ai" } } },
		error: null
	});
	react.seed(1, value);
	react.seed(2, { save: false, reload: false });
	react.seed(3, null);
	react.seed(4, null);
	react.seed(5, {
		phase: "ready",
		at: 0,
		data: {
			providers: [{
				id: "glm",
				name: "GLM Code Plan",
				status: "ok",
				balance: null,
				windows: [{ key: "five-hour", labelKey: "window.five-hour", percent: 40, status: "ok", resetsAt: null, windowMs: null }],
				meta: { region: "https://api.z.ai", regionKind: "zai" }
			}]
		},
		error: null
	});

	const page = exports.SettingsPage({ t: (key) => key });
	const tree = JSON.stringify(page);
	assert.match(tree, /"key":"glm-region"/, "the GLM card carries the version selector");
	for (const kind of ["auto", "zai", "bigmodel", "custom"]) {
		assert.match(tree, new RegExp('"value":"' + kind + '"'), `the ${kind} option exists`);
	}
	assert.match(tree, /cfg\.status\.region: region\.zai/, "the status line reports the configured version");

	// The live-usage inset is an element at this level; render it directly to
	// check that it names the version the numbers came from.
	const glmProvider = {
		id: "glm",
		name: "GLM Code Plan",
		status: "ok",
		balance: null,
		windows: [{ key: "five-hour", labelKey: "window.five-hour", percent: 40, status: "ok", resetsAt: null, windowMs: null }],
		meta: { region: "https://api.z.ai", regionKind: "zai" }
	};
	const usageTree = JSON.stringify(exports.UsageSection({ t: (key) => key, enabled: true, provider: glmProvider, phase: "ready" }));
	assert.match(usageTree, /"children":"region\.zai"/, "live usage names the version that answered");
	assert.match(usageTree, /https:\/\/api\.z\.ai/, "the live usage row carries the host");

	const select = findType(page, "select")[0];
	assert.equal(select.props.value, "auto");
	select.props.onChange({ target: { value: "bigmodel" } });
	assert.equal(react.peek(1).glmRegion, "bigmodel", "choosing a version updates the form");
});

test("both locales name the two GLM Code Plan versions", () => {
	const locales = [];
	loadExports().apply({
		effect: (fn) => fn(),
		locale: { register: (_ns, tables) => { locales.push(tables); return () => {}; } },
		slots: { inject: (_name, callback) => { callback(); }, register: () => () => {} }
	});
	const tables = locales[0];
	for (const key of [
		"region.auto",
		"region.zai",
		"region.bigmodel",
		"region.custom",
		"widget.region.title",
		"cfg.glm.region",
		"cfg.glm.region.auto",
		"cfg.glm.region.zai",
		"cfg.glm.region.bigmodel",
		"cfg.glm.region.custom",
		"cfg.status.region"
	]) {
		assert.ok(tables.zh[key], `zh ${key} exists`);
		assert.ok(tables.en[key], `en ${key} exists`);
	}
	assert.equal(tables.zh["region.zai"], "国际版");
	assert.equal(tables.zh["region.bigmodel"], "国内版");
	assert.equal(tables.en["region.zai"], "International");
	assert.equal(tables.en["region.bigmodel"], "China");
});
