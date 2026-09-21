import type { StripPlacement } from "../types";

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

const ALL = Object.values(DOCK_CLASSES).filter((c): c is string => c !== null);

/** Applies one placement, having removed any other. At most one is ever set. */
export function applyDock(pane: HTMLElement, placement: StripPlacement): void {
  pane.classList.remove(...ALL);
  const cls = DOCK_CLASSES[placement];
  if (cls) pane.classList.add(cls);
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
