import { describe, expect, it } from "vitest";
import { DESIGN_RAIL_GAP, MIN_RAIL_GAP, stripAlignment } from "../src/ui/stripAlign";

/**
 * The live measurements this feature was designed against: strip docked left,
 * *All* pinned, the space header shown. Every case below perturbs one value of
 * this baseline so a failure names the thing that broke.
 */
const LIVE = {
  toolbarCentre: 61,
  anchorCentre: 95,
  pinned: { top: 46, height: 28 },
  firstIcon: { top: 91, height: 28 },
  currentPadTop: 6,
  currentRailGap: DESIGN_RAIL_GAP,
  railScroll: 0,
} as const;

describe("vertical strip alignment", () => {
  it("centres the pinned icon on the toolbar row", () => {
    // Pinned centre is 60, the toolbar's is 61, so one more pixel of padding.
    expect(stripAlignment(LIVE).padTop).toBe(7);
  });

  it("centres the rail's first icon on the header row", () => {
    // First icon's centre is 105 and wants to be 95, so the gap above the
    // rail loses 10 -- plus the 1px the padding change just pushed it down.
    expect(stripAlignment(LIVE).railGap).toBe(DESIGN_RAIL_GAP - 11);
  });

  it("does not double-count the padding shift in the rail gap", () => {
    // Same geometry, but the toolbar needs no correction at all. The rail is
    // then 10 out rather than 11: the difference is exactly the padding shift,
    // which proves the gap is solved against where the icon WILL be.
    const level = stripAlignment({ ...LIVE, toolbarCentre: 60 });
    expect(level.padTop).toBe(LIVE.currentPadTop);
    expect(level.railGap).toBe(DESIGN_RAIL_GAP - 10);
  });

  it("solves against the gap currently in effect, not the design value", () => {
    // A second pass over an already-aligned strip must be a no-op. Feeding
    // back the first pass's own output is the only way to catch a solver that
    // silently assumes it always starts from the stylesheet's value.
    const first = stripAlignment(LIVE);
    const settled = stripAlignment({
      ...LIVE,
      currentPadTop: first.padTop ?? LIVE.currentPadTop,
      currentRailGap: first.railGap ?? LIVE.currentRailGap,
      pinned: { ...LIVE.pinned, top: 47 },
      firstIcon: { ...LIVE.firstIcon, top: 81 },
    });
    expect(settled.padTop).toBe(first.padTop);
    expect(settled.railGap).toBe(first.railGap);
  });
});

describe("a scrolled rail", () => {
  it("aligns the rail's origin, not wherever scrolling has put the first icon", () => {
    // Scrolling moves the first icon UP out of view; its rect follows. Read
    // literally, that says the icon needs 150px more gap above it, and the
    // solve would push the rail down by 150 to "correct" a scroll position.
    // Live, that turned a 6px gap into 156px and left a hole above the rail
    // that survived scrolling back to the top.
    const scrolled = stripAlignment({
      ...LIVE,
      firstIcon: { ...LIVE.firstIcon, top: LIVE.firstIcon.top - 150 },
      railScroll: 150,
    });
    expect(scrolled).toEqual(stripAlignment(LIVE));
  });

  it("has no opinion when the scroll offset is not a number", () => {
    expect(stripAlignment({ ...LIVE, railScroll: Number.NaN }).railGap).toBeNull();
  });
});

describe("nothing to align to", () => {
  it("has no opinion on padding when no toolbar is on screen", () => {
    // A theme can hide `nav-header` outright.
    const out = stripAlignment({ ...LIVE, toolbarCentre: null });
    expect(out.padTop).toBeNull();
    // The rail still aligns, and against an UNSHIFTED icon, because the
    // padding it would have shifted was left alone.
    expect(out.railGap).toBe(DESIGN_RAIL_GAP - 10);
  });

  it("has no opinion on the rail when there is no row to anchor to", () => {
    // Header off and an empty tree: nothing below the toolbar to line up with.
    const out = stripAlignment({ ...LIVE, anchorCentre: null });
    expect(out.railGap).toBeNull();
    expect(out.padTop).toBe(7);
  });

  it("has no opinion when the boxes it measures are missing", () => {
    expect(stripAlignment({ ...LIVE, pinned: null }).padTop).toBeNull();
    expect(stripAlignment({ ...LIVE, firstIcon: null }).railGap).toBeNull();
  });

  it("has no opinion on a box that has not been laid out yet", () => {
    // A rect measured before layout settles is all zeroes; centring on it
    // would yield a real-looking number computed from nothing.
    expect(stripAlignment({ ...LIVE, pinned: { top: 0, height: 0 } }).padTop).toBeNull();
    expect(stripAlignment({ ...LIVE, firstIcon: { top: 0, height: 0 } }).railGap).toBeNull();
  });

  it("has no opinion on measurements that are not finite", () => {
    expect(stripAlignment({ ...LIVE, toolbarCentre: Number.NaN }).padTop).toBeNull();
    expect(stripAlignment({ ...LIVE, anchorCentre: Number.NaN }).railGap).toBeNull();
    expect(stripAlignment({ ...LIVE, currentPadTop: Number.NaN }).padTop).toBeNull();
    expect(stripAlignment({ ...LIVE, currentRailGap: Number.NaN }).railGap).toBeNull();
  });
});

describe("clamping", () => {
  it("never pulls the strip above its own top edge", () => {
    // The grip is inserted ahead of the pinned icon while the strip is
    // unlocked, pushing it down further than padding can pull it back.
    const out = stripAlignment({ ...LIVE, pinned: { top: 120, height: 28 } });
    expect(out.padTop).toBe(0);
  });

  it("never overlaps the rail with the divider above it", () => {
    // The divider is 1px and lives inside this gap, so the gap cannot close
    // past it. A toolbar-height anchor is the realistic way to get there: the
    // correction is large enough to close the gap, small enough to believe.
    const out = stripAlignment({ ...LIVE, anchorCentre: 60 });
    expect(out.railGap).toBe(MIN_RAIL_GAP);
  });

  it("refuses an offset large enough to be a bad measurement", () => {
    const far = stripAlignment({ ...LIVE, toolbarCentre: 9000, anchorCentre: 9000 });
    expect(far.padTop).toBeNull();
    expect(far.railGap).toBeNull();
  });

  it("feeds the CLAMPED padding into the rail gap, not the ideal one", () => {
    // Padding wants -74 and gets 0. The rail must be solved against the 0.
    const out = stripAlignment({ ...LIVE, pinned: { top: 120, height: 28 } });
    expect(out.padTop).toBe(0);
    // padDelta is 0 - 6 = -6, so the icon lands 6 higher than measured.
    expect(out.railGap).toBe(DESIGN_RAIL_GAP - 10 + 6);
  });
});
