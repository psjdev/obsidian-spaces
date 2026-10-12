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
import { compactLabel, maxDrop, type CompactLabelOptions } from "../src/ui/compactLabel";

/** Draw the whole joined path: what a row that FITS its pane is told. */
const PLAIN: CompactLabelOptions = { drop: 0 };
/**
 * Give up every folder this run will give up.
 *
 * Asked for as a number far beyond any real run rather than as `maxDrop` of
 * each one, because the clamp is the thing under test everywhere this is
 * used: a caller climbing until a row fits asks for one level more than
 * exists on its last round, and must get the shortest label rather than an
 * empty one or a throw.
 */
const FLOOR: CompactLabelOptions = { drop: Number.MAX_SAFE_INTEGER };

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
 * ABBREVIATION AT THE FLOOR, which is as far as a pane can push a row.
 *
 * Measured in a real vault at a 246px pane: the 48-character
 * `Research/2026/Q4/Projects/Atlas/Design/Decisions` overflows, and
 * `text-overflow: ellipsis` truncates from the RIGHT, so the one segment that
 * identifies the row is the first thing lost. The leading folders collapse to
 * `..` instead, and at the floor the two segments a reader needs survive.
 *
 * The DECISION is not taken here. The caller draws the row, measures it
 * against the pane and raises `drop` for as long as it does not fit, so these
 * tests assert what each level DRAWS. The one judgement this module keeps is
 * the two-segment guard: `Work/Shared` would become `../Shared`, which is
 * worse than leaving it alone at any pane width.
 */
