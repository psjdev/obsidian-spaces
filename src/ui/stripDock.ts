import type { StripPlacement } from "../types";
import { CLS_STRIP_HIDDEN, CLS_STRIP_OPEN } from "../explorer/selectors";

/**
 * The class each placement puts on the EXPLORER PANE, not on the strip.
 *
 * `bottom` is null on purpose: it is what the pane already does, so it needs
 * no rule and adds no class. Every other value is styling layered on top.
 */
export const DOCK_CLASSES: Record<StripPlacement, string | null> = {
  bottom: null,
  top: "spaces-dock-top",
  left: "spaces-dock-left",
  right: "spaces-dock-right",
};

const PLACEMENTS = Object.values(DOCK_CLASSES).filter((c): c is string => c !== null);

/**
 * Everything the dock puts on the pane, which is what has to come off a pane
 * the strip is leaving.
 *
 * The hidden and open classes are in the list because they are ours as well,
 * not because either paints anything by itself: every selector that reads one
 * is compounded with `spaces-dock-left` (all five of them in `styles.css`), so
 * a pane that lost the dock class and kept them looks exactly the same. They
 * come off because the strip has gone, and a pane the strip has left must
 * carry no state of ours.
 */
const ALL = [...PLACEMENTS, CLS_STRIP_HIDDEN, CLS_STRIP_OPEN];

/**
 * Applies one placement, having removed any other. At most one is ever set.
 *
 * Docking anywhere but left also drops the hidden and open classes, since only
 * a left strip can hide.
 *
 * Docking LEFT leaves both exactly as it found them, and `syncHidden` is what
 * decides them. Left to left is the common case -- every definitions change
 * runs `applyPlacement` -- and removing the hidden class there only to have
 * the caller put it straight back is a window with the strip laid out
 * un-hidden. Nothing reads layout between the two calls today, so nothing
 * paints it; a layout read added between them would slide the strip out and
 * back on every definitions change -- a toggle flipped in Settings, a space
 * renamed, a color picked. Not having the window beats relying on nobody
 * adding the read.
 */
export function applyDock(pane: HTMLElement, placement: StripPlacement): void {
  pane.classList.remove(...(placement === "left" ? PLACEMENTS : ALL));
  const cls = DOCK_CLASSES[placement];
  if (cls) pane.classList.add(cls);
}

/**
 * Hides or shows the strip (the pane carries the class, the CSS slides the
 * strip). Un-hiding also drops the open class so a revealed strip never stays
 * open with nothing left to close it.
 */
export function applyHidden(pane: HTMLElement, hidden: boolean): void {
  pane.classList.toggle(CLS_STRIP_HIDDEN, hidden);
  if (!hidden) pane.classList.remove(CLS_STRIP_OPEN);
}

/**
 * Removes every trace. Called on remount to a different pane, on destroy and
 * on unload: a pane left with `spaces-dock-left` keeps reserving side padding
 * for a strip that is no longer in it.
 */
export function clearDock(pane: HTMLElement | null | undefined): void {
  pane?.classList.remove(...ALL);
}

export const GRIP_CLASS = "spaces-strip-grip";

/**
 * Shows or hides the grab handle.
 *
 * Inserted FIRST so it pushes `All` and the rail along and reads as pinned to
 * the leading edge. Idempotent because `render()` rebuilds the strip's
 * children and calls this again every time: a locked strip must have the
 * grip removed, not a second one appended on top of the one already there.
 */
export function applyUnlockState(strip: HTMLElement, unlocked: boolean): HTMLElement | null {
  const existing = strip.querySelector<HTMLElement>(`.${GRIP_CLASS}`);
  strip.classList.toggle("is-unlocked", unlocked);
  if (!unlocked) {
    existing?.remove();
    return null;
  }
  if (existing) return existing;
  const grip = strip.doc.win.createDiv({ cls: GRIP_CLASS });
  grip.setAttribute("aria-label", "Move the space strip");
  strip.insertBefore(grip, strip.firstChild);
  return grip;
}
