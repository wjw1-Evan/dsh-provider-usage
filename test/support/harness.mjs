// Shared, hermetic harness for the host-half tests.
//
// Everything here is dependency-free Node: the real `lib/index.js` is imported
// through `support/loader.mjs` (which points the schemastery import at a local
// copy), and it runs against a stub cordis context and a fake
// `globalThis.fetch`, so no test touches the network or a real credential.
import { register } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

register("./loader.mjs", import.meta.url);

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the plugin repository root. */
export const REPO_ROOT = path.resolve(HARNESS_DIR, "..", "..");

/** Import the plugin's real host half (cached by the ESM loader). */
export async function loadHost() {
	return import(pathToFileURL(path.join(REPO_ROOT, "lib", "index.js")).href);
}

/** Import the provider adapters directly. */
export async function loadProviders() {
	return import(pathToFileURL(path.join(REPO_ROOT, "lib", "providers.js")).href);
}

/** Read the real client bundle text. */
export async function readClientText() {
	const { readFileSync } = await import("node:fs");
	return readFileSync(path.join(REPO_ROOT, "lib", "client.js"), "utf8");
}

// ── fake wire ───────────────────────────────────────────────────────────────

/** JSON `Response` with the gateway's content type. */
export function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" }
	});
}

/** The canonical OpenCode GO usage payload (`{ usage: { rolling, weekly, monthly } }`). */
export function usagePayload(overrides = {}) {
	return {
		usage: {
			rolling: { status: "ok", percent: 12, resetsAt: "2026-08-14T07:51:13Z" },
			weekly: { status: "ok", percent: 34, resetsAt: "2026-08-17T00:00:00Z" },
			monthly: { status: "ok", percent: 56, resetsAt: "2026-08-21T13:05:13Z" },
			...overrides
		}
	};
}

/** A realistic Command Code billing fixture (the live API's field names). */
export function commandCodeFixture() {
	return {
		whoami: {
			success: true,
			user: { id: "user-1", name: "Evan", email: "evan@example.com", userName: "fsy-008" },
			org: null
		},
		subscription: {
			success: true,
			data: {
				id: "sub_1",
				status: "active",
				planId: "individual-goat",
				currentPeriodStart: "2026-10-31T16:48:56.000Z",
				currentPeriodEnd: "2026-11-30T16:48:56.000Z",
				cancelAtPeriodEnd: false
			}
		},
		credits: {
			credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 34.9187238204, purchasedCredits: 7.444241674, freeCredits: 0 },
			windowLimits: {
				limited: true,
				exceeded: "weekly",
				fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
				weekly: { used: 35.0812761796, cap: 35, exceeded: true, resetAt: 1794070179518 }
			},
			sandboxAccess: true
		},
		summary: {
			totalCount: 9918,
			totalCost: 37.6160132923,
			averageCost: 0.0037927014813772942,
			successRate: 100,
			completedCount: 9918,
			failedCount: 0,
			totalTokensIn: 1969606152,
			totalTokensOut: 7467027,
			totalTokens: 1977073179,
			totalCredits: 37.6160132923,
			totalFreeCredits: 0,
			totalMonthlyCredits: 35.0602549663,
			totalPurchasedCredits: 2.5557583260000003,
			periodBasis: "billing-period",
			periodStart: "2026-10-31T16:48:56.000Z",
			daily: []
		}
	};
}

/** A realistic GLM quota fixture using the documented `limits` shape. */
export function glmFixture(overrides = {}) {
	return {
		limits: [
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40.5, nextResetTime: 1793371200000 },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 52.0, nextResetTime: 1793727600000 },
			{ type: "TIME_LIMIT", percentage: 12.3, currentValue: 123, usage: 1000 }
		],
		...overrides
	};
}

/**
 * Install a hermetic `globalThis.fetch`.
 *
 * Answers the npm update check with an old version, each provider's endpoints
 * with the configured fixtures, and throws for unknown URLs: a test that
 * reaches the network fails loudly.
 *
 * @param {{
 *   registry?: object,
 *   opencode?: object,
 *   opencodeStatus?: number,
 *   opencodeError?: Error | null,
 *   console?: object | null,
 *   commandCode?: ReturnType<typeof commandCodeFixture>,
 *   commandCodeFail?: string | null,
 *   glm?: { zai?: object | null, bigmodel?: object | null },
 * }} [options]
 */
