/**
 * What counts as EQUAL between two values, and what counts as carrying a key.
 *
 * Pure, so it runs in plain node.
 *
 * WHICH VALUES AN ENTRY OFFERS IS NOT HERE. It is the bucket builder in
 * `PropertyIndex.ts`, because that rule has to keep the authored spelling for
 * the picker to draw while `normalizeValue` is what the matching is keyed on.
 * A second, normalized-only copy of the offering rule lived here as
 * `valuesOf` with NO caller in `src/`, and the spec's boundary table was
 * driven through it — so the eight shapes the table exists for were never run
 * against the code the plugin runs. The copy is gone and the table drives
 * `createPropertyIndex` (`tests/propertyValues.test.ts`). One rule, one
 * table.
 */

/** Values compare trimmed and case-folded. Keys never do. */
export function normalizeValue(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Whether this frontmatter carries the key ITSELF.
 *
 * `hasOwnProperty`, not `in` and not a truthiness test: a note must not inherit
 * `constructor` or `toString` from a prototype, and a key holding `null`, `0`,
 * `false` or `""` is still a key the note carries. "Has this property" is the
 * primary shape and it asks exactly this question. Spelled via
 * `Object.prototype` because the lib target is ES2018, which lacks
 * `Object.hasOwn`.
 */
export function hasOwnKey(frontmatter: unknown, key: string): boolean {
  if (frontmatter === null || typeof frontmatter !== "object") return false;
  return Object.prototype.hasOwnProperty.call(frontmatter, key);
}
