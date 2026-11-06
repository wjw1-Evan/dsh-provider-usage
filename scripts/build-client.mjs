// Build the publishable client bundle: minify lib/client.js into
// lib/client.min.js. The minified file is committed (not gitignored) so a
// clean checkout — including one fast-forwarded by this plugin's own
// auto-update — serves fresh client code without a build step; a test in
// client.test.mjs re-runs this script and fails when the committed file is
// stale. DSH serves the file the `./client` export points to verbatim, so
// minifying here cuts every client boot's transfer and parse cost.
import { build } from "esbuild";

await build({
	entryPoints: [new URL("../lib/client.js", import.meta.url).pathname],
	outfile: new URL("../lib/client.min.js", import.meta.url).pathname,
	minify: true,
	legalComments: "none",
	logLevel: "warning"
});
console.log("built lib/client.min.js");
