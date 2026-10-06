/**
 * The pure `dropTargetFor` decision, and nothing else.
 *
 * `spaceDropFor` is tested on its own in `spaceDrop.test.ts`. This file pins
 * only the function both listeners ask: a reorder is ignored, a file drag over
 * a space that would act is answered, and everything else is null.
 *
 * It does NOT cover the listeners themselves: `preventDefault`, the
 * `dropEffect` mapping, `dragleave`, the drop-mark class or the scroll tick's
 * gating. That behavior is covered by the e2e task against a real browser.
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

  it("moves a file drag over a folder-pinned space", () => {
    expect(dropTargetFor(null, space({ root: "Clients" }), ["Notes/a.md"])?.kind).toBe("move");
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
