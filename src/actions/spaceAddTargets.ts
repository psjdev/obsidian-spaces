/**
 * Which spaces a selection can be added to, from *All*. Pure — no DOM,
 * no `"obsidian"` import.
 *
 * In *All* there is no active space and therefore no visibility snapshot to
 * consult, so membership is decided from the space definitions plus the tag
 * index: a path is already held if `resolveMembers` resolves to it, or if a
 * member FOLDER covers it. `resolveMembers` is the same expansion the engine
 * is handed, so "already held" here cannot drift from what the space shows;
 * `inheritedFromFolder` answers the folder question and is pure for exactly
 * this reason.
 *
 * The tag index is passed in rather than built here. It is a snapshot the
 * controller already owns, and taking a second one would let this menu
 * disagree with the tree it was opened from.
 */

import { canonicalPath } from "../visibility/glob";
import type { SpaceDefinition } from "../types";
import { inheritedFromFolder } from "../definitions/membership";
import { resolveMembers } from "../controller/resolveMembers";
import type { TagIndex } from "../visibility/TagIndex";
import { isFolderSpace } from "../visibility/folderSpace";

interface SpaceAddTarget {
  id: string;
  name: string;
  icon: string;
  color: string;
  /** Menu text, including why it is disabled or how many it would add. */
  label: string;
  /** True when there is nothing left to add to this space. */
  disabled: boolean;
  /** Exactly the paths this space does not already hold. */
  addablePaths: string[];
}

/**
 * Every path this space RESOLVES to, canonical.
 *
 * `resolveMembers`, not `pathMembers`: a note the space holds through a tag
 * member is already in it, and offering "Add to space" for it wrote a second,
 * redundant claim on a path the space had anyway. This is the same expansion
 * the visibility engine is handed, so the menu and the tree agree by
 * construction rather than by two implementations staying in step.
 *
 * Canonical, matching what the add dedupes with. An exact compare offers a
 * differently-cased path as addable, then the add drops it as a duplicate and
 * still reports it added.
 *
 * Built ONCE per space and closed over, never once per selected path: a tag
 * member costs a pass over the vault's notes to expand, and a selection of
 * fifty files would otherwise pay for fifty of them.
 */
function resolvedPaths(space: SpaceDefinition, tags: TagIndex): Set<string> {
  return new Set(resolveMembers(space, tags).map((m) => canonicalPath(m.path)));
}

/** Already held by this space, whether resolved directly or covered by a folder. */
function heldBy(
  space: SpaceDefinition,
  resolved: Set<string>,
  path: string
): { held: boolean; viaFolder: string | null } {
  if (resolved.has(canonicalPath(path))) return { held: true, viaFolder: null };
  const folder = inheritedFromFolder(space, path);
  if (folder === null) return { held: false, viaFolder: null };
  // Folder coverage is the engine's inherited-descendants step, not a seed,
  // so an exclusion still beats it here — the same precedence
  // `SpacesApi.isMember` applies. An explicit path member never reaches this
  // branch: `resolved` (built from `resolveMembers`, which never drops a
  // hand-picked member) already answered `held: true` for it above, exclusion
  // included.
  const excluded = (space.exclude ?? []).some((e) => canonicalPath(e) === canonicalPath(path));
  if (excluded) return { held: false, viaFolder: null };
  return { held: true, viaFolder: folder };
}

/**
 * One target per space, in definition order — the same order the switcher and
 * The dropdown use, so the three never disagree.
 *
 * A space that already holds EVERY selected path is disabled and says why,
 * rather than being omitted, matching the existing "Remove from
 * X (inherited from Y)" entry: a control that vanishes reads as a bug, while
 * one that explains itself teaches the membership model.
 */
export function spaceAddTargets(
  spaces: readonly SpaceDefinition[],
  paths: readonly string[],
  tags: TagIndex
): SpaceAddTarget[] {
  // Folder spaces are not targets: adding a path from elsewhere would mean
  // moving the file, and a space operation must never mutate the vault. A
  // control that cannot be honoured is worse than an absent one.
  return spaces.filter((s) => !isFolderSpace(s)).map((space) => {
    const resolved = resolvedPaths(space, tags);
    const addablePaths: string[] = [];
    let sharedFolder: string | null = null;
    for (const path of paths) {
      const { held, viaFolder } = heldBy(space, resolved, path);
      if (!held) addablePaths.push(path);
      else if (viaFolder && sharedFolder === null) sharedFolder = viaFolder;
    }

    const disabled = addablePaths.length === 0;
    let label = space.name;
    if (disabled) {
      // Name the responsible folder when one is: it explains the membership
      // model in passing. MenuItem has no tooltip API, so it goes in the
      // title — the same compromise the inherited-remove entry makes.
      label = sharedFolder ? `${space.name} (already in ${sharedFolder})` : `${space.name} (already added)`;
    } else if (addablePaths.length < paths.length) {
      // A mixed selection: say how many would actually move, or the entry
      // overstates what clicking it does.
      label = `${space.name} (${addablePaths.length})`;
    }

    return {
      id: space.id,
      name: space.name,
      icon: space.icon,
      color: space.color,
      label,
      disabled,
      addablePaths,
    };
  });
}
