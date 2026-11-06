// Single-process test runner.
//
// `node --test test/` spawns one child per file; some Windows sandboxes deny
// that spawn (EPERM). Importing the files in one process registers every
// `node:test` case and runs them without spawning.
import "./config.test.mjs";
import "./auto-update.test.mjs";
import "./providers.test.mjs";
import "./usage.test.mjs";
import "./usage-swr.test.mjs";
import "./settings.test.mjs";
import "./fiber.test.mjs";
import "./client.test.mjs";
import "./client-min.test.mjs";
import "./session.test.mjs";
