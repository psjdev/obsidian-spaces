/**
 * Which drag the strip's rail is looking at.
 *
 * `spaceDropFor` is tested on its own in `spaceDrop.test.ts`; what is pinned
 * here is the branch decision, as a pure function of plain values: a reorder
 * takes the old path untouched, a file drag takes the new one, and anything
 * else is left alone so the drop passes through to whatever is underneath.
 * Nothing here touches the DOM; the painted target state is an e2e question.
 */
import { describe, expect, it } from "vitest";
import { dropTargetFor } from "../src/ui/spaceDrop";
import type { SpaceDefinition } from "../src/types";

function space(o: Partial<SpaceDefinition> = {}): SpaceDefinition {
  return { id: "s1", name: "Work", icon: "box", color: "#808080", members: [], ...o };
}

describe("dropTargetFor", () => {
  it("ignores a reorder drag, whatever is under the pointer", () => {
    expect(dropTargetFor("s2", space(), ["Notes/a.md"])).toBeNull();
  });

  it("acts on a file drag over a curated space", () => {
    expect(dropTargetFor(null, space(), ["Notes/a.md"])?.kind).toBe("add");
  });

  it("ignores a file drag over no space", () => {
    expect(dropTargetFor(null, null, ["Notes/a.md"])).toBeNull();
  });

  it("ignores a pointer with no drag behind it", () => {
    expect(dropTargetFor(null, space(), [])).toBeNull();
  });

  it("ignores a refusal, so the icon never lights for it", () => {
    expect(dropTargetFor(null, space({ root: "Clients" }), ["Clients"])).toBeNull();
  });
});
