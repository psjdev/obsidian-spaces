import type { StripPlacement } from "../types";

/**
 * Whether the "hide the strip" setting makes sense here at all.
 *
 * True only for a left strip on a device that can hover. A hover-reveal needs
 * a pointer to hover with: on a touch device a hidden strip would have no way
 * back. The stylesheet already protects that case, because the whole hide and
 * reveal block sits inside `@media (hover: hover)`, so a no-hover device hides
 * nothing and keeps a normal visible strip whatever is stored. This predicate
 * is the other half: it stops the settings page offering a control that could
 * only ever do nothing.
 *
 * Pure. The hover answer is passed in so a test can set it.
 */
export function canHideStrip(placement: StripPlacement, hasHover: boolean): boolean {
  return placement === "left" && hasHover;
}

/** The live hover answer. Read through this so callers can substitute it. */
export function deviceHasHover(): boolean {
  return typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
}
