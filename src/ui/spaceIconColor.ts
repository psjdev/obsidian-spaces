/**
 * The colour to paint a space's icon with, for every surface that draws one.
 *
 * A space always stores a real hex: `validateSpace` requires one and drops a
 * space without it. So "this space has no colour" is expressed by storing the
 * neutral swatch, which is `PALETTE[0]`. The colour popover presents it as
 * Neutral and `nextPaletteColor` never hands it out, so it is a sentinel
 * rather than a choice.
 *
 * Painting it would pin the icon to a fixed grey and shut the theme out, which
 * is what was reported: with colour assignment turned off, every space wore
 * `#808080` whatever the theme drew its icons in. Returning undefined leaves
 * the element with no inline colour, so `--icon-color` applies.
 *
 * One function rather than the same condition in five places. It was first
 * written inline in the strip alone, which left the same space grey in the
 * header, the switcher popover, the quick switcher and the create form's
 * preview while the strip followed the theme.
 */
import { DEFAULT_SPACE_COLOR } from "../definitions/appearance";

/** The colour to set inline, or undefined to leave it to the theme. */
export function iconColorFor(color: string | undefined): string | undefined {
  if (!color) return undefined;
  // Case-insensitive: `validateSpace` accepts `#808080` in either case and
  // stores it as given, so a lowercase-only comparison would paint the grey.
  return color.toLowerCase() === DEFAULT_SPACE_COLOR.toLowerCase() ? undefined : color;
}
