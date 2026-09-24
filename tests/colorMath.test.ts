import { describe, expect, it } from "vitest";
import {
  hexToHsv,
  hsvToHex,
  hueFromPoint,
  svFromPoint,
  wrapHue,
  type Hsv,
} from "../src/ui/colorMath";
import { PALETTE } from "../src/actions/spaceLifecycle";

describe("hsvToHex", () => {
  it("produces the primaries at full saturation and value", () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe("#00ff00");
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe("#0000ff");
  });

  it("produces black and white at the extremes", () => {
    expect(hsvToHex({ h: 200, s: 0.5, v: 0 })).toBe("#000000");
    expect(hsvToHex({ h: 200, s: 0, v: 1 })).toBe("#ffffff");
  });

  it("wraps hue rather than clamping it, because hue is a circle", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe(hsvToHex({ h: 0, s: 1, v: 1 }));
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe(hsvToHex({ h: 240, s: 1, v: 1 }));
  });

  it("clamps saturation and value instead of emitting a broken hex", () => {
    expect(hsvToHex({ h: 0, s: 5, v: 5 })).toBe("#ff0000");
    expect(hsvToHex({ h: 0, s: -1, v: -1 })).toBe("#000000");
  });

  it("always emits six digits", () => {
    for (const h of [0, 45, 90, 200, 359]) {
      expect(hsvToHex({ h, s: 0.05, v: 0.05 })).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("hexToHsv", () => {
  it("reads the primaries back", () => {
    expect(hexToHsv("#ff0000")).toMatchObject({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#00ff00")).toMatchObject({ h: 120, s: 1, v: 1 });
    expect(hexToHsv("#0000ff")).toMatchObject({ h: 240, s: 1, v: 1 });
  });

  it("treats greys as zero saturation", () => {
    expect(hexToHsv("#808080")?.s).toBe(0);
    expect(hexToHsv("#000000")).toMatchObject({ h: 0, s: 0, v: 0 });
  });

  it("accepts a missing hash and any case", () => {
    expect(hexToHsv("FF0000")).toMatchObject({ h: 0, s: 1, v: 1 });
  });

  it("returns null rather than a silent black for a non-color", () => {
    // The caller decides what to do with an unparseable field; handing back
    // black would quietly change the user's color to something they never
    // picked.
    for (const bad of ["", "#12345", "nope", "#zzzzzz", "#f0a"]) {
      expect(hexToHsv(bad)).toBeNull();
    }
  });
});

describe("hex ↔ hsv round trip", () => {
  it("survives a round trip for every palette color", () => {
    for (const color of PALETTE) {
      const hsv = hexToHsv(color) as Hsv;
      expect(hsvToHex(hsv)).toBe(color.toLowerCase());
    }
  });

  it("survives a round trip for awkward values", () => {
    for (const color of ["#010203", "#fefefe", "#123456", "#00ff7f"]) {
      expect(hsvToHex(hexToHsv(color) as Hsv)).toBe(color);
    }
  });
});

describe("svFromPoint", () => {
  it("maps left-to-right as saturation and bottom-to-top as value", () => {
    // Matches how the gradient is painted: white on the left, black at the
    // bottom. Inverting either axis would make the dot chase the pointer.
    expect(svFromPoint(0, 0, 100, 100)).toEqual({ s: 0, v: 1 });
    expect(svFromPoint(100, 100, 100, 100)).toEqual({ s: 1, v: 0 });
    expect(svFromPoint(50, 50, 100, 100)).toEqual({ s: 0.5, v: 0.5 });
  });

  it("clamps a pointer dragged outside the field", () => {
    // Pointer capture keeps delivering events past the edge, which is exactly
    // when someone is reaching for pure white or black.
    expect(svFromPoint(-40, -40, 100, 100)).toEqual({ s: 0, v: 1 });
    expect(svFromPoint(400, 400, 100, 100)).toEqual({ s: 1, v: 0 });
  });

  it("returns a usable value for a zero-sized field", () => {
    expect(svFromPoint(10, 10, 0, 0)).toEqual({ s: 0, v: 0 });
  });
});

describe("hueFromPoint", () => {
  it("spans 0 to 360 across the bar", () => {
    expect(hueFromPoint(0, 200)).toBe(0);
    expect(hueFromPoint(100, 200)).toBe(180);
    expect(hueFromPoint(200, 200)).toBe(360);
  });

  it("clamps outside the bar", () => {
    expect(hueFromPoint(-50, 200)).toBe(0);
    expect(hueFromPoint(500, 200)).toBe(360);
  });

  it("does not divide by a zero width", () => {
    expect(hueFromPoint(10, 0)).toBe(0);
  });
});

describe("wrapHue", () => {
  it("wraps in both directions", () => {
    expect(wrapHue(370)).toBe(10);
    expect(wrapHue(-10)).toBe(350);
    expect(wrapHue(0)).toBe(0);
  });

  it("survives a non-finite input", () => {
    expect(wrapHue(Number.NaN)).toBe(0);
  });
});
