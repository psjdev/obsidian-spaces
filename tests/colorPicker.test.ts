import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_COLORS,
  addCustomColor,
  colorSwatches,
  isHexColor,
  normalizeHex,
  removeCustomColor,
} from "../src/ui/colorPicker";
import { PALETTE, PALETTE_NAMES, DEFAULT_SPACE_COLOR } from "../src/actions/spaceLifecycle";

describe("normalizeHex", () => {
  it("accepts a full hex, with or without the hash", () => {
    expect(normalizeHex("#5B5BFF")).toBe("#5b5bff");
    expect(normalizeHex("5b5bff")).toBe("#5b5bff");
  });

  it("expands shorthand, because typing #f0a means something", () => {
    expect(normalizeHex("#f0a")).toBe("#ff00aa");
  });

  it("trims surrounding whitespace, which paste brings along", () => {
    expect(normalizeHex("  #5b5bff  ")).toBe("#5b5bff");
  });

  it("rejects anything that is not a color", () => {
    for (const bad of ["", "#", "#12", "#12345", "#1234567", "rebeccapurple", "#zzzzzz"]) {
      expect(normalizeHex(bad)).toBeNull();
    }
  });
});

describe("isHexColor", () => {
  it("matches the schema's own COLOR shape", () => {
    expect(isHexColor("#5b5bff")).toBe(true);
    expect(isHexColor("#f0a")).toBe(false);
    expect(isHexColor("nope")).toBe(false);
  });
});

describe("addCustomColor", () => {
  it("adds newest first", () => {
    expect(addCustomColor(["#111111"], PALETTE, "#222222")).toEqual(["#222222", "#111111"]);
  });

  it("normalises on the way in", () => {
    expect(addCustomColor([], PALETTE, "#ABC")).toEqual(["#aabbcc"]);
  });

  it("moves an existing custom to the front rather than duplicating it", () => {
    expect(addCustomColor(["#111111", "#222222"], PALETTE, "#222222")).toEqual([
      "#222222",
      "#111111",
    ]);
  });

  it("refuses a color the built-in palette already has", () => {
    // A chip duplicating a palette swatch is a second button doing the same
    // thing, and it would push a genuinely custom color out of the cap.
    expect(addCustomColor([], PALETTE, PALETTE[0])).toEqual([]);
  });

  it("refuses a palette color regardless of case", () => {
    expect(addCustomColor([], PALETTE, PALETTE[0].toUpperCase())).toEqual([]);
  });

  it("ignores a value that is not a color", () => {
    expect(addCustomColor(["#111111"], PALETTE, "banana")).toEqual(["#111111"]);
  });

  it("caps the list, evicting the oldest", () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_CUSTOM_COLORS + 3; i++) {
      list = addCustomColor(list, PALETTE, `#0000${i.toString(16).padStart(2, "0")}`);
    }
    expect(list).toHaveLength(MAX_CUSTOM_COLORS);
    expect(list[0]).toBe("#00000e");
  });

  it("does not mutate the list it was given", () => {
    const before = ["#111111"];
    addCustomColor(before, PALETTE, "#222222");
    expect(before).toEqual(["#111111"]);
  });
});

describe("removeCustomColor", () => {
  it("removes regardless of case or shorthand", () => {
    expect(removeCustomColor(["#aabbcc", "#111111"], "#ABC")).toEqual(["#111111"]);
  });

  it("leaves the list alone for a value it does not hold", () => {
    expect(removeCustomColor(["#111111"], "#222222")).toEqual(["#111111"]);
  });
});

