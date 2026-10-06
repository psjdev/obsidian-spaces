/**
 * What a drop on a space icon means.
 *
 * Layer 1: pure, no DOM. Asked twice per drag -- once on `dragover` to decide
 * whether to light the icon, once on `drop` to decide what to do -- so that the
 * icon can never promise something the drop will not deliver. That exact
 * failure already happened on this plugin once: the drag indicator read
 * `destination=Travel` while the file landed at the vault root, because the
 * drop re-decided instead of honouring what was shown.
 */
import { describe, expect, it } from "vitest";
import { CLIPPED_SELECTION, spaceDropFor } from "../src/ui/spaceDrop";
import type { SpaceDefinition } from "../src/types";

/**
 * The paths plus the explorer's answer to "might this list be short". The
 * default is the ordinary case, a selection the DOM holds whole; the tests
 * that are ABOUT the clipping pass `true` and say so.
 */
function drag(paths: readonly string[], truncated = false) {
  return { paths, truncated };
}

function space(o: Partial<SpaceDefinition> = {}): SpaceDefinition {
  return {
    id: "s1",
    name: "Work",
    icon: "box",
    color: "#808080",
    members: [],
    ...o,
  };
}

describe("spaceDropFor", () => {
  it("adds to a curated space", () => {
    expect(spaceDropFor(space(), drag(["Notes/a.md"]))).toEqual({ kind: "add", spaceId: "s1" });
  });

  it("refuses when there is no space under the pointer", () => {
    // The `+` control and *All* both resolve to no space.
    expect(spaceDropFor(null, drag(["Notes/a.md"])).kind).toBe("refuse");
  });

  it("refuses an empty drag", () => {
    expect(spaceDropFor(space(), drag([])).kind).toBe("refuse");
  });

  it("moves into the root of a folder-pinned space", () => {
    expect(spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md"]))).toEqual({
      kind: "move",
      spaceId: "s1",
      root: "Clients",
    });
  });

  // `rootOf` reads both spellings of the missing-root state as "no root
  // chosen", so such a space is curated here, not a move target.
  it("treats the missing-root spellings as curated", () => {
    expect(spaceDropFor(space({ root: "" }), drag(["Notes/a.md"])).kind).toBe("add");
    expect(spaceDropFor(space({ root: "/" }), drag(["Notes/a.md"])).kind).toBe("add");
  });

  it("refuses the pinned root dragged onto its own icon", () => {
    expect(spaceDropFor(space({ root: "Clients" }), drag(["Clients"])).kind).toBe("refuse");
  });

  it("refuses an ancestor of the pinned root", () => {
    expect(spaceDropFor(space({ root: "Clients/Northwind" }), drag(["Clients"])).kind).toBe("refuse");
  });

  // `movesIntoOwnSubtree` compares with `===` and `startsWith`, so it is case
  // SENSITIVE, while the rest of the path policy is not. On a case
  // insensitive filesystem these are the same folder, and moving it inside
  // itself would destroy it.
  it("refuses the pinned root under a different case", () => {
    expect(spaceDropFor(space({ root: "Clients" }), drag(["clients"])).kind).toBe("refuse");
    expect(spaceDropFor(space({ root: "Clients/Sub" }), drag(["CLIENTS"])).kind).toBe("refuse");
  });

  it("still moves a note that merely shares a prefix with the root", () => {
    // "ClientsArchive" is not "Clients" nor inside it.
    expect(spaceDropFor(space({ root: "Clients" }), drag(["ClientsArchive/a.md"])).kind).toBe("move");
  });

  it("refuses when any one of several dragged paths is illegal", () => {
    expect(
      spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md", "Clients"])).kind
    ).toBe("refuse");
  });

  /**
   * The merge blocker this flag exists for.
   *
   * `truncated` means the explorer's render window may be hiding more selected
   * rows than the DOM holds, so the paths are possibly a fraction of the
   * gesture. Acting on them would move that fraction with `renameFile`, leave
   * the rest behind, and count only what moved -- which reads as a complete
   * success and cannot be undone. Refusing is the same call `DragOrdering`
   * makes for its own drops.
   */
  it("refuses a drag whose selection may outrun the render window", () => {
    const d = spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md"], true));
    expect(d).toEqual({ kind: "refuse", reason: CLIPPED_SELECTION });
  });

  // Curated too: `addToSpace` would add only the visible rows and the notice
  // would count only those, so the add is as partial as the move.
  it("refuses a clipped drag on a curated space as well", () => {
    expect(spaceDropFor(space(), drag(["Notes/a.md"], true))).toEqual({
      kind: "refuse",
      reason: CLIPPED_SELECTION,
    });
  });

  // Asked after the two cheap refusals, so the one refusal worth voicing only
  // fires for a pointer that is genuinely aimed at a space.
  it("refuses a clipped drag over no space with the ordinary reason", () => {
    expect(spaceDropFor(null, drag(["Notes/a.md"], true))).toEqual({
      kind: "refuse",
      reason: "not a space",
    });
  });
});
