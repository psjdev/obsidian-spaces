/**
 * What a compacted row reads as.
 *
 * Isolated deliberately. The presentation is the part we expect to change
 * after looking at it in a real vault, and keeping it here means a variant is
 * this file, this test and a style rule, with nothing in the sort seam moving.
 */
import { describe, expect, it } from "vitest";
import { compactLabel } from "../src/ui/compactLabel";

describe("compactLabel", () => {
  it("joins the segments with a separator", () => {
    expect(compactLabel(["Work", "Clients", "Northwind"])).toBe("Work/Clients/Northwind");
  });

  it("joins two segments, the shortest run that compacts", () => {
    expect(compactLabel(["Work", "Clients"])).toBe("Work/Clients");
  });

  it("returns a single segment unchanged, so a caller cannot produce a stray separator", () => {
    expect(compactLabel(["Work"])).toBe("Work");
  });

  it("returns empty for no segments rather than throwing", () => {
    // Not reachable through `buildChainIndex`, which never emits an empty run.
    // A label is cosmetic, so an empty one beats a crash in the render path.
    expect(compactLabel([])).toBe("");
  });
});
