import { describe, expect, it } from "vitest";
import { nearestPlacement, passedThreshold } from "../src/ui/stripDrag";

const pane = { left: 0, top: 0, right: 300, bottom: 600 };

describe("which placement a pointer is asking for", () => {
  it("picks the edge it is nearest", () => {
    expect(nearestPlacement({ x: 5, y: 300 }, pane)).toBe("left");
    expect(nearestPlacement({ x: 295, y: 300 }, pane)).toBe("right");
    expect(nearestPlacement({ x: 150, y: 3 }, pane)).toBe("top");
    expect(nearestPlacement({ x: 150, y: 597 }, pane)).toBe("bottom");
  });

  it("favours the ribbon in a corner, within the bias", () => {
    // 10 from the left edge, 12 from the top: vertical wins on v <= h + 8.
    expect(nearestPlacement({ x: 10, y: 12 }, pane)).toBe("left");
  });

  it("still picks horizontal when it is clearly nearer", () => {
    expect(nearestPlacement({ x: 60, y: 2 }, pane)).toBe("top");
  });

  it("resolves opposite-edge ties deterministically", () => {
    expect(nearestPlacement({ x: 150, y: 300 }, pane)).toBe("left");
    expect(nearestPlacement({ x: 150, y: 300 }, { ...pane, right: 300, bottom: 300 })).toBe("bottom");
    // The other half of the same tie-break: dL=500, dR=500 (v=500) against
    // dT=300, dB=300 (h=300). 500 <= 300 + 8 is false, so this is the
    // horizontal branch, where dT <= dB is a genuine tie and resolves to
    // "top" -- unproven above, where dT <= dB always came out false.
    expect(
      nearestPlacement({ x: 500, y: 300 }, { left: 0, top: 0, right: 1000, bottom: 600 })
    ).toBe("top");
  });
});

describe("the movement threshold", () => {
  it("treats a small wobble as a click", () => {
    expect(passedThreshold({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
  });

  it("starts a drag once the pointer has really moved", () => {
    expect(passedThreshold({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(true);
  });
});
