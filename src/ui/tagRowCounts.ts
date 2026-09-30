/**
 * How many notes a tag row in the create panel's picker reports, and how that
 * number reads.
 *
 * The picker offers a SELECTOR, not a set of notes: a tag member resolves live
 * forever after, so nothing the picker shows can be more than a reading of the
 * vault as it is right now. That is what the count is for. It answers "is this
 * the tag I mean" before the member exists, without pretending to be the
 * contents of the space.
 *
 * Pure: no DOM, no `"obsidian"`. The panel supplies the counter and draws.
 */

/** Anything the picker is about to draw a row for. */
interface Named {
  /** The stored spelling, which is what the counter is asked about. */
  tag: string;
}

/**
 * The rows the picker will draw, each with the number of notes its tag
 * currently brings in.
 *
 * `countOf` is called **once per row given and never otherwise**, which is the
 * whole reason this takes the rows rather than the vault's tag list. The
 * caller has already ranked and capped; counting the tags that survived that
 * is bounded by what is on screen, while counting first and capping second
 * would put a lookup against every tag in the vault behind every keystroke.
 *
 * Order is preserved, because ranking already decided it.
 */
export function countTagRows<T extends Named>(
  rows: readonly T[],
  countOf: (tag: string) => number
): (T & { count: number })[] {
  return rows.map((row) => ({ ...row, count: countOf(row.tag) }));
}

/**
 * The count as the row says it.
 *
 * Nouned rather than left as a bare numeral: `12` alone beside a tag name
 * could as easily be a position, a depth or a shortcut, and the row has no
 * column heading to say otherwise. "notes" is what the vault calls them and
 * what the rest of this plugin's copy calls them.
 *
 * Zero is worded rather than numbered. A tag with no notes is a real state —
 * Obsidian lists a tag the instant it is typed, and the metadata cache can be
 * a moment behind it — and a quiet grey `0 notes` reads as a count that failed
 * to arrive rather than as a count of none.
 *
 * Grouped by locale, because a vault where this matters is exactly the vault
 * where the digits are hard to read unseparated.
 */
export function tagCountLabel(count: number): string {
  if (count <= 0) return "no notes";
  if (count === 1) return "1 note";
  return `${count.toLocaleString()} notes`;
}