describe("compactLabel abbreviation", () => {
  const DEEP = ["Research", "2026", "Q4", "Projects", "Atlas", "Design", "Decisions"];

  it("collapses everything above the tip's parent to a gap part", () => {
    expect(compactLabel(DEEP, FLOOR)).toEqual([
      { text: "..", role: "gap" },
      { text: "/", role: "sep" },
      { text: "Design", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Decisions", role: "tip" },
    ]);
  });

  it("reads as ../parent/tip once concatenated", () => {
    expect(text(DEEP, FLOOR)).toBe("../Design/Decisions");
  });

  it("puts the gap FIRST and leaves the tip last", () => {
    // Position is the whole shape: a gap anywhere but the head would claim
    // folders were elided from the middle, and a tip that is not last would
    // mean the row no longer ends in the folder it actually is.
    const parts = compactLabel(DEEP, FLOOR);
    expect(parts[0].role).toBe("gap");
    expect(parts[parts.length - 1]).toEqual({ text: "Decisions", role: "tip" });
    // Exactly one gap, and no `lead` above the parent survived it.
    expect(parts.filter((p) => p.role === "gap").length).toBe(1);
    expect(parts.filter((p) => p.role === "lead").map((p) => p.text)).toEqual(["Design"]);
  });

  it("does nothing when it is told not to, however deep the run", () => {
    expect(text(DEEP, PLAIN)).toBe("Research/2026/Q4/Projects/Atlas/Design/Decisions");
    expect(compactLabel(DEEP, PLAIN).some((p) => p.role === "gap")).toBe(false);
  });

  /**
   * THREE SEGMENTS IS THE SHORTEST RUN THAT SHORTENS, and the only boundary
   * left in this module. There is no folder count any more: a run of any
   * length above two draws short when the pane says it does not fit and whole
   * when it does. The dropdown's four thresholds, asserted here until now,
   * were a boundary in a number nobody could see; the real boundary is a pane
   * width, and `e2e/deep-compact.mjs` is where it is measured.
   */
  for (const length of [3, 4, 7, 12]) {
    const run = [...Array.from({ length: length - 1 }, (_, i) => `f${i}`), "tip"];

    it(`shortens a run of ${length} folders to ../parent/tip`, () => {
      expect(text(run, FLOOR)).toBe(`../${run[run.length - 2]}/tip`);
    });

    it(`draws the same run of ${length} folders whole when it is not told to`, () => {
      expect(text(run, PLAIN)).toBe(run.join("/"));
    });
  }

  it("shortens the three segment run the design names, when it is told to", () => {
    // Under the old folder count this row was left whole by the default
    // threshold whether or not it fitted its pane. The pane decides now.
    expect(text(["Clients", "Northwind", "Meetings"], FLOOR)).toBe("../Northwind/Meetings");
    expect(text(["Clients", "Northwind", "Meetings"], PLAIN)).toBe("Clients/Northwind/Meetings");
  });

  it("never abbreviates a two segment run, even when it is told to", () => {
    // `../Shared` is strictly worse than `Work/Shared`: it is no shorter to
    // read, and it trades a folder name the reader can use for a glyph that
    // says only "there was something here". A pane narrow enough to clip one
    // is narrow enough to clip the other, so the guard is structural and no
    // measurement overrides it.
    expect(text(["Work", "Shared"], FLOOR)).toBe("Work/Shared");
    expect(compactLabel(["Work", "Shared"], FLOOR).some((p) => p.role === "gap")).toBe(false);
  });

  it("never abbreviates one segment or none", () => {
    expect(compactLabel(["Work"], FLOOR)).toEqual([{ text: "Work", role: "tip" }]);
    expect(compactLabel([], FLOOR)).toEqual([]);
  });
});

/**
 * THE CLIMB: one folder at a time, which is the whole shape of shortening.
 *
 * The first version jumped. A row that did not fit lost everything above its
 * parent in one step, so a pane one character too narrow for a seven folder
 * run cost the reader five folder names to recover a few pixels, and every
 * width from "nearly fits" to "hopeless" drew the same label. Here each level
 * gives up exactly one more leading folder, and the caller stops at the first
 * one that fits.
 */
describe("compactLabel drop levels", () => {
  const DEEP = ["Research", "2026", "Q4", "Projects", "Atlas", "Design", "Decisions"];
  const at = (drop: number): string =>
    compactLabel(DEEP, { drop })
      .map((p) => p.text)
      .join("");

  it("gives up one leading folder per level, and keeps the rest", () => {
    // The row the user is reading, at every width it can be dragged through.
    expect(at(0)).toBe("Research/2026/Q4/Projects/Atlas/Design/Decisions");
    expect(at(1)).toBe("../2026/Q4/Projects/Atlas/Design/Decisions");
    expect(at(2)).toBe("../Q4/Projects/Atlas/Design/Decisions");
    expect(at(3)).toBe("../Projects/Atlas/Design/Decisions");
    expect(at(4)).toBe("../Atlas/Design/Decisions");
    expect(at(5)).toBe("../Design/Decisions");
  });

  it("stops at the parent however much further it is pushed", () => {
    // `maxDrop` is the floor, and a caller that keeps climbing past it gets
    // the same label rather than a shorter one. Without the clamp the next
    // level would be `../Decisions`, and the one after it `..`.
    expect(maxDrop(DEEP)).toBe(5);
    expect(at(6)).toBe("../Design/Decisions");
    expect(at(99)).toBe("../Design/Decisions");
  });

  it("draws the whole label for a level of zero or below", () => {
    // A caller subtracting its way down cannot produce a leading separator or
    // a stray gap by going past the bottom.
    expect(at(-1)).toBe("Research/2026/Q4/Projects/Atlas/Design/Decisions");
    expect(compactLabel(DEEP, { drop: -3 }).some((p) => p.role === "gap")).toBe(false);
  });

  it("truncates a fractional level rather than drawing half a folder", () => {
    expect(at(2.9)).toBe(at(2));
  });

  it("draws the whole label for a level that is not a number", () => {
    // NaN is what an arithmetic slip upstream produces, and a blank row is
    // the one outcome worse than a long one.
    expect(compactLabel(DEEP, { drop: Number.NaN }).map((p) => p.text).join("")).toBe(
      "Research/2026/Q4/Projects/Atlas/Design/Decisions"
    );
  });

  it("carries exactly one gap at every level that shortens, and none at zero", () => {
    expect(compactLabel(DEEP, { drop: 0 }).filter((p) => p.role === "gap").length).toBe(0);
    for (const drop of [1, 2, 3, 4, 5]) {
      const parts = compactLabel(DEEP, { drop });
      expect(parts.filter((p) => p.role === "gap").length).toBe(1);
      // The gap leads and the tip ends it, at every level.
      expect(parts[0].role).toBe("gap");
      expect(parts[parts.length - 1]).toEqual({ text: "Decisions", role: "tip" });
    }
  });

  it("names every surviving folder but the last a lead", () => {
    expect(compactLabel(DEEP, { drop: 4 })).toEqual([
      { text: "..", role: "gap" },
      { text: "/", role: "sep" },
      { text: "Atlas", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Design", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Decisions", role: "tip" },
    ]);
  });

  it("holds the two segment floor at every level", () => {
    // `maxDrop` is zero for a pair, so no level shortens it.
    expect(maxDrop(["Work", "Shared"])).toBe(0);
    for (const drop of [1, 2, 99]) {
      expect(
        compactLabel(["Work", "Shared"], { drop })
          .map((p) => p.text)
          .join("")
      ).toBe("Work/Shared");
    }
  });

  it("reports no room to climb for one segment or none", () => {
    expect(maxDrop(["Work"])).toBe(0);
    expect(maxDrop([])).toBe(0);
  });
});
