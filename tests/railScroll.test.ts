import { describe, expect, it } from "vitest";
import { PAD, railScrollOffset, railWheelDelta } from "../src/ui/railScroll";

/** A 100px-wide viewport scrolled to 0, with a 28px item at `itemOffset`. */
const at = (itemOffset: number, over: Partial<Parameters<typeof railScrollOffset>[0]> = {}) =>
  railScrollOffset({ scroll: 0, clientSize: 100, itemOffset, itemSize: 28, ...over });

describe("railScrollOffset", () => {
  it("leaves scroll untouched when the item is fully visible", () => {
    // Load-bearing: `render()` runs on every switch and every definitions
    // change, so returning anything but the input here would nudge the rail
    // continuously.
    expect(at(10)).toBe(0);
    expect(at(40, { scroll: 20, clientSize: 100 })).toBe(20);
  });

  it("scrolls right just far enough to reveal an item past the edge", () => {
    // item spans 200..228 in a viewport showing 0..100.
    expect(at(200)).toBe(200 + 28 + PAD - 100);
  });

  it("scrolls left to reveal an item before the viewport", () => {
    expect(at(30, { scroll: 120 })).toBe(30 - PAD);
  });

  it("never scrolls past zero", () => {
    // An item at the very start must not produce a negative scroll offset.
    expect(at(0, { scroll: 50 })).toBe(0);
    expect(at(2, { scroll: 50 })).toBe(0);
  });

  it("reveals an item only partially clipped at the right edge", () => {
    // spans 90..118, viewport 0..100 — visible but not wholly.
    expect(at(90)).toBe(90 + 28 + PAD - 100);
  });

  it("reveals an item only partially clipped at the left edge", () => {
    // scrolled to 100, item spans 90..118: its start is cut off.
    expect(at(90, { scroll: 100 })).toBe(90 - PAD);
  });

  it("aligns the start of an item wider than the viewport", () => {
    // Showing the end and hiding the start would be the wrong half: the icon
    // is at the start.
    expect(at(300, { itemSize: 400 })).toBe(300 - PAD);
  });

  it("is stable for an item nearly as wide as the rail", () => {
    // The hazard this guards: without the oversize branch such an item
    // satisfies "starts too early" and "ends too late" on alternate calls, so
    // `render()` flips the scroll offset between two values forever.
    // Idempotence is the property that matters, so it is asserted across two
    // calls.
    // The offset must be away from the left edge: near zero the left-edge
    // branch clamps to 0 and hides the oscillation. An earlier version of this
    // test used offset 5 and passed with the guard REMOVED, pinning nothing.
    const args = { scroll: 0, clientSize: 100, itemOffset: 200, itemSize: 90 };
    const once = railScrollOffset(args);
    const twice = railScrollOffset({ ...args, scroll: once });
    const thrice = railScrollOffset({ ...args, scroll: twice });
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it("returns the current scroll offset for a zero-size rail", () => {
    // A collapsed sidebar reports clientSize 0; anything else would fabricate
    // a scroll position for an element nobody can see.
    expect(at(200, { clientSize: 0, scroll: 7 })).toBe(7);
  });

  it("survives a non-finite measurement", () => {
    expect(at(Number.NaN, { scroll: 5 })).toBe(5);
  });
});

/** A rail showing 100px of 500px of icons, scrolled to `scroll`. */
const wheel = (
  over: Partial<Parameters<typeof railWheelDelta>[0]> = {}
) => railWheelDelta({ along: 0, across: 0, scroll: 0, scrollSize: 500, clientSize: 100, ...over });

describe("railWheelDelta", () => {
  it("moves a horizontal rail by an ordinary wheel's vertical delta", () => {
    // The bug this exists for: a mouse wheel reports only `deltaY`, and
    // Chromium will not apply that to a scroller that only scrolls on X, so
    // without this the docked-top/bottom rail could not be scrolled at all.
    expect(wheel({ across: 120 })).toBe(120);
  });

  it("leaves a gesture that already points along the rail to the browser", () => {
    // A trackpad's sideways swipe; the browser scrolls it natively, and
    // adding our own delta on top would move the rail twice as far.
    expect(wheel({ along: 120, across: 0 })).toBe(0);
    // Diagonal counts as along-axis for the same reason.
    expect(wheel({ along: 40, across: 120 })).toBe(0);
  });

  it("does nothing when the rail does not overflow", () => {
    // Few enough spaces to fit: the wheel belongs to the pane behind.
    expect(wheel({ across: 120, scrollSize: 100, clientSize: 100 })).toBe(0);
    expect(wheel({ across: 120, scrollSize: 80, clientSize: 100 })).toBe(0);
  });

  it("clamps to the distance actually left", () => {
    // 400px of travel, 380 already used: only 20 remains, and returning the
    // full 120 would have the caller cancel an event it cannot honour.
    expect(wheel({ across: 120, scroll: 380 })).toBe(20);
    expect(wheel({ across: -120, scroll: 50 })).toBe(-50);
  });

  it("returns zero at the end the wheel points at, so the event propagates", () => {
    // Load-bearing: the caller treats 0 as "not ours" and skips
    // `preventDefault()`, which is what keeps the file tree scrollable when
    // the pointer sits over a rail that has nowhere left to go.
    expect(wheel({ across: 120, scroll: 400 })).toBe(0);
    expect(wheel({ across: -120, scroll: 0 })).toBe(0);
  });

  it("survives a non-finite measurement", () => {
    expect(wheel({ across: Number.NaN })).toBe(0);
    expect(wheel({ along: Number.NaN, across: 120 })).toBe(0);
    expect(wheel({ across: 120, scroll: Number.NaN })).toBe(0);
  });
});
