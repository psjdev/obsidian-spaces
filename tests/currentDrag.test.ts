/**
 * What the live drag is carrying.
 *
 * Layer 1: no DOM, no `obsidian`. The whole point of this class is that the
 * strip can ask what a drag holds without importing the component that
 * started it, so it is tested the same way: in isolation.
 */
import { describe, expect, it } from "vitest";
import { CurrentDrag } from "../src/order/currentDrag";

describe("CurrentDrag", () => {
  it("carries nothing before a drag starts", () => {
    expect(new CurrentDrag().paths()).toEqual([]);
  });

  it("carries what the drag began with", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md", "Notes/b.md"], false);
    expect(d.paths()).toEqual(["Notes/a.md", "Notes/b.md"]);
  });

  it("forgets when the drag ends", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"], false);
    d.end();
    expect(d.paths()).toEqual([]);
  });

  // The interrupted drag: Escape, or a drop outside every window. The browser
  // fires `dragend` for all of them, but it fires it AT THE SOURCE ROW, which
  // the explorer may have replaced by then, so reaching `end()` is not
  // guaranteed by the drag's own ending alone. `DragOrdering` closes that gap
  // by calling it again at the next `dragstart`. What this class owes either
  // way is the same, and it is what is pinned here.
  it("does not leak one drag's paths into the next", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"], false);
    d.end();
    d.begin(["Other/c.md"], false);
    expect(d.paths()).toEqual(["Other/c.md"]);
  });

  it("replaces rather than appends when a drag begins twice", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"], false);
    d.begin(["Notes/b.md"], false);
    expect(d.paths()).toEqual(["Notes/b.md"]);
  });

  // The caller must not be able to edit the record through the array it handed
  // in. The array it gets BACK is the live internal one -- only the type is
  // readonly -- which is why the two guarantees are pinned separately below.
  it("does not alias the caller's array", () => {
    const d = new CurrentDrag();
    const given = ["Notes/a.md"];
    d.begin(given, false);
    given.push("Notes/b.md");
    expect(d.paths()).toEqual(["Notes/a.md"]);
  });

  /**
   * The flag the merge blocker was about.
   *
   * `collectDragged` produces it and `DragOrdering` refuses its own drop on it,
   * but it has to reach the strip too, and it has to reach it ALONGSIDE the
   * paths. A consumer holding only the paths cannot tell a clipped selection
   * from a small complete one.
   */
  it("carries whether the selection may be clipped", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"], true);
    expect(d.dragged()).toEqual({ paths: ["Notes/a.md"], truncated: true });
  });

  it("reports a whole selection as not clipped", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"], false);
    expect(d.dragged().truncated).toBe(false);
  });

  // A clipped drag must not poison the next one any more than its paths may.
  it("forgets the clipping when the drag ends", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"], true);
    d.end();
    expect(d.dragged()).toEqual({ paths: [], truncated: false });
    d.begin(["Other/c.md"], false);
    expect(d.dragged().truncated).toBe(false);
  });

  /**
   * `paths()` hands back the live array, so what protects a reader is that
   * `end()` REASSIGNS rather than empties in place.
   *
   * That is not a detail: the strip's drop handler reads the record once and
   * holds it across the awaits of the write that follows, and a `dragend`
   * arrives during a claimed drop. Emptying in place would clear the list that
   * write is still working from, mid-write. Pinned here because the only thing
   * stopping someone "simplifying" `this.current = []` into `length = 0` is
   * knowing that.
   */
  it("leaves an already-handed-out array alone when the drag ends", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md", "Notes/b.md"], false);
    const held = d.paths();
    d.end();
    expect(held).toEqual(["Notes/a.md", "Notes/b.md"]);
    expect(d.paths()).toEqual([]);
  });

  // Same guarantee for the record `dragged()` returns.
  it("leaves an already-handed-out record alone when the drag ends", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"], true);
    const held = d.dragged();
    d.end();
    expect(held).toEqual({ paths: ["Notes/a.md"], truncated: true });
  });
});
