/**
 * What a compacted row reads as.
 *
 * Isolated deliberately. The presentation is the part we expect to change
 * after looking at it in a real vault, and keeping it here means a variant is
 * this file, this test and a style rule, with nothing in the sort seam moving.
 *
 * Asserted as PARTS, so these tests fail on purpose when a variant changes the
 * separator or the roles. That is the seam working, not a brittle test.
 */
import { describe, expect, it } from "vitest";
import { compactLabel, type CompactLabelOptions } from "../src/ui/compactLabel";

/** No abbreviation at all: the label the feature shipped with. */
const PLAIN: CompactLabelOptions = { abbreviate: false, threshold: 3 };
/** Abbreviation on at the default threshold. */
const ABBREV: CompactLabelOptions = { abbreviate: true, threshold: 3 };

const text = (segments: readonly string[], opts: CompactLabelOptions): string =>
  compactLabel(segments, opts)
    .map((p) => p.text)
    .join("");

describe("compactLabel", () => {
  it("names the last segment the tip and the rest leads, separated", () => {
    expect(compactLabel(["Work", "Clients", "Northwind"], PLAIN)).toEqual([
      { text: "Work", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Clients", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Northwind", role: "tip" },
    ]);
  });

  it("handles two segments, the shortest run that compacts", () => {
    expect(compactLabel(["Work", "Clients"], PLAIN)).toEqual([
      { text: "Work", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Clients", role: "tip" },
    ]);
  });

  it("returns a single segment as the tip, with no separator", () => {
    // A caller cannot produce a stray leading or trailing separator from this.
    expect(compactLabel(["Work"], PLAIN)).toEqual([{ text: "Work", role: "tip" }]);
  });

  it("returns nothing for no segments rather than throwing", () => {
    // Not reachable through `buildChainIndex`, which never emits a run shorter
    // than two segments. A label is cosmetic, so an empty one beats a crash in
    // the render path, and a variant written with `segments[0]` would throw.
    expect(compactLabel([], PLAIN)).toEqual([]);
  });

  it("still reads as the joined path once the parts are concatenated", () => {
    // What the user actually sees, whatever a variant does with the roles.
    expect(text(["Work", "Clients", "Northwind"], PLAIN)).toBe("Work/Clients/Northwind");
  });
});

/**
 * ABBREVIATION, the "parent only" shape.
 *
 * Measured in a real vault at a 246px pane: the 48-character
 * `Research/2026/Q4/Projects/Atlas/Design/Decisions` overflows, and
 * `text-overflow: ellipsis` truncates from the RIGHT, so the one segment that
 * identifies the row is the first thing lost. Everything above the tip's
 * IMMEDIATE PARENT collapses to `..` instead, and the two segments a reader
 * needs survive.
 *
 * Applied unconditionally this would turn `Work/Shared` into `../Shared`,
 * which is worse than leaving it alone. Hence the threshold, and hence the
 * boundary tests below.
 */
describe("compactLabel abbreviation", () => {
  const DEEP = ["Research", "2026", "Q4", "Projects", "Atlas", "Design", "Decisions"];

  it("collapses everything above the tip's parent to a gap part", () => {
    expect(compactLabel(DEEP, ABBREV)).toEqual([
      { text: "..", role: "gap" },
      { text: "/", role: "sep" },
      { text: "Design", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Decisions", role: "tip" },
    ]);
  });

  it("reads as ../parent/tip once concatenated", () => {
    expect(text(DEEP, ABBREV)).toBe("../Design/Decisions");
  });

  it("puts the gap FIRST and leaves the tip last", () => {
    // Position is the whole shape: a gap anywhere but the head would claim
    // folders were elided from the middle, and a tip that is not last would
    // mean the row no longer ends in the folder it actually is.
    const parts = compactLabel(DEEP, ABBREV);
    expect(parts[0].role).toBe("gap");
    expect(parts[parts.length - 1]).toEqual({ text: "Decisions", role: "tip" });
    // Exactly one gap, and no `lead` above the parent survived it.
    expect(parts.filter((p) => p.role === "gap").length).toBe(1);
    expect(parts.filter((p) => p.role === "lead").map((p) => p.text)).toEqual(["Design"]);
  });

  it("does nothing when abbreviation is off, however deep the run", () => {
    expect(text(DEEP, { abbreviate: false, threshold: 3 })).toBe(
      "Research/2026/Q4/Projects/Atlas/Design/Decisions"
    );
    expect(compactLabel(DEEP, PLAIN).some((p) => p.role === "gap")).toBe(false);
  });

  /**
   * THE BOUNDARY IS EXACT. "More than this many folders", so a run of exactly
   * N is left alone and N+1 abbreviates. Asserted at every value the dropdown
   * offers, because an off-by-one here is invisible until someone picks the
   * threshold that happens to sit on their deepest chain.
   */
  for (const threshold of [3, 4, 5, 6]) {
    const atEdge = Array.from({ length: threshold }, (_, i) => `f${i}`);
    const overEdge = [...atEdge, "tip"];

    it(`leaves a run of exactly ${threshold} folders in full`, () => {
      expect(text(atEdge, { abbreviate: true, threshold })).toBe(atEdge.join("/"));
      expect(compactLabel(atEdge, { abbreviate: true, threshold }).some((p) => p.role === "gap")).toBe(
        false
      );
    });

    it(`abbreviates a run of ${threshold + 1} folders`, () => {
      expect(text(overEdge, { abbreviate: true, threshold })).toBe(
        `../${overEdge[overEdge.length - 2]}/tip`
      );
    });
  }

  it("leaves the three segment run the design names alone at the default", () => {
    expect(text(["Clients", "Northwind", "Meetings"], ABBREV)).toBe(
      "Clients/Northwind/Meetings"
    );
  });

  it("never abbreviates a two segment run, whatever the threshold", () => {
    // `../Shared` is strictly worse than `Work/Shared`: it is no shorter to
    // read, and it trades a folder name the reader can use for a glyph that
    // says only "there was something here". Guarded structurally rather than
    // left to the dropdown's lowest option, so a threshold reached any other
    // way cannot produce it.
    for (const threshold of [0, 1, 2, 3, 6]) {
      expect(text(["Work", "Shared"], { abbreviate: true, threshold })).toBe("Work/Shared");
    }
  });

  it("never abbreviates one segment or none", () => {
    expect(compactLabel(["Work"], { abbreviate: true, threshold: 0 })).toEqual([
      { text: "Work", role: "tip" },
    ]);
    expect(compactLabel([], { abbreviate: true, threshold: 0 })).toEqual([]);
  });
});
