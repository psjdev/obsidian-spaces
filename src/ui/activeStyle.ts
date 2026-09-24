/**
 * How the strip marks the space you are in.
 *
 * Three looks, one of them the stylesheet's own. Shaded adds no class at all,
 * so the existing rule keeps applying exactly as written rather than being
 * restated under a `spaces-active-shaded` selector that a later rule would then
 * have to out-specify. Only a departure from the default carries a class.
 *
 * Opacity is not part of this choice. Inactive icons sit at `0.55` and the
 * active one at `1` in all three looks, so no single cue carries the signal on
 * its own.
 *
 * Pure on purpose, and the same shape as `stripDock.ts`: the caller owns the
 * element, this owns the mapping.
 */
import type { ActiveSpaceStyle } from "../types";

/** Shading plus a ring in the icon's own colour. */
export const BOXED_CLASS = "spaces-active-boxed";

/** A heavier glyph and no shading. */
export const BOLDED_CLASS = "spaces-active-bolded";

/** The class for this style, or null when the stylesheet's own rule is wanted. */
export function activeStyleClass(style: ActiveSpaceStyle): string | null {
  if (style === "boxed") return BOXED_CLASS;
  if (style === "bolded") return BOLDED_CLASS;
  return null;
}