describe("colorSwatches", () => {
  const base = { palette: PALETTE, paletteNames: PALETTE_NAMES, customs: [] as string[] };

  it("lists the palette first, with its names", () => {
    const out = colorSwatches({ ...base, current: PALETTE[0] });
    expect(out.slice(0, PALETTE.length).map((s) => s.color)).toEqual([...PALETTE]);
    expect(out[0].label).toBe(PALETTE_NAMES[0]);
  });

  it("marks exactly one swatch selected", () => {
    const out = colorSwatches({ ...base, current: PALETTE[2] });
    expect(out.filter((s) => s.selected).map((s) => s.color)).toEqual([PALETTE[2]]);
  });

  it("appends customs after the palette, flagged as custom", () => {
    const out = colorSwatches({ ...base, customs: ["#123456"], current: PALETTE[0] });
    const last = out[out.length - 1];
    expect(last.color).toBe("#123456");
    expect(last.custom).toBe(true);
  });

  it("labels a custom chip with its hex, since it has no name (9.6)", () => {
    const out = colorSwatches({ ...base, customs: ["#123456"], current: PALETTE[0] });
    expect(out[out.length - 1].label).toBe("#123456");
  });

  it("does not repeat a custom that duplicates a palette color", () => {
    const out = colorSwatches({ ...base, customs: [PALETTE[1]], current: PALETTE[0] });
    expect(out.filter((s) => s.color.toLowerCase() === PALETTE[1].toLowerCase())).toHaveLength(1);
  });

  it("marks palette swatches as not removable — they are the floor", () => {
    const out = colorSwatches({ ...base, current: PALETTE[0] });
    expect(out.every((s) => !s.removable)).toBe(true);
  });

  it("marks a saved custom chip removable", () => {
    const out = colorSwatches({ ...base, customs: ["#123456"], current: PALETTE[0] });
    expect(out[out.length - 1]).toMatchObject({ color: "#123456", removable: true });
  });

  it("does NOT mark the synthesised current color removable", () => {
    // It is shown for reference and is not in `customs`, so a delete button on
    // it would be a control that does nothing.
    const out = colorSwatches({ ...base, current: "#abcdef" });
    const sel = out.filter((s) => s.selected);
    expect(sel[0]).toMatchObject({ color: "#abcdef", custom: true, removable: false });
  });

  it("shows the current color even when nothing else lists it", () => {
    // A space from before a palette change, or a hand-edited data.json.
    // Showing nothing selected would suggest the space has no color at all.
    const out = colorSwatches({ ...base, current: "#abcdef" });
    const sel = out.filter((s) => s.selected);
    expect(sel).toHaveLength(1);
    expect(sel[0].color).toBe("#abcdef");
  });

  it("matches the current color case-insensitively", () => {
    const out = colorSwatches({ ...base, current: PALETTE[0].toUpperCase() });
    expect(out.filter((s) => s.selected)).toHaveLength(1);
    expect(out).toHaveLength(PALETTE.length);
  });
});

describe("DEFAULT_SPACE_COLOR", () => {
  /**
   * The pairing the create panel depends on: the color a new space starts
   * with must be the swatch the popover shows selected when it opens.
   *
   * Two constants, one rule — so this is pinned rather than left to the two
   * happening to agree. Reordering `PALETTE` without moving the default would
   * open the popover with its highlight on one swatch while the space wears
   * another, which is precisely the state that made the old rotating default
   * confusing.
   */
  it("is the first swatch in the palette", () => {
    expect(DEFAULT_SPACE_COLOR).toBe(PALETTE[0]);
  });

  it("opens the popover with the first swatch already selected", () => {
    const out = colorSwatches({
      palette: PALETTE,
      paletteNames: PALETTE_NAMES,
      customs: [],
      current: DEFAULT_SPACE_COLOR,
    });
    expect(out[0].selected).toBe(true);
    expect(out.filter((s) => s.selected)).toHaveLength(1);
  });

  it("is the neutral swatch, not one of the rotation's colors", () => {
    // `nextPaletteColor` rotates `PALETTE.slice(1)` and must never hand out
    // the neutral one — so the opt-in default and the auto-assignment can
    // never collide.
    const vivid = PALETTE.slice(1);
    expect(vivid).not.toContain(DEFAULT_SPACE_COLOR);
  });
});
