/**
 * Where the gap opens and what fills it, as one pure function.
 *
 * No DOM, no `"obsidian"` import, no knowledge of spaces, and the same reason
 * for existing as `dropIntent.ts` beside it: `DragOrdering` measures and
 * writes, and every off-by-one a drag can have belongs somewhere it can be
 * tested without a drag.
 *
 * The boundary is an INPUT rather than something computed here. `DragOrdering`
 * already owns that rule in `boundaryY`, which takes the midpoint of the gap
 * between two rows so one boundary has one position, and which earned its
 * comments the hard way. Recomputing it here would be a second copy of a rule
 * that has already been got wrong once.
 */
import type { DropEdge } from "./dropIntent";

/**
 * One row, measured. Vertical geometry comes from the row's own strip and
 * horizontal from its wrapper, because Obsidian indents the wrapper while
 * stretching the strip back to the pane's edge. `DragOrdering.rowBox` and
 * `showIndicator` already split their measurements the same way.
 */
export interface GapRow {
  /**
   * Height of the row's own strip. Zero means not laid out, never flat.
   *
   * There is deliberately no `top`. This function is told where the boundary
   * is and derives everything else from the target's height and the order of
   * the list, so a top would be a field nobody reads, measured once per row
   * per frame, that a later change could wrongly come to trust.
   */
  height: number;
  /** Left of the WRAPPER, which is what carries the indent. */
  left: number;
  /** Width of the wrapper. */
  width: number;
}

export interface GapRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface GapLayoutInput {
  /** Rows on screen, in document order. Hidden rows are not passed at all. */
  rows: readonly GapRow[];
  /** Index into `rows` of the row the insertion point sits against. */
  targetIndex: number;
  /** Which side of that row. */
  edge: DropEdge;
  /** The boundary the indicator sits on, from the caller's own measurement. */
  boundaryTop: number;
}

export interface GapLayoutResult {
  box: GapRect;
  /** How far each row moves down, indexed like `rows`. Zero means it stays. */
  shift: number[];
}

/**
 * Is this row one the gap should account for?
 *
 * A row measures zero when it is collapsed, detached, or caught mid-render.
 * Letting one into the list puts a row of no height between two real ones,
 * and every row after it takes its shift from the wrong neighbour.
 *
 * Here rather than in the caller because it is a rule, and the caller's job
 * is to measure and write. It cannot filter on its own behalf without owning
 * a decision, and it cannot be tested there without a DOM.
 */
export function isLaidOut(row: GapRow): boolean {
  return row.height > 0;
}

/**
 * The gap and the box, or null when the input cannot describe either.
 *
 * Null rather than an empty result: the caller's response to "no layout" is to
 * clear the indicator entirely, which is a different action from "draw a box
 * of zero height and move nothing".
 */
export function gapLayout(input: GapLayoutInput): GapLayoutResult | null {
  const { rows, targetIndex, edge, boundaryTop } = input;
  if (targetIndex < 0 || targetIndex >= rows.length) return null;

  const target = rows[targetIndex];
  // A collapsed or detached row measures zero. Everything below is derived
  // from this height, so a zero here produces a confident wrong answer.
  if (!(target.height > 0)) return null;

  // Dropping BEFORE a row means that row moves too. Dropping AFTER it means
  // the row stays and its successors move.
  const firstMoved = edge === "before" ? targetIndex : targetIndex + 1;

  const shift = rows.map((_, i) => (i >= firstMoved ? target.height : 0));

  return {
    box: {
      top: boundaryTop,
      left: target.left,
      width: target.width,
      height: target.height,
    },
    shift,
  };
}
