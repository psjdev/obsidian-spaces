import type { StripPlacement } from "../types";

/** The axis the strip's items run along. */
export type Axis = "x" | "y";

/** One dimension of a rectangle, projected. */
export interface Span {
  start: number;
  size: number;
}

/**
 * Which way the icons run.
 *
 * The pure reorder and scroll helpers take projected numbers rather than an
 * axis flag, so this is the only place that knows the mapping and they stay
 * free of branches.
 */
export function axisFor(placement: StripPlacement): Axis {
  return placement === "left" || placement === "right" ? "y" : "x";
}

export function spanOf(
  rect: { left: number; top: number; width: number; height: number },
  axis: Axis
): Span {
  return axis === "x"
    ? { start: rect.left, size: rect.width }
    : { start: rect.top, size: rect.height };
}

export function pointerAlong(ev: { clientX: number; clientY: number }, axis: Axis): number {
  return axis === "x" ? ev.clientX : ev.clientY;
}
