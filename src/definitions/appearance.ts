/**
 * A space's stored appearance: the palette it is assigned from, and the two
 * validators that decide whether an icon id or a color may reach `data.json`.
 *
 * `normalizeHex` lived in `ui/colorPicker.ts` and `isIconIdShape` in
 * `ui/iconPicker.ts`, so `actions/spaceLifecycle.ts` — the write path for both
 * fields — imported its validation UP out of the view layer, while five `ui/`
 * modules imported `spaceLifecycle` back. Both are domain validation for
 * values written to `data.json`, in the same category as `schema.ts`'s
 * `isSafeVaultPath`, and they sat in `ui/` only because the pickers that also
 * use them were written first. `ui/renameSpaceForm.ts` already imports
 * `MAX_SPACE_NAME_LENGTH` down from `definitions/schema.ts`; this is that
 * direction, applied to the other two.
 *
 * Pure: no DOM, no `"obsidian"` import.
 */

/**
 * The neutral swatch leads, then the vivid ones.
 *
 * `#808080` is Obsidian's own icon grey, near enough: measured against 1.13.7,
 * `--icon-color` is `#b3b3b3` in the default dark theme and `#5c5c5c` in the
 * default light one. A stored color is a fixed hex (`schema.ts`'s COLOR
 * regex), so it cannot track a theme switch the way a CSS variable would —
 * the midpoint is legible on either ground instead of correct on one and
 * washed out on the other. Offering it lets a user opt OUT of color-coding a
 * space rather than being assigned a tint they did not choose.
 *
 * It is deliberately NOT in the auto-assignment rotation — see
 * `nextPaletteColor` (spaceLifecycle.ts).
 */
export const PALETTE = [
  "#808080",
  "#5b5bff",
  "#4ecdc4",
  "#ff6b6b",
  "#f0a35e",
  "#9b6bff",
];

/**
 * What a space is colored before anyone chooses — the neutral swatch, and
 * therefore the one the color popover opens with already selected.
 *
 * Color is opt-IN. A new space looks like the rest of Obsidian's chrome
 * until the user decides otherwise, rather than arriving wearing a tint they
 * did not pick and may not want. That is the same argument the neutral swatch
 * was added for, applied to the default rather than only to the choice.
 *
 * `PALETTE[0]` by definition, not by coincidence: "the first swatch" is what
 * the popover shows selected on open, so the two must not be able to drift.
 */
export const DEFAULT_SPACE_COLOR = PALETTE[0];

/**
 * Color alone must never be the
 * only label a control carries. Parallel to PALETTE by index and length —
 * one source of truth for the human-readable name of each swatch, so
 * nothing downstream (the create panel's aria-label today, anything else
 * later) has to invent its own name for a color it was only handed as a
 * hex string. Moved together with `PALETTE`: the two are indexed
 * against each other, so separating them would create the drift the comment
 * above exists to prevent.
 */
export const PALETTE_NAMES: readonly string[] = [
  "Neutral",
  "Indigo",
  "Teal",
  "Coral",
  "Amber",
  "Violet",
];

/** `#ABC` → `#aabbcc`, `abcdef` → `#abcdef`. Null if it is not a color. */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().toLowerCase();
  const body = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-f]{3}$/.test(body)) {
    // Shorthand is worth accepting: a user typing #f0a means #ff00aa, and
    // rejecting it would look like the field is broken.
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  if (/^[0-9a-f]{6}$/.test(body)) return `#${body}`;
  return null;
}

/** A plausible icon name, used to keep obvious junk out of `data.json`. */
export function isIconIdShape(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 64;
}