export function installWire(options = {}) {
	const commandCode = options.commandCode ?? commandCodeFixture();
	const state = {
		registry: options.registry ?? { version: "0.0.1" },
		opencode: options.opencode ?? usagePayload(),
		opencodeStatus: options.opencodeStatus ?? 200,
		opencodeError: options.opencodeError ?? null,
		console: options.console === undefined
			? { availableMicroCents: "501495352", balanceMicroCents: "501495352", billingMode: "prepaid", mode: "pay-as-you-go", canPurchaseCredits: true }
			: options.console,
		commandCode,
		commandCodeFail: options.commandCodeFail ?? null,
		glm: options.glm ?? { zai: glmFixture(), bigmodel: null }
	};
	/** @type {Array<{ url: string, method: string, headers: Headers }>} */
	const requests = [];
	globalThis.fetch = async function testWire(input, init) {
		const url = String(input);
		const record = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers) };
		requests.push(record);
		if (url.includes("registry.npmjs.org")) return jsonResponse(state.registry);
		if (url.includes("opencode.ai/console/api/billing/status")) {
			if (state.console === null) return jsonResponse({ _tag: "Forbidden" }, 403);
			return jsonResponse(state.console);
		}
		if (url.includes("/v1/usage")) {
			if (state.opencodeError !== null) throw state.opencodeError;
			return jsonResponse(state.opencode, state.opencodeStatus);
		}
		if (url.includes("api.commandcode.ai/alpha/")) {
			if (state.commandCodeFail !== null && url.includes(state.commandCodeFail)) {
				return jsonResponse({ error: { message: "fixture failure" } }, 500);
			}
			if (url.includes("/alpha/whoami")) return jsonResponse(commandCode.whoami);
			if (url.includes("/alpha/billing/subscriptions")) return jsonResponse(commandCode.subscription);
			if (url.includes("/alpha/billing/credits")) return jsonResponse(commandCode.credits);
			if (url.includes("/alpha/usage/summary")) return jsonResponse(commandCode.summary);
		}
		if (url.includes("api.z.ai/api/monitor/usage/quota/limit")) {
			if (state.glm.zai === null) return jsonResponse({ code: 500, success: false, msg: "no plan" }, 500);
			return jsonResponse(state.glm.zai);
		}
		if (url.includes("open.bigmodel.cn/api/monitor/usage/quota/limit")) {
			if (state.glm.bigmodel === null) return jsonResponse({ code: 500, success: false, msg: "no plan" }, 500);
			return jsonResponse(state.glm.bigmodel);
		}
		throw new Error(`unexpected fetch in hermetic test: ${url}`);
	};
	return { requests, state };
}

// ── stub cordis context ─────────────────────────────────────────────────────

/**
 * A dsh-opencode-go loader entry shaped like the real profile entry.
 * `fiber.config` holds plain values here; the host half also accepts live refs.
 */
export function goEntry(config = {}) {
	return {
		id: "opencode-go",
		options: { id: "opencode-go", name: "dsh-opencode-go" },
		disabled: false,
		fiber: {
			uid: 42,
			config: {
				enabled: true,
				apiKeyEnv: "OPENCODE_API_KEY",
				baseURL: "https://opencode.ai/zen/go",
				accounts: [
					{ id: "legacy:OPENCODE_API_KEY", name: "mekki", apiKeyEnv: "OPENCODE_API_KEY" },
					{ id: "legacy:SECOND_KEY", name: "backup", apiKeyEnv: "SECOND_KEY" }
				],
				...config
			}
		}
	};
}

/** A dsh-opencode-go usage service stub (`ctx.get("opencodeGoUsage")`). */
export function usageService(read) {
	const service = {
		calls: 0,
		async read() {
			service.calls += 1;
			return typeof read === "function" ? read(service.calls) : read;
		}
	};
	return service;
}

/** Credentials service stub backed by a `{ ref: value }` map. */
export function credentials(map = {}) {
	return {
		resolved: [],
		async resolve(ref) {
			if (!Object.prototype.hasOwnProperty.call(map, ref)) return undefined;
			return { value: map[ref] };
		}
	};
}

/** A settings-service stub with the descriptor/revision contract. */
export function makeSettings({ value = {}, revision = 1, ns = "dsh-multi-provider-usage", onUpdate } = {}) {
	let current = { ...value };
	let currentRevision = revision;
	const updates = [];
	const settings = {
		updates,
		describe() {
			return [{
				ns,
				revision: currentRevision,
				value: { ...current },
				base: { ...current },
				user: { ...current },
				autoGenerate: true,
				applies: "live"
			}];
		},
		async update(gotNs, patch, expectedRevision) {
			if (gotNs !== ns) throw new Error(`unexpected namespace ${gotNs}`);
			if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
				const error = new Error("revision conflict");
				error.code = "SETTINGS_CONFLICT";
				error.name = "SettingsConflictError";
				error.actual = currentRevision;
				throw error;
			}
			updates.push({ ns: gotNs, patch: { ...patch }, expectedRevision });
			current = { ...current, ...patch };
			currentRevision += 1;
			if (typeof onUpdate === "function") onUpdate(patch, current);
		}
	};
	return settings;
}

