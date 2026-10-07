/**
 * The pure `dropTargetFor` decision, and nothing else.
 *
 * `spaceDropFor` is tested on its own in `spaceDrop.test.ts`. This file pins
 * only the function both listeners ask: a reorder is ignored, a file drag over
 * a space that would act is answered, and everything else is null.
 *
 * It does NOT cover the listeners themselves. Most of that is covered by
 * `switcherDropListeners.test.ts`, which drives a real `SwitcherView` in a DOM:
 * `preventDefault`, the drop-mark class, `dragleave` and the refusals that get
 * spoken. What no unit layer covers is the `dropEffect` mapping and the scroll
 * tick's gating, because jsdom lays nothing out and sets no effective drag
 * data; those are the e2e task's against a real browser.
 */
import { describe, expect, it } from "vitest";
import { CLIPPED_SELECTION, FOLDER_PINNED_SPACE, dropTargetFor } from "../src/ui/spaceDrop";
import type { SpaceDefinition } from "../src/types";

function drag(paths: readonly string[], truncated = false) {
  return { paths, truncated };
}

function space(o: Partial<SpaceDefinition> = {}): SpaceDefinition {
  return { id: "s1", name: "Work", icon: "box", color: "#808080", members: [], ...o };
}

describe("dropTargetFor", () => {
  it("ignores a reorder drag, whatever is under the pointer", () => {
    expect(dropTargetFor("s2", space(), drag(["Notes/a.md"]))).toBeNull();
  });

  it("acts on a file drag over a curated space", () => {
    expect(dropTargetFor(null, space(), drag(["Notes/a.md"]))?.kind).toBe("add");
  });

  it("ignores a file drag over no space", () => {
    expect(dropTargetFor(null, null, drag(["Notes/a.md"]))).toBeNull();
  });

  it("ignores a pointer with no drag behind it", () => {
    expect(dropTargetFor(null, space(), drag([]))).toBeNull();
  });

  /**
   * The two refusals that do NOT collapse to null.
   *
   * Neither lights an icon -- the caller lights only for `add` -- but both come
   * back so the listener can say why, which is the whole point: a drag that
   * refuses in silence over a space that looks like every other space in the
   * strip is indistinguishable from a feature that does not work.
   */
  it("returns the clipped refusal so the listener can voice it", () => {
    const t = dropTargetFor(null, space(), drag(["Notes/a.md"], true));
    // `toMatchObject`, because the refusal also carries the space's name for
    // the words to use. The reason is what this test is about.
    expect(t).toMatchObject({ kind: "refuse", reason: CLIPPED_SELECTION });
  });

  it("returns the pinned-space refusal so the listener can voice it", () => {
    const t = dropTargetFor(null, space({ root: "Clients" }), drag(["Notes/a.md"]));
    expect(t).toMatchObject({ kind: "refuse", reason: FOLDER_PINNED_SPACE });
  });

  it("still ignores a clipped drag during a reorder", () => {
    expect(dropTargetFor("s2", space(), drag(["Notes/a.md"], true))).toBeNull();
  });

  it("ignores a clipped drag over no space, which has nothing to explain", () => {
    expect(dropTargetFor(null, null, drag(["Notes/a.md"], true))).toBeNull();
  });

  // Reaching a pinned space during a reorder is still the other branch's
  // business: the icon must not light, and nothing must be said either.
  it("stays silent about a pinned space during a reorder", () => {
    expect(dropTargetFor("s2", space({ root: "Clients" }), drag(["Notes/a.md"]))).toBeNull();
  });
});
