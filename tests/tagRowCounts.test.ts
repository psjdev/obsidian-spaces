/**
 * What a tag row in the create panel's picker reports, and how it says it.
 *
 * Layer 1: pure functions, no DOM, no `obsidian`. Tested apart from the panel
 * because the panel around them is one of three look-and-feel candidates and
 * two of the three will be thrown away; the rule about WHEN the vault is asked
 * a question, and the copy the answer is dressed in, are meant to survive that.
 */

import { describe, expect, it, vi } from "vitest";
import { countTagRows, tagCountLabel } from "../src/ui/tagRowCounts";

describe("countTagRows", () => {
  it("counts each row through the supplied counter", () => {
    const counts: Record<string, number> = { project: 12, archive: 3 };
    expect(countTagRows([{ tag: "project" }, { tag: "archive" }], (t) => counts[t] ?? 0)).toEqual([
      { tag: "project", count: 12 },
      { tag: "archive", count: 3 },
    ]);
  });

  it("asks about the rows it was given and about nothing else", () => {
    // The invariant the panel depends on: the caller has already capped,
    // so counting is bounded by what is on screen. Counting first and
    // capping second would put one lookup per vault tag behind every keystroke.
    const countOf = vi.fn(() => 1);
    countTagRows([{ tag: "a" }, { tag: "b" }], countOf);
    expect(countOf.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("asks once per row, even for a repeated tag", () => {
    const countOf = vi.fn(() => 1);
    countTagRows([{ tag: "a" }, { tag: "a" }], countOf);
    expect(countOf).toHaveBeenCalledTimes(2);
  });

  it("asks nothing at all when there is nothing to draw", () => {
    const countOf = vi.fn(() => 1);
    expect(countTagRows([], countOf)).toEqual([]);
    expect(countOf).not.toHaveBeenCalled();
  });

  it("keeps the order it was given, because the tree already decided it", () => {
    const rows = [{ tag: "z" }, { tag: "a" }, { tag: "m" }];
    expect(countTagRows(rows, () => 0).map((r) => r.tag)).toEqual(["z", "a", "m"]);
  });

  it("carries the rest of the row through untouched", () => {
    // Rows are generic over what they carry besides `tag`, and the count is
    // added beside it. Spreading the row, not rebuilding it, is what keeps `match`.
    const match = { score: -1, matches: [[0, 4]] };
    expect(countTagRows([{ tag: "proj", match }], () => 2)).toEqual([
      { tag: "proj", match, count: 2 },
    ]);
  });
});

describe("tagCountLabel", () => {
  it("names what is being counted", () => {
    expect(tagCountLabel(12)).toBe("12 notes");
  });

  it("uses the singular for one", () => {
    expect(tagCountLabel(1)).toBe("1 note");
  });

  it("words zero rather than numbering it", () => {
    // A grey `0 notes` beside a tag reads as a count that failed to arrive.
    // The state is real: Obsidian lists a tag the moment it is typed, and the
    // metadata cache the index is built from can be a moment behind it.
    expect(tagCountLabel(0)).toBe("no notes");
  });

  it("treats a negative the same as none, rather than showing it", () => {
    expect(tagCountLabel(-1)).toBe("no notes");
  });

  it("groups the digits", () => {
    expect(tagCountLabel(1234)).toBe((1234).toLocaleString() + " notes");
  });
});
