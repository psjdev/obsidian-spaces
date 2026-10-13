/**
 * Which rows a windowed list builds.
 *
 * Layer 1: pure functions, no DOM, no `obsidian`. That is the whole reason
 * the module exists apart from the panel. jsdom reports every height and every
 * scroll offset as zero, so a windowing rule written against elements could
 * only be tested by a test that cannot see what it claims to: these drive the
 * rule with the numbers a real scroller produces, and the numbers below are
 * the measured ones (a 344 px viewport, a 25 px row pitch, 206 rows for an
 * open `created` in the 5,000-note fixture).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERSCAN,
  spacerHeight,
  visibleRange,
  windowCovering,
} from "../src/ui/rowWindow";

/** The measured picker: 344 px of viewport, 25 px rows, an open `created`. */
const PICKER = { scrollTop: 0, viewportHeight: 344, rowHeight: 25, count: 206 };

describe("visibleRange", () => {
  it("builds the rows on screen and a few either side, not the whole list", () => {
    // 344/25 is 13.8 rows, so 14 are on screen; the overscan adds 3 below and
    // there is nothing above row 0 to add. The other 189 rows are the 93% of
    // the work that was never seen.
    expect(visibleRange(PICKER)).toEqual({ first: 0, last: 17 });
  });

  it("moves with the scroller", () => {
    expect(visibleRange({ ...PICKER, scrollTop: 1000 })).toEqual({ first: 37, last: 57 });
  });

  it("never builds more rows than fit the viewport plus the overscan", () => {
    for (let top = 0; top <= 206 * 25; top += 37) {
      const { first, last } = visibleRange({ ...PICKER, scrollTop: top });
      expect(last - first).toBeLessThanOrEqual(14 + 2 * DEFAULT_OVERSCAN + 1);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last).toBeLessThanOrEqual(206);
      expect(last).toBeGreaterThanOrEqual(first);
    }
  });

  it("renders EVERYTHING when the viewport has not been measured", () => {
    // The panel's own fallback, and the one that keeps the existing suite
    // meaningful: jsdom has no layout, so every test that drives the picker
    // measures a zero-height scroller and must still see every row.
    expect(visibleRange({ ...PICKER, viewportHeight: 0 })).toEqual({ first: 0, last: 206 });
    expect(visibleRange({ ...PICKER, viewportHeight: -1 })).toEqual({ first: 0, last: 206 });
    expect(visibleRange({ ...PICKER, viewportHeight: Number.NaN })).toEqual({ first: 0, last: 206 });
    expect(visibleRange({ ...PICKER, viewportHeight: Number.POSITIVE_INFINITY })).toEqual({
      first: 0,
      last: 206,
    });
  });

  it("renders EVERYTHING when no row has been measured yet", () => {
    // A row pitch is read off a drawn row, so the first draw of a body that
    // has never been laid out has no pitch to window by.
    expect(visibleRange({ ...PICKER, rowHeight: 0 })).toEqual({ first: 0, last: 206 });
    expect(visibleRange({ ...PICKER, rowHeight: Number.NaN })).toEqual({ first: 0, last: 206 });
  });

  it("has nothing to draw for an empty list", () => {
    expect(visibleRange({ ...PICKER, count: 0 })).toEqual({ first: 0, last: 0 });
    expect(visibleRange({ ...PICKER, count: 0, viewportHeight: 0 })).toEqual({ first: 0, last: 0 });
  });

  it("clamps a scroll offset that is past the end of a list that just shrank", () => {
    // The filter box narrowing the list redraws BEFORE the browser clamps its
    // own `scrollTop`, so the stale offset must not window past the end: the
    // tail of the new list is what the browser is about to show.
    expect(visibleRange({ ...PICKER, count: 20, scrollTop: 5000 })).toEqual({ first: 3, last: 20 });
  });

  it("treats a negative or unreadable scroll offset as the top", () => {
    expect(visibleRange({ ...PICKER, scrollTop: -400 })).toEqual({ first: 0, last: 17 });
    expect(visibleRange({ ...PICKER, scrollTop: Number.NaN })).toEqual({ first: 0, last: 17 });
  });

  it("takes an overscan of zero literally, and refuses a nonsense one", () => {
    expect(visibleRange({ ...PICKER, scrollTop: 1000, overscan: 0 })).toEqual({
      first: 40,
      last: 54,
    });
    expect(visibleRange({ ...PICKER, scrollTop: 1000, overscan: -5 })).toEqual(
      visibleRange({ ...PICKER, scrollTop: 1000 })
    );
    expect(visibleRange({ ...PICKER, scrollTop: 1000, overscan: Number.NaN })).toEqual(
      visibleRange({ ...PICKER, scrollTop: 1000 })
    );
  });

  it("draws a short list whole, however it is scrolled", () => {
    expect(visibleRange({ ...PICKER, count: 9 })).toEqual({ first: 0, last: 9 });
  });
});

describe("windowCovering", () => {
  it("leaves the window alone when the row is already in it", () => {
    expect(windowCovering(5, PICKER)).toEqual(visibleRange(PICKER));
  });

  it("moves the window to a row below it, rather than stretching to reach", () => {
    // Stretching would make restoring focus cost more rows than an ordinary
    // draw, which is the one thing windowing exists to prevent.
    const moved = windowCovering(120, PICKER);
    expect(moved.first).toBeLessThanOrEqual(120);
    expect(moved.last).toBeGreaterThan(120);
    expect(moved.last - moved.first).toBeLessThanOrEqual(14 + 2 * DEFAULT_OVERSCAN + 1);
  });

  it("moves the window to a row above it", () => {
    const moved = windowCovering(4, { ...PICKER, scrollTop: 2000 });
    expect(moved.first).toBeLessThanOrEqual(4);
    expect(moved.last).toBeGreaterThan(4);
  });

  it("gives the plain window back for a row that is not in the list", () => {
    expect(windowCovering(999, PICKER)).toEqual(visibleRange(PICKER));
    expect(windowCovering(-1, PICKER)).toEqual(visibleRange(PICKER));
  });

  it("gives the plain window back while the list is being drawn whole", () => {
    const all = { ...PICKER, viewportHeight: 0 };
    expect(windowCovering(200, all)).toEqual({ first: 0, last: 206 });
  });
});

describe("spacerHeight", () => {
  it("stands in for the rows it replaces", () => {
    expect(spacerHeight(189, 25)).toBe(4725);
  });

  it("is zero when there is nothing to stand in for", () => {
    expect(spacerHeight(0, 25)).toBe(0);
    expect(spacerHeight(-3, 25)).toBe(0);
    expect(spacerHeight(10, 0)).toBe(0);
    expect(spacerHeight(10, Number.NaN)).toBe(0);
  });
});
