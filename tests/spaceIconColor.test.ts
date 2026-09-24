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
import { iconColorFor } from "../src/ui/spaceIconColor";
import { DEFAULT_SPACE_COLOR, PALETTE } from "../src/definitions/appearance";

describe("the colour a space's icon is painted", () => {
  it("paints a colour the user chose", () => {
    expect(iconColorFor("#4ecdc4")).toBe("#4ecdc4");
  });

  it("paints nothing for the neutral swatch, so the theme decides", () => {
    expect(iconColorFor(DEFAULT_SPACE_COLOR)).toBeUndefined();
  });

  it("paints nothing when there is no colour at all", () => {
    // *All* carries no colour: `spaceEntries` gives it `undefined`.
    expect(iconColorFor(undefined)).toBeUndefined();
    expect(iconColorFor("")).toBeUndefined();
  });

  it("ignores case, because a hand-edited document may not be lowercase", () => {
    // `validateSpace` accepts `#808080` in either case and stores it as given,
    // so a comparison that only matched lowercase would paint the grey.
    expect(iconColorFor("#808080")).toBeUndefined();
    expect(iconColorFor("#808080".toUpperCase())).toBeUndefined();
  });

  it("paints every other palette colour", () => {
    // Guards against the sentinel widening to swallow a real choice. Only
    // `PALETTE[0]` is neutral; `nextPaletteColor` hands out the rest.
    for (const colour of PALETTE.slice(1)) {
      expect(iconColorFor(colour)).toBe(colour);
    }
  });
});
