import { movesIntoOwnSubtree } from "../order/dropIntent";
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

export function spaceDropFor(
  space: SpaceDefinition | null,
  paths: readonly string[]
): SpaceDrop {
  // *All* and the `+` control both arrive here as no space. Neither holds
  // members, so neither is a target.
  if (!space) return { kind: "refuse", reason: "not a space" };
  if (paths.length === 0) return { kind: "refuse", reason: "nothing is being dragged" };

  // `rootOf` reads "" and "/" as "no root chosen", so a space in the
  // missing-root state is curated here rather than an unusable move target.
  const root = rootOf(space);
  if (root === null) return { kind: "add", spaceId: space.id };

  // Folded before the test because `movesIntoOwnSubtree` compares with `===`
  // and `startsWith`. On a case insensitive filesystem `Clients` and `clients`
  // are one folder, and moving it inside itself would destroy it. The shared
  // helper is left alone: its other caller is the tree drag, and changing the
  // fold there is a separate question.
  const folded = paths.map(canonicalPath);
  if (movesIntoOwnSubtree(folded, canonicalPath(root))) {
    return { kind: "refuse", reason: "that folder is the space's own root" };
  }

  return { kind: "move", spaceId: space.id, root };
}

/**
 * The one question both listeners ask: is there something to do here?
 *
 * Null means "not ours": do not light the icon, do not call
 * `preventDefault()`, let the event pass. That covers a reorder (which the
 * existing branch owns), a pointer over no space, a pointer with no file drag
 * behind it, and a refusal. Collapsing all four into one null is what keeps
 * the two listeners from drifting apart.
 */
export function dropTargetFor(
  dragFromId: string | null,
  space: SpaceDefinition | null,
  paths: readonly string[]
): Exclude<SpaceDrop, { kind: "refuse" }> | null {
  if (dragFromId !== null) return null;
  const drop = spaceDropFor(space, paths);
  return drop.kind === "refuse" ? null : drop;
}
