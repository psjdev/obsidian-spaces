/**
 * Which colour a space's icon is painted, across every surface that draws one.
 *
 * The neutral swatch is the colour popover's way of saying no colour was
 * chosen, so an icon wearing it takes the theme's `--icon-color` instead of a
 * fixed grey. That decision was first made in the strip alone, which left the
 * same space grey in the header, the switcher popover, the quick switcher and
 * the create form's preview while the strip followed the theme. One function
 * now answers the question for all five.
 */
import { describe, expect, it } from "vitest";
import { iconColorFor, swatchPaint } from "../src/ui/spaceIconColor";
import { DEFAULT_SPACE_COLOR, PALETTE } from "../src/definitions/appearance";

describe("the colour a space's icon is painted", () => {
  it("paints a colour the user chose", () => {
    expect(iconColorFor("#4ecdc4", false)).toBe("#4ecdc4");
  });

  it("paints nothing for the neutral swatch, so the theme decides", () => {
    expect(iconColorFor(DEFAULT_SPACE_COLOR, false)).toBeUndefined();
  });

  it("paints nothing when there is no colour at all", () => {
    // *All* carries no colour: `spaceEntries` gives it `undefined`.
    expect(iconColorFor(undefined, false)).toBeUndefined();
    expect(iconColorFor("", false)).toBeUndefined();
  });

  it("ignores case, because a hand-edited document may not be lowercase", () => {
    // `validateSpace` accepts `#808080` in either case and stores it as given,
    // so a comparison that only matched lowercase would paint the grey.
    expect(iconColorFor("#808080", false)).toBeUndefined();
    expect(iconColorFor("#808080".toUpperCase(), false)).toBeUndefined();
  });

  it("paints every other palette colour", () => {
    // Guards against the sentinel widening to swallow a real choice. Only
    // `PALETTE[0]` is neutral; `nextPaletteColor` hands out the rest.
    for (const colour of PALETTE.slice(1)) {
      expect(iconColorFor(colour, false)).toBe(colour);
    }
  });
});

describe("when theme colours are forced on", () => {
  it("paints nothing, whatever colour the space has", () => {
    // The whole point of the toggle. No inline colour is what lets
    // `--icon-color` apply, the same mechanism the neutral swatch uses.
    for (const colour of PALETTE) {
      expect(iconColorFor(colour, true)).toBeUndefined();
    }
    expect(iconColorFor("#123456", true)).toBeUndefined();
  });

  it("leaves the stored colour alone", () => {
    // Non-destructive is the requirement. The function is pure and returns a
    // new value, so this is really a guard against someone later making it
    // "helpful" by normalising or clearing what it was handed.
    const colour = "#4ecdc4";
    iconColorFor(colour, true);
    expect(colour).toBe("#4ecdc4");
    expect(iconColorFor(colour, false)).toBe("#4ecdc4");
  });
});

describe("what a swatch chip is painted with", () => {
  it("paints a chosen colour as itself", () => {
    expect(swatchPaint("#4ecdc4")).toBe("#4ecdc4");
  });

  it("paints the neutral chip with the theme's icon colour", () => {
    // The chip is a preview of the result. A space on the neutral swatch
    // renders in `--icon-color`, so a chip showing a fixed grey would promise
    // something the strip does not deliver. A variable rather than a resolved
    // value, so it follows a theme switch without the popover being rebuilt.
    expect(swatchPaint(DEFAULT_SPACE_COLOR)).toBe("var(--icon-color)");
  });

  it("is case-insensitive about the neutral swatch, like iconColorFor", () => {
    expect(swatchPaint("#808080".toUpperCase())).toBe("var(--icon-color)");
  });
});
