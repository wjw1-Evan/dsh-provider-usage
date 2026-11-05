// @ts-check
/**
 * dsh-multi-provider-usage — tiny shared helpers.
 *
 * Deliberately dependency-free (no Node built-ins, no imports) so both
 * `providers.js` and `opencode-console.js` can use them without an import
 * cycle between the two.
 */

/** Deduplicate strings, dropping blanks, preserving first occurrence. */
export function uniqueStrings(values) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/** Whether a string is a valid DSH credential reference. */
export function isCredentialRefName(value) {
	return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
