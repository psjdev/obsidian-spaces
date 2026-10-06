import { movesIntoOwnSubtree } from "../order/dropIntent";
import type { DraggedFiles } from "../order/currentDrag";
import type { SpaceDefinition } from "../types";
import { canonicalPath } from "../visibility/glob";
import { hasRoot, rootOf } from "../visibility/folderSpace";

/**
 * What a drop on a space icon means.
 *
 * `refuse` carries a reason so the caller can say why, and so the two callers
 * cannot disagree about whether a drop would act: `dragover` lights the icon
 * only for a non-refusal, and `drop` acts only on the same answer.
 */
export type SpaceDrop =
  | { kind: "add"; spaceId: string }
  | { kind: "move"; spaceId: string; root: string }
  | { kind: "refuse"; reason: string };

/**
 * The one refusal the strip must SAY OUT LOUD rather than leave as a dead
 * gesture.
 *
 * Every other refusal is a pointer somewhere that was never a target, and the
 * "no drop" cursor already says so. This one is different: the pointer IS over
 * a space that would otherwise act, the user has a large selection in hand, and
 * the only reason nothing happens is that the explorer is hiding part of what
 * they selected. Silence there reads as a broken feature, and the alternative
 * -- acting on the visible fraction -- is an irreversible partial move.
 *
 * Compared by identity against this constant rather than by prose, so the
 * message and the test can change without the branch changing meaning.
 */
export const CLIPPED_SELECTION = "part of the selection is outside the render window";

/**
 * What a drop on this space would do.
 *
 * Pure, and asked twice per drag with the same inputs, so the icon can never
 * promise something the drop will not deliver. `rootExists` is injected for
 * exactly that reason: whether a folder named by a space is really there is a
 * vault question, this module has no `app`, and answering it by guessing would
 * reintroduce the two-answers problem the seam exists to close.
 */
export function spaceDropFor(
  space: SpaceDefinition | null,
  drag: DraggedFiles,
  rootExists: (path: string) => boolean
): SpaceDrop {
  // *All* and the `+` control both arrive here as no space. Neither holds
  // members, so neither is a target.
  if (!space) return { kind: "refuse", reason: "not a space" };
  if (drag.paths.length === 0) {
    return { kind: "refuse", reason: "nothing is being dragged" };
  }

  // Asked AFTER the two above so it only ever fires for a pointer that is
  // genuinely aimed at a space, which is what makes it worth voicing.
  //
  // Refused rather than trimmed to what is visible. `DragOrdering` makes the
  // same call for its own drops, and `dropIntent.ts` records why above
  // `movesIntoOwnSubtree`: a multi-selection is one gesture, and moving the
  // possible half leaves a partial result the user did not ask for and cannot
  // see the shape of. Here that half is `renameFile` per path on a folder
  // space, which Obsidian cannot undo, and a notice that counts only what
  // moved would report it as a complete success.
  if (drag.truncated) return { kind: "refuse", reason: CLIPPED_SELECTION };

  // Split on `hasRoot`, not on `rootOf`, and `isFolderSpace` is bound to the
  // same function for the same reason. `rootOf` answers null for two different
  // states -- "curated, no root at all" and "a root was declared and cannot be
  // honoured" -- and collapsing them here made a space in the missing-root
  // state look curated.
  if (!hasRoot(space)) return { kind: "add", spaceId: space.id };

  // A space that DECLARES a root renders from that folder and never shows a
  // member list, so adding to one would appear to do nothing. The user's answer
  // to that was to move the file instead, which needs a folder to move it into.
  //
  // Three states reach here and only one of them has one. `rootOf` nulls the
  // two unusable spellings, `""` and `"/"`. It does NOT null a root like
  // `Projects` whose folder has since been deleted: it hands that string back
  // happily, which is why the icon used to light for such a space and then
  // throw on every single rename. `rootExists` is the only thing that can tell
  // those apart, and it is why this function takes it.
  //
  // Refused in silence, unlike the clipped selection above: a missing root is a
  // standing fact about the space rather than something about this gesture, the
  // space already shows its own empty-state-with-repair, and `MissingRootNotice`
  // already says it where saying it belongs.
  const root = rootOf(space);
  if (root === null || !rootExists(root)) {
    return { kind: "refuse", reason: "the space's folder is missing" };
  }

  // Folded before the test because `movesIntoOwnSubtree` compares with `===`
  // and `startsWith`. On a case insensitive filesystem `Clients` and `clients`
  // are one folder, and moving it inside itself would destroy it. The shared
  // helper is left alone: its other caller is the tree drag, and changing the
  // fold there is a separate question.
  const folded = drag.paths.map(canonicalPath);
  if (movesIntoOwnSubtree(folded, canonicalPath(root))) {
    return { kind: "refuse", reason: "that folder is the space's own root" };
  }

  return { kind: "move", spaceId: space.id, root };
}

/**
 * The one question both listeners ask: what should the strip do here?
 *
 * Null means "not ours": do not light the icon, do not call
 * `preventDefault()`, say nothing, let the event pass. That covers a reorder
 * (which the existing branch owns), a pointer over no space, a pointer with no
 * file drag behind it, and every refusal that the "no drop" cursor already
 * explains on its own.
 *
 * An `add` or a `move` means light the icon and act on the drop.
 *
 * A `refuse` comes back ONLY for `CLIPPED_SELECTION`, and it means neither:
 * light nothing, cancel nothing, and tell the user why. Returning it rather
 * than collapsing it to null is what stops the two listeners drifting on the
 * one refusal that has to be voiced -- and it still never lights an icon,
 * because an icon that lights and then refuses is the exact failure this seam
 * exists to prevent.
 */
export function dropTargetFor(
  dragFromId: string | null,
  space: SpaceDefinition | null,
  drag: DraggedFiles,
  rootExists: (path: string) => boolean
): SpaceDrop | null {
  if (dragFromId !== null) return null;
  const drop = spaceDropFor(space, drag, rootExists);
  if (drop.kind !== "refuse") return drop;
  return drop.reason === CLIPPED_SELECTION ? drop : null;
}
