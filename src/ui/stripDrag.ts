import type { StripPlacement } from "../types";

/** Below this, a pointer press is a click and the strip must not move. */
export const DRAG_THRESHOLD_PX = 4;

/** How far a vertical edge may be losing by and still win in a corner. */
export const CORNER_BIAS_PX = 8;

export interface Point {
  x: number;
  y: number;
}

export interface PaneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Which placement the pointer is asking for, with no undefined region.
 *
 * The bias exists because the two are not equivalent near a corner: a ribbon
 * is the more distinctive placement and the horizontal bands are thin, so a
 * corner should resolve to a ribbon rather than to a sliver. Ties on opposite
 * edges resolve to left and to top, arbitrarily but deterministically.
 */
export function nearestPlacement(pointer: Point, pane: PaneRect): StripPlacement {
  const dL = Math.abs(pointer.x - pane.left);
  const dR = Math.abs(pane.right - pointer.x);
  const dT = Math.abs(pointer.y - pane.top);
  const dB = Math.abs(pane.bottom - pointer.y);
  const v = Math.min(dL, dR);
  const h = Math.min(dT, dB);
  if (v <= h + CORNER_BIAS_PX) return dL <= dR ? "left" : "right";
  return dT <= dB ? "top" : "bottom";
}

/** Whether the pointer has moved far enough for this to be a drag. */
export function passedThreshold(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD_PX;
}
