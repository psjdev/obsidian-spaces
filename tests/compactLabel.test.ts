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
import { compactLabel } from "../src/ui/compactLabel";

describe("compactLabel", () => {
  it("names the last segment the tip and the rest leads, separated", () => {
    expect(compactLabel(["Work", "Clients", "Northwind"])).toEqual([
      { text: "Work", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Clients", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Northwind", role: "tip" },
    ]);
  });

  it("handles two segments, the shortest run that compacts", () => {
    expect(compactLabel(["Work", "Clients"])).toEqual([
      { text: "Work", role: "lead" },
      { text: "/", role: "sep" },
      { text: "Clients", role: "tip" },
    ]);
  });

  it("returns a single segment as the tip, with no separator", () => {
    // A caller cannot produce a stray leading or trailing separator from this.
    expect(compactLabel(["Work"])).toEqual([{ text: "Work", role: "tip" }]);
  });

  it("returns nothing for no segments rather than throwing", () => {
    // Not reachable through `buildChainIndex`, which never emits a run shorter
    // than two segments. A label is cosmetic, so an empty one beats a crash in
    // the render path, and a variant written with `segments[0]` would throw.
    expect(compactLabel([])).toEqual([]);
  });

  it("still reads as the joined path once the parts are concatenated", () => {
    // What the user actually sees, whatever a variant does with the roles.
    expect(
      compactLabel(["Work", "Clients", "Northwind"])
        .map((p) => p.text)
        .join("")
    ).toBe("Work/Clients/Northwind");
  });
});
