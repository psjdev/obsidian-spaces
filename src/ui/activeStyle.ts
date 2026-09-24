/**
 * How the strip marks the space you are in.
 *
 * Two looks, one of them the stylesheet's own. `"box"` adds no class at all, so
 * the existing rule keeps applying exactly as written rather than being
 * restated under a `spaces-active-box` selector that a later rule would then
 * have to out-specify. Only the departure from the default carries a class.
 *
 * Opacity is not part of this choice. Inactive icons sit at `0.55` and the
 * active one at `1` in both looks, so the bold style is not asking stroke
 * weight to carry the whole signal on its own.
 *
 * Pure on purpose, and the same shape as `stripDock.ts`: the caller owns the
 * element, this owns the mapping.
 */
import type { ActiveSpaceStyle } from "../types";

/** Set on the strip root, and read by one rule in `styles.css`. */
export const ACTIVE_STYLE_CLASS = "spaces-active-bold";

/** The class for this style, or null when the stylesheet's own rule is wanted. */
export function activeStyleClass(style: ActiveSpaceStyle): string | null {
  return style === "bold" ? ACTIVE_STYLE_CLASS : null;
}
