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
import { CLIPPED_SELECTION, dropTargetFor } from "../src/ui/spaceDrop";
import type { SpaceDefinition } from "../src/types";

function drag(paths: readonly string[], truncated = false, fromSelection = false) {
  return { paths, truncated, fromSelection };
}

/** The vault's answer about a space's root folder. */
const exists = (): boolean => true;
const gone = (): boolean => false;

function space(o: Partial<SpaceDefinition> = {}): SpaceDefinition {
  return { id: "s1", name: "Work", icon: "box", color: "#808080", members: [], ...o };
}

describe("dropTargetFor", () => {
  it("ignores a reorder drag, whatever is under the pointer", () => {
    expect(dropTargetFor("s2", space(), drag(["Notes/a.md"]), exists)).toBeNull();
  });

  it("acts on a file drag over a curated space", () => {
    expect(dropTargetFor(null, space(), drag(["Notes/a.md"]), exists)?.kind).toBe("add");
  });

  it("moves a file drag over a folder-pinned space", () => {
    expect(dropTargetFor(null, space({ root: "Clients" }), drag(["Notes/a.md"]), exists)?.kind).toBe("move");
  });

  it("ignores a file drag over no space", () => {
    expect(dropTargetFor(null, null, drag(["Notes/a.md"]), exists)).toBeNull();
  });

  it("ignores a pointer with no drag behind it", () => {
    expect(dropTargetFor(null, space(), drag([]), exists)).toBeNull();
  });

  it("ignores a refusal, so the icon never lights for it", () => {
    expect(dropTargetFor(null, space({ root: "Clients" }), drag(["Clients"]), exists)).toBeNull();
  });

  /**
   * The one refusal that does NOT collapse to null.
   *
   * It still lights no icon -- the caller lights only for add/move -- but it
   * comes back so the listener can say why, which is the whole point: a
   * clipped drag that refused in silence looks exactly like a feature that
   * does not work.
   */
  it("returns the clipped refusal so the listener can voice it", () => {
    const t = dropTargetFor(null, space({ root: "Clients" }), drag(["Notes/a.md"], true), exists);
    // `toMatchObject`, because the refusal also carries the space's name for
    // the words to use. The reason is what this test is about.
    expect(t).toMatchObject({ kind: "refuse", reason: CLIPPED_SELECTION });
  });

  it("still ignores a clipped drag during a reorder", () => {
    expect(dropTargetFor("s2", space(), drag(["Notes/a.md"], true), exists)).toBeNull();
  });

  it("ignores a clipped drag over no space, which has nothing to explain", () => {
    expect(dropTargetFor(null, null, drag(["Notes/a.md"], true), exists)).toBeNull();
  });

  // The icon must not light for a space whose folder is gone: it would promise
  // a move into a folder that is not there, and every rename behind it throws.
  it("ignores a folder space whose root has been deleted", () => {
    expect(dropTargetFor(null, space({ root: "Clients" }), drag(["Notes/a.md"]), gone)).toBeNull();
  });
});
