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
import {
  CLIPPED_SELECTION,
  MISSING_ROOT,
  SELECTION_ONTO_FOLDER_SPACE,
  dropTargetFor,
  spaceDropFor,
} from "../src/ui/spaceDrop";
import type { SpaceDefinition } from "../src/types";

/**
 * The paths plus the explorer's answer to "might this list be short". The
 * default is the ordinary case, a selection the DOM holds whole; the tests
 * that are ABOUT the clipping pass `true` and say so.
 */
function drag(paths: readonly string[], truncated = false, fromSelection = false) {
  return { paths, truncated, fromSelection };
}

/**
 * The vault's answer about a space's root folder. `exists` is the default
 * because a declared root that is really there is the ordinary case; the
 * missing-root tests pass `gone` and say so.
 */
const exists = (): boolean => true;
const gone = (): boolean => false;

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
    expect(spaceDropFor(space(), drag(["Notes/a.md"]), exists)).toEqual({ kind: "add", spaceId: "s1" });
  });

  it("refuses when there is no space under the pointer", () => {
    // The `+` control and *All* both resolve to no space.
    expect(spaceDropFor(null, drag(["Notes/a.md"]), exists).kind).toBe("refuse");
  });

  it("refuses an empty drag", () => {
    expect(spaceDropFor(space(), drag([]), exists).kind).toBe("refuse");
  });

  it("moves into the root of a folder-pinned space", () => {
    expect(spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md"]), exists)).toEqual({
      kind: "move",
      spaceId: "s1",
      root: "Clients",
    });
  });

  /**
   * The missing-root state, in all three of its spellings.
   *
   * A space in it has DECLARED a root and cannot honour it. It still renders
   * from that root and still shows no member list, so it is not curated: adding
   * to it would write members nothing ever displays. And there is no folder to
   * move into, so it is not a move target either. Refusing is the only honest
   * answer, and it is why `isFolderSpace` is bound to `hasRoot` rather than to
   * `rootOf` -- collapsing "no root at all" into "a root that cannot be
   * honoured" is the exact mistake this rule used to make.
   */
  it("refuses the two unusable root spellings", () => {
    expect(spaceDropFor(space({ root: "" }), drag(["Notes/a.md"]), exists).kind).toBe("refuse");
    expect(spaceDropFor(space({ root: "/" }), drag(["Notes/a.md"]), exists).kind).toBe("refuse");
  });

  /**
   * And the spelling `rootOf` cannot see.
   *
   * `rootOf` hands back `Projects` whether or not that folder is still there,
   * so this is the state where the icon lit, the drop was claimed, and every
   * `renameFile` behind it threw. The ONLY difference between this test and the
   * move test above is the vault's answer.
   */
  it("refuses a declared root whose folder has been deleted", () => {
    expect(spaceDropFor(space({ root: "Projects" }), drag(["Notes/a.md"]), gone).kind).toBe(
      "refuse"
    );
    expect(spaceDropFor(space({ root: "Projects" }), drag(["Notes/a.md"]), exists)).toEqual({
      kind: "move",
      spaceId: "s1",
      root: "Projects",
    });
  });

  // A curated space has no root at all, so the vault is never asked.
  it("never asks about a root a curated space does not have", () => {
    const asked: string[] = [];
    const watch = (p: string): boolean => {
      asked.push(p);
      return true;
    };
    expect(spaceDropFor(space(), drag(["Notes/a.md"]), watch).kind).toBe("add");
    expect(asked).toEqual([]);
  });

  it("refuses the pinned root dragged onto its own icon", () => {
    expect(spaceDropFor(space({ root: "Clients" }), drag(["Clients"]), exists).kind).toBe("refuse");
  });

  it("refuses an ancestor of the pinned root", () => {
    expect(spaceDropFor(space({ root: "Clients/Northwind" }), drag(["Clients"]), exists).kind).toBe("refuse");
  });

  // `movesIntoOwnSubtree` compares with `===` and `startsWith`, so it is case
  // SENSITIVE, while the rest of the path policy is not. On a case
  // insensitive filesystem these are the same folder, and moving it inside
  // itself would destroy it.
  it("refuses the pinned root under a different case", () => {
    expect(spaceDropFor(space({ root: "Clients" }), drag(["clients"]), exists).kind).toBe("refuse");
    expect(spaceDropFor(space({ root: "Clients/Sub" }), drag(["CLIENTS"]), exists).kind).toBe("refuse");
  });

  it("still moves a note that merely shares a prefix with the root", () => {
    // "ClientsArchive" is not "Clients" nor inside it.
    expect(spaceDropFor(space({ root: "Clients" }), drag(["ClientsArchive/a.md"]), exists).kind).toBe("move");
  });

  it("refuses when any one of several dragged paths is illegal", () => {
    expect(
      spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md", "Clients"]), exists).kind
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
    const d = spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md"], true), exists);
    expect(d).toMatchObject({ kind: "refuse", reason: CLIPPED_SELECTION });
  });

  // Curated too: `addToSpace` would add only the visible rows and the notice
  // would count only those, so the add is as partial as the move.
  it("refuses a clipped drag on a curated space as well", () => {
    expect(spaceDropFor(space(), drag(["Notes/a.md"], true), exists)).toMatchObject({
      kind: "refuse",
      reason: CLIPPED_SELECTION,
    });
  });

  // The space is named on the refusals that get spoken, because the strip is a
  // row of icons and "the space" picks out none of them.
  it("names the space on a refusal the user will be told about", () => {
    expect(spaceDropFor(space({ name: "Archive" }), drag(["a.md"], true), exists)).toEqual({
      kind: "refuse",
      reason: CLIPPED_SELECTION,
      spaceName: "Archive",
    });
  });

  // Asked after the two cheap refusals, so the one refusal worth voicing only
  // fires for a pointer that is genuinely aimed at a space.
  it("refuses a clipped drag over no space with the ordinary reason", () => {
    expect(spaceDropFor(null, drag(["Notes/a.md"], true), exists)).toEqual({
      kind: "refuse",
      reason: "not a space",
    });
  });
});

