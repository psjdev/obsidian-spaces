/**
 * The appearance validators after the move into `definitions/`.
 *
 * `tests/colorPicker.test.ts` and `tests/iconPicker.test.ts` already cover
 * what `normalizeHex` and `isIconIdShape` DO, and they still import them from
 * `ui/`, so they are the behaviour half of the move evidence. What is not
 * covered there is the part a move can break silently: that the old import
 * paths hand out the same function object rather than a second copy, and that
 * `PALETTE`/`PALETTE_NAMES` stayed a single parallel pair.
 *
 * Layer 1: pure, no `obsidian`.
 */
import { describe, expect, it } from "vitest";
import {
  PALETTE,
  PALETTE_NAMES,
  isIconIdShape,
  normalizeHex,
} from "../src/definitions/appearance";
import { normalizeHex as viaColorPicker } from "../src/ui/colorPicker";
import { isIconIdShape as viaIconPicker } from "../src/ui/iconPicker";
import {
  PALETTE as viaSpaceLifecycle,
  PALETTE_NAMES as namesViaSpaceLifecycle,
} from "../src/actions/spaceLifecycle";

describe("definitions/appearance", () => {
  it("hands the same normalizeHex out through ui/colorPicker", () => {
    expect(viaColorPicker).toBe(normalizeHex);
  });

  it("hands the same isIconIdShape out through ui/iconPicker", () => {
    expect(viaIconPicker).toBe(isIconIdShape);
  });

  it("hands the same PALETTE arrays out through actions/spaceLifecycle", () => {
    expect(viaSpaceLifecycle).toBe(PALETTE);
    expect(namesViaSpaceLifecycle).toBe(PALETTE_NAMES);
  });

  it("keeps PALETTE and PALETTE_NAMES parallel", () => {
    // The two are indexed against each other: a swatch whose name is
    // read by index would silently label itself with a neighbour's name.
    expect(PALETTE_NAMES).toHaveLength(PALETTE.length);
  });

  it("only accepts colors schema.ts's COLOR regex would also accept", () => {
    // `normalizeHex` is the write-path gate for a space color; a value it
    // passes and `validateDefinitions` then rejects would fail the whole
    // document rather than the one field.
    for (const input of ["#5B5BFF", "5b5bff", "#f0a", "  #5b5bff  "]) {
      const hex = normalizeHex(input);
      expect(hex).not.toBeNull();
      expect(/^#[0-9a-f]{6}$/.test(hex as string)).toBe(true);
    }
  });

  it("normalizes every PALETTE entry to itself", () => {
    for (const color of PALETTE) expect(normalizeHex(color)).toBe(color);
  });
});

describe("the neutral swatch", () => {
  // Measured against Obsidian 1.13.7: `--icon-color` is #b3b3b3 in the default
  // dark theme and #5c5c5c in the default light one. A stored color is a
  // fixed hex (schema.ts's COLOR regex), so it cannot follow a theme switch —
  // #808080 is the midpoint, legible on either ground rather than correct on
  // one and washed out on the other.
  it("leads the palette", () => {
    expect(PALETTE[0]).toBe("#808080");
  });

  it("is named, like every other swatch", () => {
    // Color must never be the only label a control carries.
    expect(PALETTE_NAMES[0]).toBe("Neutral");
  });
});
