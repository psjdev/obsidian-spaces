import { movesIntoOwnSubtree } from "../order/dropIntent";
import type { DraggedFiles } from "../order/currentDrag";
import type { SpaceDefinition } from "../types";
import { canonicalPath } from "../visibility/glob";
import { rootOf } from "../visibility/folderSpace";

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

export function spaceDropFor(space: SpaceDefinition | null, drag: DraggedFiles): SpaceDrop {
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

  // `rootOf` reads "" and "/" as "no root chosen", so a space in the
  // missing-root state is curated here rather than an unusable move target.
  const root = rootOf(space);
  if (root === null) return { kind: "add", spaceId: space.id };

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
  drag: DraggedFiles
): SpaceDrop | null {
  if (dragFromId !== null) return null;
  const drop = spaceDropFor(space, drag);
  if (drop.kind !== "refuse") return drop;
  return drop.reason === CLIPPED_SELECTION ? drop : null;
}
