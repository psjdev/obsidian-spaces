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

/**
 * Values compare trimmed, case-folded and in one Unicode form. Keys never do.
 *
 * THE UNICODE FORM IS NOT COSMETIC. `café` with a precomposed `é` and the same
 * word written `e` plus a combining acute are different strings, so without
 * this they became two buckets with IDENTICAL labels, each collecting half the
 * notes, and the picker drew two rows a person could not tell apart. It is not
 * an exotic case: it reaches accented European languages, Vietnamese and
 * Korean, and any vault that has passed through macOS, whose filesystem has
 * historically favored the decomposed form.
 *
 * NFC, not NFD: it is the form the web and most text sources produce, so it is
 * the one that leaves the common input untouched.
 *
 * NORMALIZED LAST, so the result is NFC whatever `toLowerCase` did with it.
 * Lowercasing is defined to preserve canonical equivalence, so two inputs that
 * differ only in form still agree here; putting the normalize at the end also
 * makes the OUTPUT a canonical form rather than merely a consistent one, which
 * matters because this string is a `Map` key and a stored member's identity
 * (`memberIdentity`).
 *
 * VALUES ONLY. Keys match exactly, by an explicit decision of the repo owner,
 * and nothing here is reached from a key comparison. Two keys differing only
 * in Unicode form are therefore still two keys, with the same identical-label
 * problem this fixes for values; changing that is a separate call.
 */
export function normalizeValue(text: string): string {
  return text.trim().toLowerCase().normalize("NFC");
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
 *
 * ITS ONE PRODUCTION CALL SITE CANNOT SEE IT ANSWER FALSE, and the call is
 * belt and braces rather than the guard. `createPropertyIndex` enumerates
 * with `Object.keys`, which already yields own enumerable string keys only,
 * and every map the feature keys on vault text is a `Map`, so a note
 * authoring `__proto__` is stopped there and not here. This stays the one
 * spelling of the rule, for a later caller whose keys come from somewhere
 * `Object.keys` does not already filter.
 */
export function hasOwnKey(frontmatter: unknown, key: string): boolean {
  if (frontmatter === null || typeof frontmatter !== "object") return false;
  return Object.prototype.hasOwnProperty.call(frontmatter, key);
}
