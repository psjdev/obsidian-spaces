/**
 * The decision layer: dragging a space to a new position in the switcher
 * strip. Pure — no DOM, no `"obsidian"` import. The view measures and renders;
 * every rule lives here, where it is tested.
 *
 * The numbers here run along an axis the caller chooses — `start` and `size`
 * say nothing about x or y. The view projects a rect or a pointer event onto
 * whichever axis the strip's current placement uses before calling in; this
 * file never branches on that.
 *
 * Deliberately NOT built on `DragOrdering`/`dropIntent`. Those are shaped
 * around the file tree — `describeRow(path)`, folder parents, `moveInto`,
 * stored-versus-displayed order, and the subtree guards none of which have any
 * meaning for a flat list of spaces. Reusing them would have meant either
 * pretending a space is a path in an imaginary folder, or generalising a file
 * with six hard-won measured facts behind it. This is a few dozen lines instead.
 *
 * What IS reused is the file tree's drag *rules*, because a second drag
 * gesture that behaved differently from the first would be the real cost: the
 * inter-item gap is
 * never a dead zone, and a drop that changes nothing draws no line.
 */

import type { Span } from "./stripAxis";

/** How close to the rail's edge the pointer must be before it scrolls. */
export const EDGE_ZONE_PX = 36;
/** Fastest auto-scroll, in px per animation frame. */
const MAX_STEP_PX = 24;
/** Slowest, so entering the zone at all still moves. */
const MIN_STEP_PX = 2;

export interface ItemBox {
  /** Start edge, along the axis, in the same coordinate space as the pointer reading. */
  start: number;
  size: number;
}

/**
 * Which gap the pointer is nearest, as an index into the list: 0 is before the
 * first item, `boxes.length` is after the last.
 *
 * Resolved by MIDPOINT rather than by hit-testing the items, which is what
 * keeps the gap from ever being a dead zone — exact hit-testing leaves the gap
 * between two icons unclaimed and the line blinks out as the pointer crosses
 * it. Every position along the axis,
 * including one far outside the strip, resolves to a gap.
 */
export function insertionIndexAt(pointer: number, boxes: readonly ItemBox[]): number {
  let index = 0;
  for (const box of boxes) {
    if (pointer < box.start + box.size / 2) break;
    index++;
  }
  return index;
}

/**
 * The list with the item at `from` moved to `insertionIndex`.
 *
 * `insertionIndex` is measured against the list as it is ON SCREEN, with the
 * dragged item still in place. Removing the item first shifts every later slot
 * down by one, so a rightward move has to compensate — the off-by-one that
 * otherwise puts the item one position further right than the line promised.
 */
export function moveTo<T>(list: readonly T[], from: number, insertionIndex: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item === undefined) return [...list];
  out.splice(insertionIndex > from ? insertionIndex - 1 : insertionIndex, 0, item);
  return out;
}

/**
 * A drop that changes nothing draws no line.
 *
 * Both gaps touching the dragged item leave it exactly where it is — the one
 * before it and the one after it — so both are no-ops, not just the first.
 */
export function isNoOpMove(from: number, insertionIndex: number): boolean {
  return insertionIndex === from || insertionIndex === from + 1;
}

/**
 * How far to scroll the rail this frame, signed: negative scrolls toward the
 * start of the axis.
 *
 * Proportional to depth into the edge zone rather than flat, because a flat
 * step is either too slow to cross a long rail or too fast to stop on the
 * right gap. Past the rail entirely it saturates instead of stopping — running
 * off the end is exactly when the user is reaching for something out of view.
 */
export function edgeScrollStep(pointer: number, rail: Span): number {
  const fromStart = pointer - rail.start;
  const fromEnd = rail.start + rail.size - pointer;
  if (fromStart < EDGE_ZONE_PX) return -stepFor(fromStart);
  if (fromEnd < EDGE_ZONE_PX) return stepFor(fromEnd);
  return 0;
}

/** `distance` is how far INSIDE the zone's outer boundary the pointer sits. */
function stepFor(distance: number): number {
  const depth = Math.min(1, Math.max(0, (EDGE_ZONE_PX - distance) / EDGE_ZONE_PX));
  return MIN_STEP_PX + (MAX_STEP_PX - MIN_STEP_PX) * depth;
}

/**
 * Where to draw the insertion line for `index`, in the same coordinates the
 * boxes were measured in.
 *
 * The centre of the gap, for the same reason as in the file tree:
 * one boundary must have exactly one position. Drawing at an item's edge gives
 * the gap two candidate positions two pixels apart, which reads as the line
 * jittering as the pointer crosses.
 */
export function gapCenterAt(index: number, boxes: readonly ItemBox[]): number {
  if (boxes.length === 0) return 0;
  const first = boxes[0];
  if (index <= 0) return first.start - EDGE_LINE_INSET_PX;
  const last = boxes[boxes.length - 1];
  if (index >= boxes.length) return last.start + last.size + EDGE_LINE_INSET_PX;
  const prev = boxes[index - 1];
  const cur = boxes[index];
  return (prev.start + prev.size + cur.start) / 2;
}

/** How far outside the strip the first and last positions sit. */
const EDGE_LINE_INSET_PX = 2;
