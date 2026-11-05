// Test loader: resolves the bare `@deepseek-ai/schemastery` specifier used by
// `lib/index.js` to a local installation.
//
// Resolution order:
//   1. `DSH_SCHEMASTERY` — absolute path to a `lib/index.mjs` (explicit override)
//   2. `./node_modules/@deepseek-ai/schemastery/lib/index.mjs` (dev dependency)
//   3. `$DSH_HOME/profiles/{desktop,web}/node_modules/...`
//   4. `~/.dsh/profiles/{desktop,web}/node_modules/...`
//   5. `/tmp/dsh-app/dsh/node_modules/...` (the extracted DSH app, for dev)
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Every candidate path, in probe order (also used in the error message). */
function candidateEntries() {
	const entries = [];
	if (process.env.DSH_SCHEMASTERY) entries.push(path.resolve(process.env.DSH_SCHEMASTERY));
	entries.push(path.join(process.cwd(), "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs"));
	const profiles = [];
	if (process.env.DSH_HOME) profiles.push(path.join(process.env.DSH_HOME, "profiles", "desktop"));
	if (process.env.DSH_PROFILE_DIR) profiles.push(process.env.DSH_PROFILE_DIR);
	profiles.push(path.join(homedir(), ".dsh", "profiles", "desktop"));
	profiles.push(path.join(homedir(), ".dsh", "profiles", "web"));
	for (const profile of profiles) {
		entries.push(path.join(profile, "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs"));
	}
	entries.push(path.join("/tmp", "dsh-app", "dsh", "node_modules", "@deepseek-ai", "schemastery", "lib", "index.mjs"));
	return entries;
}

let cachedUrl = null;

function schemasteryUrl() {
	if (cachedUrl !== null) return cachedUrl;
	const tried = candidateEntries();
	for (const entry of tried) {
		if (existsSync(entry)) {
			cachedUrl = pathToFileURL(entry).href;
			return cachedUrl;
		}
	}
	throw new Error(
		"@deepseek-ai/schemastery was not found for the offline tests. Looked in:\n  "
		+ tried.join("\n  ")
		+ "\nRun `npm install` in the repository, or set DSH_SCHEMASTERY to an existing schemastery/lib/index.mjs."
	);
}

/** @type {import("node:module").ResolveHook} */
export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@deepseek-ai/schemastery") {
		return { url: schemasteryUrl(), shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
