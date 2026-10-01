/**
 * What the create panel's filter box says about which body the explorer
 * window is showing.
 *
 * The window now carries two buttons above it, Items and Tags, so the text in
 * the box no longer has to encode the mode. What the box offers instead is a
 * SHORTCUT to those buttons: `/` or `#` typed as the first character of an
 * empty box presses one of them, and the character is consumed rather than
 * left behind in the query.
 *
 * Consumed, because the buttons are now the thing that holds the mode. A
 * character that both switched the window AND stayed in the box would be
 * saying it twice, and the user would have to delete it before the query they
 * came to type could start.
 *
 * Empty box and first character, and nothing else. `/` is in almost every path
 * a curated space is picked from, so a box that switched modes mid-word would
 * throw away a keystroke and the view at the moment someone is halfway through
 * naming a file. The rule has to be one a user can hold: the sigils mean mode
 * when there is nothing to be part of, and mean themselves otherwise.
 *
 * Pure, and deliberately the ONLY place that knows the sigils: the panel asks
 * this what a keystroke meant rather than testing the character itself, so the
 * rule can be changed or tested without a DOM.
 */

/** The character that asks for the vault's notes and folders. */
export const ITEMS_SIGIL = "/";

/** The character that asks for the vault's tags. */
export const TAG_SIGIL = "#";

/** Which body the explorer window is showing. */
export type PickerMode = "items" | "tags";

/** What the window opens on, and what any mode change resets it to. */
export const DEFAULT_PICKER_MODE: PickerMode = "items";

/**
 * A `Map` rather than an object literal: the lookup key is whatever the
 * keyboard produced, and an object would answer for inherited names like
 * `constructor` as readily as for a sigil.
 */
const MODE_SIGILS: ReadonlyMap<string, PickerMode> = new Map<string, PickerMode>([
  [ITEMS_SIGIL, "items"],
  [TAG_SIGIL, "tags"],
]);

/** One keystroke arriving at the filter box, in the terms the rule needs. */
export interface Keystroke {
  /** What the box holds BEFORE this keystroke lands in it. */
  box: string;
  /** `KeyboardEvent.key`. */
  key: string;
  /**
   * Whether Ctrl, Meta or Alt was held. Shift is not one of them: `#` is a
   * shifted key on most layouts, so excluding it would disable the shortcut
   * on the very keyboards it was written for.
   */
  modified?: boolean;
  /** Whether an IME is mid-composition, in which case the key is not a character yet. */
  composing?: boolean;
}

/**
 * The mode a keystroke asks for, or `null` when it is an ordinary character.
 *
 * `null` is the answer for every keystroke that is not a sigil at the front of
 * an empty box, which is most of them, and the caller's job on `null` is to do
 * nothing at all and let the character land.
 *
 * An empty box means empty, not blank. Whitespace counts as text here, unlike
 * everywhere else in this picker, because this rule DELETES the keystroke it
 * claims: a box holding a space is a box someone is already typing in, and
 * swallowing their `/` there would cost them a character.
 */
export function readModeSigil(stroke: Keystroke): PickerMode | null {
  if (stroke.box !== "") return null;
  if (stroke.modified === true || stroke.composing === true) return null;
  return MODE_SIGILS.get(stroke.key) ?? null;
}
