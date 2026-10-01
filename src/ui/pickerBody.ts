/**
 * Which body the create panel's explorer window is showing, and what to search
 * it with.
 *
 * `pickerFilter` reads the sigil out of the filter text. This reads the whole
 * situation: the filter text plus whether the window's tag icon has been
 * pressed. Two doors into one room, so the rule that decides the room has to
 * know about both of them, and it has to live somewhere a test can reach
 * without a DOM.
 *
 * The room has two bodies, and the filter box alone chooses between them:
 *
 * - **An empty box shows the tags already chosen.** That is the review-and-
 *   remove list, and it is the only place a chosen tag is visible now that the
 *   badge row above the tree is gone.
 * - **Any text in the box searches the vault's tags.** The sigil is text, so a
 *   bare `#` searches with an empty query, which browses the whole tag list —
 *   the behaviour the sigil has had since it was introduced, kept because the
 *   sigil is still how someone with nothing chosen yet goes looking.
 *
 * Pure: no DOM, no `"obsidian"`.
 */

import { readPickerFilter } from "./pickerFilter";

export type PickerBody =
  /** The vault's files and folders. */
  | "tree"
  /** The tags this space already holds. */
  | "tag-chosen"
  /** The vault's tags, ranked against `query`. */
  | "tag-search";

export interface PickerView {
  body: PickerBody;
  /**
   * What to search with, in the body's own terms: the whole filter for the
   * tree, the text after the sigil for a sigil-driven tag search, and the
   * whole filter for a tag search reached through the icon.
   */
  query: string;
}

/**
 * What to draw, given the filter text and whether the tag icon is pressed.
 *
 * Tree mode hands the filter back verbatim, for the reason `readPickerFilter`
 * documents: the tree is the control across these prototypes, and a filter
 * that reached it altered would make every tree behaviour a new behaviour.
 *
 * A box holding only whitespace counts as empty. Whitespace is invisible, so
 * it must not be the difference between the list of what you chose and a
 * search that will match nothing.
 */
export function readPickerBody(raw: string, tagView: boolean): PickerView {
  const filter = readPickerFilter(raw);
  if (filter.mode === "tag") return { body: "tag-search", query: filter.query };
  if (!tagView) return { body: "tree", query: raw };
  return raw.trim() === ""
    ? { body: "tag-chosen", query: "" }
    : { body: "tag-search", query: raw };
}

/**
 * The filter text to keep when the tag icon is pressed off.
 *
 * Pressing the icon off has to actually reach the tree, and a filter still
 * carrying the sigil would hold the window in tag mode against a control that
 * has just said to leave it. Dropping the sigil and keeping the rest is what
 * backspacing the sigil away already does, so the icon and the keyboard end up
 * in the same place.
 */
export function leaveTagView(raw: string): string {
  const filter = readPickerFilter(raw);
  return filter.mode === "tag" ? filter.query : raw;
}

/**
 * What the tag icon is called, for its tooltip and its accessible name.
 *
 * The count rides on the label as well as on the icon, because the number
 * drawn beside the icon is unreadable to anything that is not looking at it,
 * and the count is the whole of what the tree body now says about tags.
 */
export function tagToggleLabel(tagView: boolean, chosen: number): string {
  if (tagView) return "Show files and folders";
  if (chosen <= 0) return "Show tags";
  return chosen === 1 ? "Show tags, 1 chosen" : `Show tags, ${chosen.toLocaleString()} chosen`;
}
