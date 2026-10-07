/**
 * What a drop on a space icon means.
 *
 * Layer 1: pure, no DOM. Asked on every `dragover` to decide whether to light
 * the icon and again on `drop` to decide what to do, so that the icon can never
 * promise something the drop will not deliver. That exact failure already
 * happened on this plugin once: the drag indicator read `destination=Travel`
 * while the file landed at the vault root, because the drop re-decided instead
 * of honouring what was shown.
 *
 * ADD IS THE ONLY ACT this function can answer with. The second one, moving a
 * file into a folder-pinned space's root, was removed by an owner's decision:
 * the two kinds of icon are indistinguishable in the strip, and only one of
 * them rewrote the vault. The tests that drove the move went with it; what is
 * left below is the add, and the two refusals the strip says out loud.
 */
import { describe, expect, it } from "vitest";
import { CLIPPED_SELECTION, FOLDER_PINNED_SPACE, spaceDropFor } from "../src/ui/spaceDrop";
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

  // A selection is the ordinary case for the add path and must keep working.
  // `addToSpace` takes a list, `Remove from space` undoes it, and nothing about
  // the count changes the answer.
  it("adds a whole selection to a curated space", () => {
    expect(spaceDropFor(space(), drag(["a.md", "b.md", "c.md"]))).toEqual({
      kind: "add",
      spaceId: "s1",
    });
  });
});

/**
 * The scope reduction, pinned as behaviour rather than described in a commit
 * message.
 *
 * A space pinned to a folder renders from that folder and never shows a member
 * list, so a member written to it would be a write the user can never see. It
 * is refused, it is refused ALOUD, and it is refused for every spelling of a
 * declared root, including the ones a previous version of this function read as
 * curated.
 */
describe("spaceDropFor and a space pinned to a folder", () => {
  it("refuses, names the space, and gives the reason the strip speaks", () => {
    expect(spaceDropFor(space({ name: "Archive", root: "Clients" }), drag(["Notes/a.md"]))).toEqual({
      kind: "refuse",
      reason: FOLDER_PINNED_SPACE,
      spaceName: "Archive",
    });
  });

  /**
   * The mutation this exists to kill: `rootOf(space) !== null` written in place
   * of `hasRoot(space)`.
   *
   * `rootOf` nulls the two unusable spellings, `""` and `"/"`, so that
   * substitution would read a space declaring either of them as CURATED and
   * start writing members to a space that still renders from a root. `hasRoot`
   * asks the question actually being asked: does this space have a member list
   * at all.
   */
  it("refuses the two unusable root spellings as well", () => {
    expect(spaceDropFor(space({ root: "" }), drag(["Notes/a.md"]))).toMatchObject({
      kind: "refuse",
      reason: FOLDER_PINNED_SPACE,
    });
    expect(spaceDropFor(space({ root: "/" }), drag(["Notes/a.md"]))).toMatchObject({
      kind: "refuse",
      reason: FOLDER_PINNED_SPACE,
    });
  });

  /**
   * And a root whose folder has since been deleted.
   *
   * This used to be a state the function had to probe the live vault to see,
   * because it decided whether there was a folder to move INTO. With no move
   * there is nothing to probe: the space declares a root either way, so it has
   * no member list either way, and the answer is the same without asking.
   */
  it("refuses a declared root whose folder is gone, without asking the vault", () => {
    expect(spaceDropFor(space({ root: "Projects" }), drag(["Notes/a.md"]))).toMatchObject({
      kind: "refuse",
      reason: FOLDER_PINNED_SPACE,
    });
  });

  /**
   * Order against the clipped-selection rule, which is the one place these two
   * refusals compete.
   *
   * Both are true of a clipped selection aimed at a pinned space. Only one is
   * useful: "select fewer notes and folders, then drag again" is advice the
   * user can follow forever without this icon ever accepting anything.
   */
  it("reports the pinned space rather than the clipping", () => {
    expect(spaceDropFor(space({ root: "Clients" }), drag(["a.md"], true))).toMatchObject({
      kind: "refuse",
      reason: FOLDER_PINNED_SPACE,
    });
  });
});

/**
 * The clipped-selection refusal, kept after the move was removed.
 *
 * `truncated` means the explorer's render window may be hiding more selected
 * rows than the DOM holds, so the paths are possibly a fraction of the gesture.
 * Acting on them now writes a member list missing most of what was selected and
 * reports the fraction as the whole, which "Remove from space" can undo and
 * which is still not what the user asked for.
 */
describe("spaceDropFor and a selection the render window may clip", () => {
  it("refuses a clipped drag on a curated space", () => {
    expect(spaceDropFor(space(), drag(["Notes/a.md"], true))).toMatchObject({
      kind: "refuse",
      reason: CLIPPED_SELECTION,
    });
  });

  // The space is named on the refusals that get spoken, because the strip is a
  // row of icons and "the space" picks out none of them.
  it("names the space on a refusal the user will be told about", () => {
    expect(spaceDropFor(space({ name: "Archive" }), drag(["a.md"], true))).toEqual({
      kind: "refuse",
      reason: CLIPPED_SELECTION,
      spaceName: "Archive",
    });
  });

  // Asked after the two cheap refusals, so the refusals worth voicing only fire
  // for a pointer that is genuinely aimed at a space.
  it("refuses a clipped drag over no space with the ordinary reason", () => {
    expect(spaceDropFor(null, drag(["Notes/a.md"], true))).toEqual({
      kind: "refuse",
      reason: "not a space",
    });
  });
});
