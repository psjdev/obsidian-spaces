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
    d.begin(["Notes/a.md", "Notes/b.md"]);
    expect(d.paths()).toEqual(["Notes/a.md", "Notes/b.md"]);
  });

  it("forgets when the drag ends", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"]);
    d.end();
    expect(d.paths()).toEqual([]);
  });

  // The interrupted drag: Escape, or a drop outside every window. `dragend`
  // fires for all of them, so `end()` is the only clear point and the next
  // drag can never act on the last one's paths.
  it("does not leak one drag's paths into the next", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"]);
    d.end();
    d.begin(["Other/c.md"]);
    expect(d.paths()).toEqual(["Other/c.md"]);
  });

  it("replaces rather than appends when a drag begins twice", () => {
    const d = new CurrentDrag();
    d.begin(["Notes/a.md"]);
    d.begin(["Notes/b.md"]);
    expect(d.paths()).toEqual(["Notes/b.md"]);
  });

  // The caller must not be able to edit the record through the array it
  // handed in, nor through the one it gets back.
  it("does not alias the caller's array", () => {
    const d = new CurrentDrag();
    const given = ["Notes/a.md"];
    d.begin(given);
    given.push("Notes/b.md");
    expect(d.paths()).toEqual(["Notes/a.md"]);
  });
});