/**
 * The second guard on the irreversible path, and why it is a different
 * question from the first.
 *
 * `truncated` asks "might this list be short", and the predicate behind it is
 * structurally blind on the top edge of the explorer's render window: an
 * expanded folder's own row is permanently in the DOM, so `rendered[0]` is
 * never a selected note and that half of the test cannot fire. `fromSelection`
 * asks the question the DOM cannot get wrong -- "did this list come from a
 * selection at all" -- and the move path refuses on it.
 *
 * Every test below passes `truncated: false`, which is the whole point: they
 * pin behaviour in exactly the state where the first guard is quiet and wrong.
 */
describe("spaceDropFor and a selection aimed at a folder-pinned space", () => {
  it("refuses the move, and says which space", () => {
    expect(
      spaceDropFor(
        space({ name: "Archive", root: "Clients" }),
        drag(["Notes/a.md", "Notes/b.md"], false, true),
        exists
      )
    ).toEqual({
      kind: "refuse",
      reason: SELECTION_ONTO_FOLDER_SPACE,
      spaceName: "Archive",
    });
  });

  /**
   * The mutation this exists to kill: `drag.paths.length > 1` written in place
   * of `drag.fromSelection`.
   *
   * A selection clipped down to its one rendered row reaches this function
   * carrying a single path. It is a selection, and the rest of it is invisible,
   * so a count test waves through precisely the case that moves part of a
   * gesture and reports it as all of it. That substitution passes every other
   * test in this file and fails this one.
   */
  it("refuses a one-path selection, which a count test would let through", () => {
    expect(
      spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md"], false, true), exists).kind
    ).toBe("refuse");
  });

  // The negative control for the rule as a whole. Without it, "refuse every
  // move" would pass the two above.
  it("still moves a single-row drag onto the same space", () => {
    expect(
      spaceDropFor(space({ root: "Clients" }), drag(["Notes/a.md"], false, false), exists)
    ).toEqual({ kind: "move", spaceId: "s1", root: "Clients" });
  });

  /**
   * The add path is deliberately untouched and keeps multi-select.
   *
   * `addToSpace` writes `data.json` and Remove undoes it, so collecting too few
   * paths there is a wrong count the user can see and fix, not lost work. A
   * version that put the `fromSelection` test above the curated/folder split
   * would fail here while passing everything else.
   */
  it("still adds a selection to a curated space", () => {
    expect(spaceDropFor(space(), drag(["a.md", "b.md"], false, true), exists)).toEqual({
      kind: "add",
      spaceId: "s1",
    });
  });

  /**
   * Order matters against the root checks. A folder space whose folder has been
   * deleted is refused for THAT reason, which is a standing fact about the
   * space, rather than being told to drag notes in one at a time to a folder
   * that is not there.
   */
  it("reports a missing root rather than the selection limit", () => {
    expect(
      spaceDropFor(space({ root: "Projects" }), drag(["a.md", "b.md"], false, true), gone)
    ).toMatchObject({ kind: "refuse", reason: MISSING_ROOT });
  });

  // And the clipped refusal still wins, because it is asked before the
  // curated/folder split and is true of both kinds of space.
  it("reports a clipped selection rather than the selection limit", () => {
    expect(
      spaceDropFor(space({ root: "Clients" }), drag(["a.md"], true, true), exists)
    ).toMatchObject({ kind: "refuse", reason: CLIPPED_SELECTION });
  });
});

describe("dropTargetFor and the selection limit", () => {
  // It comes back rather than collapsing to null, which is what lets the
  // listener speak. It still lights nothing: the caller lights for add and
  // move only.
  it("hands the refusal back so the listener can voice it", () => {
    expect(
      dropTargetFor(null, space({ root: "Clients" }), drag(["a.md"], false, true), exists)
    ).toMatchObject({ kind: "refuse", reason: SELECTION_ONTO_FOLDER_SPACE });
  });

  // While a refusal nobody has worded still collapses to null, so the pointer
  // passes through and the "no drop" cursor explains it for free.
  it("still swallows a refusal that is not spoken", () => {
    expect(
      dropTargetFor(null, space({ root: "Clients" }), drag(["Clients"], false, false), exists)
    ).toBeNull();
  });
});
