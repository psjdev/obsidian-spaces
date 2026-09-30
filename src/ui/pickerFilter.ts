/**
 * What the create panel's picker is being asked for, read from the filter box
 * alone.
 *
 * The box is the only control, so the text has to carry the mode: a leading
 * `#` asks for tags, anything else asks for the vault tree. That keeps a tag
 * one keystroke away without a second field, a segmented control or a menu,
 * and it is the same sigil Obsidian already uses for a tag everywhere the
 * user has seen one.
 *
 * Pure, and deliberately the ONLY place that knows the sigil: the panel asks
 * this what to draw rather than testing the string itself, so the rule can be
 * changed, widened to a second sigil, or tested without a DOM.
 */

/** The character that switches the picker over to tags. */
export const TAG_SIGIL = "#";

export type PickerMode = "tree" | "tag";

export interface PickerFilter {
  mode: PickerMode;
  /**
   * What to search with, in the mode's own terms: the whole filter for the
   * tree, and the text after the sigil for tags.
   */
  query: string;
}

/**
 * Which body the filter text selects, and what to search it with.
 *
 * Tree mode hands back the filter **verbatim**, not a trimmed or lowercased
 * one. `visibleRows` does its own normalising, and the tree is the control in
 * this comparison: a filter that arrived at it changed, however harmlessly,
 * would make every tree behaviour a new behaviour.
 *
 * Leading whitespace is ignored when looking for the sigil, because it is
 * invisible: a space picked up from a paste would otherwise leave `#project`
 * searching the tree for a file called "#project" with nothing on screen to
 * explain why.
 *
 * An empty query after the sigil is a real query, not a missing one. A bare
 * `#` means "show me the tags", which is how someone who does not yet know
 * what the vault holds finds out.
 */
export function readPickerFilter(raw: string): PickerFilter {
  const lead = raw.trimStart();
  if (!lead.startsWith(TAG_SIGIL)) return { mode: "tree", query: raw };
  return { mode: "tag", query: lead.slice(TAG_SIGIL.length) };
}
