/**
 * What a frontmatter entry OFFERS as matchable values, and what counts as
 * equal.
 *
 * Pure, so it runs in plain node. The shapes below were measured by planting
 * frontmatter in a running Obsidian 1.13.7 and reading
 * `metadataCache.getFileCache().frontmatter` back; the planted note is in the
 * spec so the probe can be repeated against a later Obsidian.
 *
 * NO `Date` BRANCH. No probe produced one on this path — `date: 2026-08-31`
 * arrives as the string `"2026-08-31"` — and a branch with no input to
 * exercise it is behavior nobody can check. Add one deliberately if a later
 * Obsidian produces a `Date`, with a UTC-or-local rule decided at the time.
 */

/** Values compare trimmed and case-folded. Keys never do. */
export function normalizeValue(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The normalized values this entry offers, deduplicated, in first-seen order.
 *
 * `null` and `undefined` offer NOTHING rather than the text "null".
 * `String(null)` is `"null"`, so the naive rule files every blank property
 * under a value a member could ask for, and a blank property is among the
 * commonest shapes in a real vault.
 *
 * An array offers its DIRECT scalar entries and is never stringified whole:
 * `String(["atlas","billing"])` is `"atlas,billing"`, which would match a
 * member asking for exactly that. A nested array, an object or a null inside
 * a list contributes nothing, so the rule is one level deep and says so.
 */
export function valuesOf(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (v: unknown): void => {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return;
    const text = normalizeValue(String(v));
    if (seen.has(text)) return;
    seen.add(text);
    out.push(text);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) take(entry);
    return out;
  }
  take(raw);
  return out;
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