/**
 * Stub context with the surfaces `apply()` touches: web routes, commands,
 * credentials, event listeners, loader entries, `ctx.get()` services and the
 * fiber's own entry id.
 */
export function makeCtx(options = {}) {
	const routes = [];
	const commands = [];
	const listeners = [];
	const effects = [];
	const warns = [];
	const exact = new Map();
	const prefixes = new Map();
	const commandMap = new Map();
	const services = { ...(options.services ?? {}) };
	const entries = options.entries ?? [];
	const credentialsService = credentials(options.credentialMap);
	const ctx = {
		webServer: {
			port: options.port,
			host: options.host ?? "127.0.0.1",
			exact,
			prefixes,
			register(route) {
				const table = route.kind === "exact" ? exact : prefixes;
				if (table.has(route.path)) {
					throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
				}
				table.set(route.path, route);
				routes.push(route);
				return () => {
					if (table.get(route.path) === route) table.delete(route.path);
					const index = routes.indexOf(route);
					if (index !== -1) routes.splice(index, 1);
				};
			}
		},
		commands: {
			register(command) {
				if (commandMap.has(command.name)) {
					throw new Error(`command "${command.name}" is already registered in this scope`);
				}
				commandMap.set(command.name, command);
				commands.push(command);
				return () => {
					if (commandMap.get(command.name) === command) commandMap.delete(command.name);
					const index = commands.indexOf(command);
					if (index !== -1) commands.splice(index, 1);
				};
			}
		},
		credentials: credentialsService,
		logger: {
			warn(message) {
				warns.push(String(message));
			}
		},
		effect(fn) {
			const dispose = fn();
			effects.push(dispose);
			return dispose;
		},
		on(name, callback) {
			listeners.push({ name, callback });
			return () => {
				const index = listeners.findIndex((listener) => listener.callback === callback);
				if (index !== -1) listeners.splice(index, 1);
			};
		},
		loader: { entries: () => entries },
		get(name) {
			return services[name];
		},
		fiber: { entry: { options: { id: options.entryId ?? "dsh-multi-provider-usage" } } },
		root: {}
	};
	const disposeAll = () => {
		for (const dispose of effects.splice(0)) {
			if (typeof dispose === "function") dispose();
		}
	};
	return {
		ctx,
		routes,
		commands,
		listeners,
		services,
		entries,
		effects,
		warns,
		exact,
		prefixes,
		commandMap,
		credentials: credentialsService,
		disposeAll
	};
}

/** Read-only response stub compatible with the plugin's `res.end()` usage. */
function responseStub() {
	return {
		statusCode: 200,
		headers: {},
		setHeader(key, value) {
			this.headers[String(key).toLowerCase()] = value;
		},
		end(chunk) {
			this.body = chunk === undefined ? "" : String(chunk);
		}
	};
}

/**
 * Invoke one registered route with a synthetic request.
 * @param {Array<{ path: string, handler: Function }>} routes
 * @param {string} routePath
 * @param {{ method?: string, url?: string, headers?: Record<string, string>, body?: string }} [request]
 */
export async function callRoute(routes, routePath, request = {}) {
	const route = routes.find((candidate) => candidate.path === routePath);
	if (route === undefined) {
		throw new Error(`route not registered: ${routePath} (have: ${routes.map((entry) => entry.path).join(", ")})`);
	}
	const req = Readable.from(request.body === undefined ? [] : [Buffer.from(request.body, "utf8")]);
	req.method = request.method ?? "GET";
	req.url = request.url ?? routePath;
	req.headers = request.headers ?? {};
	const res = responseStub();
	await route.handler(req, res);
	return {
		status: res.statusCode,
		headers: res.headers,
		text: res.body ?? "",
		body: res.body ? JSON.parse(res.body) : null
	};
}

/** Convenience: boot the plugin with a stub context and hermetic wire. */
export async function boot(options = {}) {
	const host = await loadHost();
	const wire = installWire(options.wire ?? {});
	const { ctx, routes, commands, listeners, effects, warns, disposeAll, credentials: credentialsService } = makeCtx({
		entries: options.entries ?? [],
		services: options.services ?? {},
		credentialMap: options.credentialMap ?? {},
		port: options.port,
		entryId: options.entryId
	});
	const config = {
		cacheMs: 0,
		updateCheck: false,
		commandCodeAuthFile: "/nonexistent/commandcode-auth.json",
		...options.config
	};
	host.apply(ctx, config);
	return { host, wire, ctx, routes, commands, listeners, effects, warns, disposeAll, credentials: credentialsService, config };
}
