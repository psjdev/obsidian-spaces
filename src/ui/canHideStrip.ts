import type { StripPlacement } from "../types";

/**
 * The placement half of the rule on its own: hiding is a LEFT-strip feature.
 *
 * Exported because two decisions rest on it and they must not drift apart:
 * `canHideStrip` below, which decides whether Settings offers the setting at
 * all, and `syncHidden` in `SwitcherView`, which decides whether hiding is
 * active right now.
 *
 * `syncHidden` deliberately does NOT call `canHideStrip` itself. The hover
 * half must not gate activation: nothing re-runs `syncHidden` when a device's
 * hover capability changes, so gating on a JS snapshot is the one change that
 * could leave a strip hidden by CSS with no wiring left to reveal it. The
 * media query in `styles.css` is the live source of truth for hover; the JS
 * hover answer only decides whether the setting is offered.
 */
export function placementCanHideStrip(placement: StripPlacement): boolean {
  return placement === "left";
}

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
  return placementCanHideStrip(placement) && hasHover;
}

/** The live hover answer. Read through this so callers can substitute it. */
export function deviceHasHover(): boolean {
  // Must match the `@media (hover: hover)` block in styles.css that hides and
  // reveals the strip. If the two disagree, the setting is offered where the
  // CSS does nothing, or withheld where it applies.
  return typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
}
