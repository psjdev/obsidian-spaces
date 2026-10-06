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
  /**
   * `spaceName` is carried so the refusals that are SAID OUT LOUD can name the
   * space the pointer is on. Both of them ask the user to do something else
   * instead, and "drop them on Work one at a time" is advice where "drop them
   * on the space one at a time" is a riddle with four icons side by side. It is
   * absent for the refusals no human ever hears -- no space under the pointer,
   * nothing being dragged -- because there is no space to name.
   */
  | { kind: "refuse"; reason: string; spaceName?: string };

/**
 * The first of the two refusals the strip must SAY OUT LOUD rather than leave
 * as a dead gesture.
 *
 * Most refusals are a pointer somewhere that was never a target, and the "no
 * drop" cursor already says so. This one is different: the pointer IS over a
 * space that would otherwise act, the user has a large selection in hand, and
 * the only reason nothing happens is that the explorer is hiding part of what
 * they selected. Silence there reads as a broken feature, and the alternative
 * -- acting on the visible fraction -- is an irreversible partial move.
 *
 * Compared by identity against this constant rather than by prose, so the
 * message and the test can change without the branch changing meaning.
 */
export const CLIPPED_SELECTION = "part of the selection is outside the render window";

/**
 * The second refusal the strip says out loud: a MULTI-SELECTION aimed at a
 * folder-pinned space.
 *
 * A deliberate scope limit on the irreversible path, not a defect to be fixed
 * later by relaxing it here. It exists because `selectionMayBeClipped`, the
 * predicate behind `truncated`, is structurally blind on one edge: it reads
 * `rendered[0]` to ask whether the selection runs off the TOP of the explorer's
 * render window, and Obsidian's virtualiser keeps the ancestor chain of
 * everything it renders, so inside an expanded folder `rendered[0]` is the
 * folder's own row and never a selected note. The repo's own e2e script
 * measured that and routes around it. So a selection can be clipped at the top
 * and report `truncated: false`, and on this path that costs a `renameFile` per
 * visible row, the rest left behind, and a notice counting only what moved.
 *
 * Before the drop-on-an-icon gesture existed, a hole in that predicate cost
 * only ordering precision: `DragOrdering` declined, Obsidian kept the gesture,
 * and the whole selection still moved. This path has no such fallback, which is
 * why it refuses rather than trusts.
 *
 * LIFTING IT MEANS FIXING `selectionMayBeClipped` FIRST -- the top-edge half
 * has to be able to fire -- and only then relaxing this rule. Loosening this
 * one while the predicate is blind puts the data loss straight back.
 *
 * The ADD path is deliberately unaffected and keeps multi-select: it writes
 * `data.json` and Remove undoes it, so a clipped list there is a wrong count
 * rather than lost work.
 */
export const SELECTION_ONTO_FOLDER_SPACE = "a folder space takes one path at a time";

/**
 * The missing-root refusal, named so the drop-time caller can tell it from the
 * others and reuse the plugin's existing wording for it. Silent at `dragover`
 * (see below); said at `drop`, where silence would leave a released gesture
 * with no outcome at all.
 */
export const MISSING_ROOT = "the space's folder is missing";

/**
 * What a drop on this space would do.
 *
 * Pure, so that the icon can never promise something the drop will not deliver.
 * `rootExists` is injected for exactly that reason: whether a folder named by a
 * space is really there is a vault question, this module has no `app`, and
 * answering it by guessing would reintroduce the two-answers problem the seam
 * exists to close.
 *
 * It is asked at least three times per drag -- on every `dragover` over an
 * icon, again at `drop`, and a third time with the subset of paths that
 * survived to the drop -- and the inputs are NOT guaranteed identical across
 * them, because `rootExists` reads the live vault. What purity buys is
 * therefore narrower than "same answer every time" and is still the thing that
 * matters: the answer can change only when the world changed, never because two
 * callers reasoned differently. `filesDroppedOnSpace` records why the drop-time
 * re-ask is safe in the one direction it can differ.
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
  if (drag.truncated) {
    return { kind: "refuse", reason: CLIPPED_SELECTION, spaceName: space.name };
  }

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
    return { kind: "refuse", reason: MISSING_ROOT, spaceName: space.name };
  }

  // The scope limit. Asked here and nowhere earlier, because it is only the
  // MOVE that cannot be undone: everything above this line is either already
  // refused or an `add`, and an add that collected too few paths is a wrong
  // count the user can fix from the member list.
  //
  // Asked AFTER the root checks so a folder space whose folder has gone stays
  // silently refused for the reason that is actually true of it, rather than
  // being told to drag its notes one at a time into a folder that is not there.
  //
  // `fromSelection`, NOT `paths.length > 1`. Counting is the wrong test and
  // would be a worse bug than the one this closes: a selection clipped down to
  // its one visible row arrives here with a single path, so a length test waves
  // through exactly the case that loses data. See `SELECTION_ONTO_FOLDER_SPACE`
  // for why the predicate behind `truncated` cannot be relied on to catch it,
  // and what has to be fixed before this rule can be relaxed.
  if (drag.fromSelection) {
    return { kind: "refuse", reason: SELECTION_ONTO_FOLDER_SPACE, spaceName: space.name };
  }

  // Folded before the test because `movesIntoOwnSubtree` compares with `===`
  // and `startsWith`. On a case insensitive filesystem `Clients` and `clients`
  // are one folder, and moving it inside itself would destroy it. The shared
  // helper is left alone: its other caller is the tree drag, and changing the
  // fold there is a separate question.
  //
  // The fold is also why this rule is sound on a case SENSITIVE filesystem,
  // where `Clients` and `clients` really are two folders: it is deliberately
  // over-eager, so the worst it can do there is refuse a legal move, never
  // permit a destructive one. The matching over-eagerness in `moveIntoRoot`'s
  // descendant prune -- which on such a filesystem could have counted an
  // unmoved file as moved -- is unreachable now, because only a selection can
  // carry two paths and `fromSelection` refuses the move above.
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
 * A `refuse` comes back only for the two refusals that are SPOKEN, and it means
 * neither: light nothing, cancel nothing, and tell the user why. Returning it
 * rather than collapsing it to null is what stops the two listeners drifting on
 * the refusals that have to be voiced -- and it still never lights an icon,
 * because an icon that lights and then refuses is the exact failure this seam
 * exists to prevent.
 *
 * The two share one property that earns them the words: the pointer is on a
 * space that would otherwise act, and the reason it will not is invisible from
 * where the user is standing. Every other refusal is a pointer somewhere that
 * was never a target, and the "no drop" cursor says so for free.
 */
const SPOKEN_AT_HOVER: readonly string[] = [CLIPPED_SELECTION, SELECTION_ONTO_FOLDER_SPACE];

export function dropTargetFor(
  dragFromId: string | null,
  space: SpaceDefinition | null,
  drag: DraggedFiles,
  rootExists: (path: string) => boolean
): SpaceDrop | null {
  if (dragFromId !== null) return null;
  const drop = spaceDropFor(space, drag, rootExists);
  if (drop.kind !== "refuse") return drop;
  // Compared by identity against the constants rather than by prose, so the
  // wording and the test can change without the branch changing meaning.
  return SPOKEN_AT_HOVER.includes(drop.reason) ? drop : null;
}
