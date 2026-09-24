/**
 * The color to paint a space's icon with, for every surface that draws one.
 *
 * A space always stores a real hex: `validateSpace` requires one and drops a
 * space without it. So "this space has no color" is expressed by storing the
 * neutral swatch, which is `PALETTE[0]`. The color popover presents it as
 * Neutral and `nextPaletteColor` never hands it out, so it is a sentinel
 * rather than a choice.
 *
 * Painting it would pin the icon to a fixed grey and shut the theme out, which
 * is what was reported: with color assignment turned off, every space wore
 * `#808080` whatever the theme drew its icons in. Returning undefined leaves
 * the element with no inline color, so `--icon-color` applies.
 *
 * One function rather than the same condition in five places. It was first
 * written inline in the strip alone, which left the same space grey in the
 * header, the switcher popover, the quick switcher and the create form's
 * preview while the strip followed the theme.
 */
import { DEFAULT_SPACE_COLOR } from "../definitions/appearance";

/**
 * The color to set inline, or undefined to leave it to the theme.
 *
 * `useThemeColor` is the Appearance toggle, and it is required rather than
 * defaulted: an optional argument would let a surface forget to pass it and
 * keep painting stored colors while the rest of the app obeyed the setting.
 * That is exactly how the neutral swatch first reached one surface out of
 * five. Required means the compiler names every caller.
 */
export function iconColorFor(
  color: string | undefined,
  useThemeColor: boolean
): string | undefined {
  // First, and without looking at the color: the toggle is a blanket. The
  // stored value is left alone, so it comes back the moment this goes off.
  if (useThemeColor) return undefined;
  if (!color) return undefined;
  // Case-insensitive: `validateSpace` accepts `#808080` in either case and
  // stores it as given, so a lowercase-only comparison would paint the grey.
  return color.toLowerCase() === DEFAULT_SPACE_COLOR.toLowerCase() ? undefined : color;
}

/**
 * What to paint a swatch chip in the color popover with.
 *
 * The chip is a preview of the result, so the neutral one shows the color a
 * space on it will actually be, which is the theme's. Painting the stored
 * `#808080` would promise a grey the strip does not deliver.
 *
 * Returns the variable rather than a resolved value, so a chip already on
 * screen follows a theme switch without the popover being rebuilt.
 */
export function swatchPaint(color: string): string {
  // `false`, deliberately, and not the Appearance toggle: with theme colors
  // forced on, every chip would go the same color and the palette would stop
  // being a palette. The chips show what a space STORES, which is what you
  // are choosing between, and the toggle governs what gets drawn from it.
  return iconColorFor(color, false) ?? "var(--icon-color)";
}
