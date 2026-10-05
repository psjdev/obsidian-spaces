// @vitest-environment jsdom
/**
 * Which drawn rows join into one block.
 *
 * This was a `:has(+ .spaces-create-tree-row.is-inherited)` rule, and it was
 * untestable here for a reason worth writing down: jsdom computes no cascade,
 * and it SILENTLY DROPS a rule whose selector it cannot parse, which includes
 * that one. A test asserting the old behaviour through computed style would
 * have passed against a stylesheet that had been deleted out from under it.
 *
 * Now the renderer decides it and the answer is a class, so it can be asserted
 * directly. `markJoinedRows` reads only `classList` and sibling order, so these
 * tests build the drawn rows by hand rather than through the panel.
 */
import { describe, expect, it } from "vitest";
import { JOINED_ROW_CLASS, markJoinedRows } from "../src/ui/pickerBody";

/** One drawn row, named by the classes the renderer would have put on it. */
function row(...classes: string[]): HTMLElement {
  const el = document.createElement("div");
  el.className = ["spaces-create-tree-row", ...classes].join(" ");
  return el;
}

function host(...rows: HTMLElement[]): HTMLElement {
  const h = document.createElement("div");
  for (const r of rows) h.appendChild(r);
  return h;
}

/** Which rows carry the join, by index, so the shape of a block is readable. */
function joined(h: HTMLElement): number[] {
  return Array.from(h.children)
    .map((el, i) => (el.classList.contains(JOINED_ROW_CLASS) ? i : -1))
    .filter((i) => i >= 0);
}

describe("markJoinedRows", () => {
  it("joins a picked row to the covered row under it", () => {
    const h = host(row("is-selected"), row("is-inherited"));
    markJoinedRows(h);
    expect(joined(h)).toEqual([0]);
  });

  it("carries the join down a run of covered rows and stops at the last", () => {
    const h = host(row("is-selected"), row("is-inherited"), row("is-inherited"), row("is-inherited"));
    markJoinedRows(h);
    // Every row but the last: the last has nothing under it to join to, which
    // is what leaves the bottom of the block rounded.
    expect(joined(h)).toEqual([0, 1, 2]);
  });

  it("keeps two separately picked siblings as two blocks", () => {
    // The case that made this a rule about COVERED rather than merely tinted:
    // a selected row starts a selection of its own.
    const h = host(row("is-selected"), row("is-selected"));
    markJoinedRows(h);
    expect(joined(h)).toEqual([]);
  });

  it("ends a block at an overflow row", () => {
    const h = host(row("is-selected"), row("is-inherited"), row("is-overflow"), row("is-inherited"));
    markJoinedRows(h);
    // Row 1 does not reach across the overflow marker to row 3.
    expect(joined(h)).toEqual([0]);
  });

  it("leaves an unpicked row alone even when a covered row follows it", () => {
    const h = host(row(), row("is-inherited"));
    markJoinedRows(h);
    expect(joined(h)).toEqual([]);
  });

  it("joins a row that is both picked and covered-looking by its own class", () => {
    // `is-selected` wins over `is-inherited` in the renderer, but either one
    // above a covered row opens a block.
    const h = host(row("is-inherited"), row("is-inherited"));
    markJoinedRows(h);
    expect(joined(h)).toEqual([0]);
  });

  it("clears a mark that the previous draw left behind", () => {
    // The renderer reuses nothing between draws today, but `toggle` is what
    // makes that assumption safe to break later.
    const stale = row("is-selected", JOINED_ROW_CLASS);
    const h = host(stale, row());
    markJoinedRows(h);
    expect(joined(h)).toEqual([]);
  });

  it("marks nothing in an empty window", () => {
    const h = host();
    expect(() => markJoinedRows(h)).not.toThrow();
    expect(joined(h)).toEqual([]);
  });
});
