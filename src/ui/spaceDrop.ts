import type { DraggedFiles } from "../order/currentDrag";
import type { SpaceDefinition } from "../types";
import { hasRoot } from "../visibility/folderSpace";

/**
 * What a drop on a space icon means.
 *
 * `refuse` carries a reason so the caller can say why, and so the two callers
 * cannot disagree about whether a drop would act: `dragover` lights the icon
 * only for a non-refusal, and `drop` acts only on the same answer.
 *
 * ADD IS THE ONLY ACT. The gesture used to have a second one -- dropping on a
 * space pinned to a folder moved the file on disk with `renameFile` -- and that
 * was removed by an owner's decision rather than because it misbehaved. The two
 * kinds of icon are pixel identical in the strip, both painted the same drop
 * ring, and the only thing that told a user which outcome they were about to
 * get was the operating system's cursor badge. One of those outcomes rewrote
 * the vault with no undo. Putting a note inside a pinned folder is now its own
 * ticket, and until it has an answer the user cannot mistake, this seam offers
 * exactly one outcome: members in `data.json`, which "Remove from space" undoes.
 */
export type SpaceDrop =
  | { kind: "add"; spaceId: string }
  /**
   * `spaceName` is carried so the refusals that are SAID OUT LOUD can name the
   * space the pointer is on. Both of them ask the user to do something else
   * instead, and "use Move file to... to put it inside Work" is advice where
   * "inside the space" is a riddle with four icons side by side. It is absent
   * for the refusals no human ever hears -- no space under the pointer, nothing
   * being dragged -- because there is no space to name.
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
 * they selected. Silence there reads as a broken feature.
 *
 * KEPT AFTER THE MOVE WAS REMOVED, deliberately and against the obvious
 * argument for dropping it. Adding members is reversible, so the worst this
 * guard now prevents is a wrong member list rather than lost files. A wrong
 * member list is still wrong: the user selects forty notes, the explorer is
 * holding twelve of them, and acting would write twelve members and report that
 * as the whole gesture. Reversible-but-wrong is not a reason to do it.
 *
 * Compared by identity against this constant rather than by prose, so the
 * message and the test can change without the branch changing meaning.
 */
/**
 * No space under the pointer at all.
 *
 * Silent at hover -- the pointer is over the gap between icons and the "no
 * drop" cursor says so for free -- but NOT silent at the drop, where it means
 * something else entirely: the icon lit, the user released on it, and the
 * space stopped existing while the button was down. The wording for that lives
 * with the other refusals in `main.ts`.
 */
export const SPACE_GONE = "not a space";

export const CLIPPED_SELECTION = "part of the selection is outside the render window";

/**
 * The second refusal the strip says out loud: a space PINNED TO A FOLDER.
 *
 * Such a space renders from its root folder and never shows a member list, so
 * writing members to it would be a write the user can never see. That is why
 * `registerMembershipMenus` has always kept pinned spaces out of "Add to
 * space", and this is the strip saying the same thing with the pointer already
 * on the icon.
 *
 * It is SPOKEN rather than left to the "no drop" cursor because this is the one
 * refusal a reasonable user will read as a bug. The pointer is on a real space,
 * the icon sits in the same row as others that do accept the drop, and nothing
 * about it looks different. Silence there is indistinguishable from a feature
 * that stopped working.
 *
 * Putting a note INSIDE the pinned folder is a different action with a
 * different cost, and it is deferred to its own ticket rather than ridden in on
 * this gesture. Obsidian's own "Move file to..." does it today, which is what
 * the notice points at.
 */
export const FOLDER_PINNED_SPACE = "a space pinned to a folder has no member list";

/**
 * What a drop on this space would do.
 *
 * Pure, so that the icon can never promise something the drop will not deliver.
 * Asked on every `dragover` over an icon, again at `drop`, and a third time
 * with the subset of paths that survived to the drop; nothing it reads can
 * change under it between those, because every input now comes from the drag
 * record and the space definition. It used to take a `rootExists` probe of the
 * live vault, which was the one thing that could make two of those asks
 * disagree. That probe existed only to decide whether a folder was there to
 * move INTO, so it went when the move did.
 */
export function spaceDropFor(space: SpaceDefinition | null, drag: DraggedFiles): SpaceDrop {
  // *All* and the `+` control both arrive here as no space. Neither holds
  // members, so neither is a target.
  if (!space) return { kind: "refuse", reason: SPACE_GONE };
  if (drag.paths.length === 0) {
    return { kind: "refuse", reason: "nothing is being dragged" };
  }

  // Split on `hasRoot`, not on `rootOf`. `rootOf` answers null for two
  // different states -- "curated, no root at all" and "a root was declared and
  // cannot be honoured" -- and collapsing them here made a space in the
  // missing-root state look curated, which is the one state where adding
  // members is most obviously wrong: the space still renders from the root it
  // cannot find, so the members would be invisible AND the space would look
  // broken. `hasRoot` answers the question actually being asked, which is
  // whether this space has a member list at all.
  //
  // Asked BEFORE the clipped-selection check, and the order is deliberate.
  // Both refusals are true of a clipped selection aimed at a pinned space, but
  // only one of them is useful: "select fewer notes and folders, then drag
  // again" is advice the user can follow forever without this icon ever
  // accepting anything. The standing fact about the space beats the fact about
  // this particular gesture.
  if (hasRoot(space)) {
    return { kind: "refuse", reason: FOLDER_PINNED_SPACE, spaceName: space.name };
  }

  // Refused rather than trimmed to what is visible. `DragOrdering` makes the
  // same call for its own drops, and `dropIntent.ts` records why above
  // `movesIntoOwnSubtree`: a multi-selection is one gesture, and acting on the
  // possible half leaves a partial result the user did not ask for and cannot
  // see the shape of. Here that half is a member list missing most of what was
  // selected, written by a gesture whose notice counts only what it wrote.
  if (drag.truncated) {
    return { kind: "refuse", reason: CLIPPED_SELECTION, spaceName: space.name };
  }

  return { kind: "add", spaceId: space.id };
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
 * An `add` means light the icon and act on the drop.
 *
 * A `refuse` comes back only for the two refusals that are SPOKEN, and it means
 * neither: light nothing, cancel nothing, and tell the user why. Returning it
 * rather than collapsing it to null is what stops the two listeners drifting on
 * the refusals that have to be voiced -- and it still never lights an icon,
 * because an icon that lights and then refuses is the exact failure this seam
 * exists to prevent.
 *
 * The two share one property that earns them the words: the pointer is on a
 * space that looks exactly like a target, and the reason it will not act is
 * invisible from where the user is standing. Every other refusal is a pointer
 * somewhere that was never a target, and the "no drop" cursor says so for free.
 */
const SPOKEN_AT_HOVER: readonly string[] = [CLIPPED_SELECTION, FOLDER_PINNED_SPACE];

export function dropTargetFor(
  dragFromId: string | null,
  space: SpaceDefinition | null,
  drag: DraggedFiles
): SpaceDrop | null {
  if (dragFromId !== null) return null;
  const drop = spaceDropFor(space, drag);
  if (drop.kind !== "refuse") return drop;
  // Compared by identity against the constants rather than by prose, so the
  // wording and the test can change without the branch changing meaning.
  return SPOKEN_AT_HOVER.includes(drop.reason) ? drop : null;
}
