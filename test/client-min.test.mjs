// The committed lib/client.min.js must always be a fresh minification of
// lib/client.js: DSH serves the file the `./client` export points to
// verbatim, and this plugin's own auto-update fast-forwards clean checkouts
// without running npm install — so the built artifact travels with the
// source. Rebuilding with the same esbuild version must reproduce the
// committed bytes; esbuild is a devDependency, so a checkout whose
// devDependencies are absent (e.g. fast-forwarded in place) skips the check
// and trusts the committed artifact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

test("lib/client.min.js is a fresh minification of lib/client.js", async (t) => {
	let esbuild;
	try {
		esbuild = await import("esbuild");
	} catch {
		t.skip("esbuild is not installed; trusting the committed artifact");
		return;
	}
	const committed = path.resolve("lib/client.min.js");
	assert.ok(existsSync(committed), "lib/client.min.js is missing — run npm run build:client and commit it");
	const dir = mkdtempSync(path.join(os.tmpdir(), "dpu-min-"));
	try {
		await esbuild.build({
			entryPoints: [path.resolve("lib/client.js")],
			outfile: path.join(dir, "client.min.js"),
			minify: true,
			legalComments: "none",
			logLevel: "silent"
		});
		const fresh = readFileSync(path.join(dir, "client.min.js"), "utf8");
		const mine = readFileSync(committed, "utf8");
		assert.equal(fresh, mine, "lib/client.min.js is stale — run npm run build:client and commit the result");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
