/**
 * Which rows move to open the gap, and where the box sits in it.
 *
 * Pure arithmetic, so all of it is tested here rather than through a drag.
 * `DragOrdering` measures and writes; every off-by-one lives in this file's
 * subject, next to `dropIntent.ts` which owns the other half of the rules.
 */
import { describe, expect, it } from "vitest";
import { gapLayout, type GapRow } from "../src/order/gapLayout";

/** Three rows of 24px, stacked with a 2px gap, indented like a tree. */
const ROWS: GapRow[] = [
  { top: 100, height: 24, left: 12, width: 300 },
  { top: 126, height: 24, left: 29, width: 283 },
  { top: 152, height: 24, left: 29, width: 283 },
];

describe("opening a gap for the drop", () => {
  it("moves the target row and everything after it, for a drop before it", () => {
    const out = gapLayout({ rows: ROWS, targetIndex: 1, edge: "before", boundaryTop: 125 });
    expect(out?.shift).toEqual([0, 24, 24]);
  });

  it("moves only what comes after the target, for a drop after it", () => {
    const out = gapLayout({ rows: ROWS, targetIndex: 1, edge: "after", boundaryTop: 151 });
    expect(out?.shift).toEqual([0, 0, 24]);
  });

  it("moves every row when the drop is before the first one", () => {
    const out = gapLayout({ rows: ROWS, targetIndex: 0, edge: "before", boundaryTop: 100 });
    expect(out?.shift).toEqual([24, 24, 24]);
  });

  it("moves nothing when the drop is after the last one", () => {
    // The box still has to be drawn, below everything, which is the case a
    // "shift the rows below" implementation forgets because there are none.
    const out = gapLayout({ rows: ROWS, targetIndex: 2, edge: "after", boundaryTop: 176 });
    expect(out?.shift).toEqual([0, 0, 0]);
    expect(out?.box.top).toBe(176);
  });

  it("puts the box on the caller's boundary, at the target row's height", () => {
    const out = gapLayout({ rows: ROWS, targetIndex: 1, edge: "before", boundaryTop: 125 });
    expect(out?.box).toEqual({ top: 125, height: 24, left: 29, width: 283 });
  });

  it("takes the box's width and indent from the target row", () => {
    // Not the pane's width. An indented row's box must start where the row
    // starts, or the box claims a position at the wrong depth.
    const out = gapLayout({ rows: ROWS, targetIndex: 0, edge: "before", boundaryTop: 100 });
    expect(out?.box.left).toBe(12);
    expect(out?.box.width).toBe(300);
  });

  it("shifts by the target row's own height, not a shared one", () => {
    // Rows are not guaranteed to be a uniform height, and a global constant
    // would misplace the box and every row under it.
    const mixed: GapRow[] = [
      { top: 0, height: 40, left: 0, width: 100 },
      { top: 42, height: 24, left: 0, width: 100 },
    ];
    expect(gapLayout({ rows: mixed, targetIndex: 0, edge: "before", boundaryTop: 0 })?.shift)
      .toEqual([40, 40]);
    expect(gapLayout({ rows: mixed, targetIndex: 1, edge: "before", boundaryTop: 41 })?.shift)
      .toEqual([0, 24]);
  });

  it("returns a shift entry for every row", () => {
    // The caller writes the whole set each frame, so a short array would leave
    // the tail of the list carrying a stale transform.
    const out = gapLayout({ rows: ROWS, targetIndex: 0, edge: "after", boundaryTop: 125 });
    expect(out?.shift).toHaveLength(ROWS.length);
  });

  it("declines an empty list", () => {
    expect(gapLayout({ rows: [], targetIndex: 0, edge: "before", boundaryTop: 0 })).toBeNull();
  });

  it("declines an index outside the list", () => {
    expect(gapLayout({ rows: ROWS, targetIndex: 3, edge: "before", boundaryTop: 0 })).toBeNull();
    expect(gapLayout({ rows: ROWS, targetIndex: -1, edge: "before", boundaryTop: 0 })).toBeNull();
  });

  it("declines a target that has not been laid out", () => {
    // A collapsed or detached row measures zero. Shifting by zero would draw a
    // zero-height box and move nothing, which looks like a broken drag rather
    // than an absent one.
    const flat: GapRow[] = [{ top: 0, height: 0, left: 0, width: 100 }];
    expect(gapLayout({ rows: flat, targetIndex: 0, edge: "before", boundaryTop: 0 })).toBeNull();
  });
});
