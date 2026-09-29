/**
 * Which spaces a selection can be added to, from *All*. Pure — no DOM,
 * no `"obsidian"` import.
 *
 * In *All* there is no active space and therefore no visibility snapshot to
 * consult, so membership is decided from the space definitions alone: a path
 * is already held if it is an exact member, or if a member FOLDER covers it.
 * `inheritedFromFolder` answers the second question and is pure for exactly
 * this reason.
 */

import { canonicalPath } from "../visibility/glob";
import type { SpaceDefinition } from "../types";
import { inheritedFromFolder, pathMembers } from "../definitions/membership";
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

/** Already held by this space, whether named directly or covered by a folder. */
function heldBy(space: SpaceDefinition, path: string): { held: boolean; viaFolder: string | null } {
  // Canonical, matching what the add dedupes with. An exact compare offers a
  // differently-cased path as addable, then the add drops it as a duplicate and
  // still reports it added.
  if (pathMembers(space).some((m) => canonicalPath(m.path) === canonicalPath(path))) {
    return { held: true, viaFolder: null };
  }
  const folder = inheritedFromFolder(space, path);
  return { held: folder !== null, viaFolder: folder };
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
  paths: readonly string[]
): SpaceAddTarget[] {
  // Folder spaces are not targets: adding a path from elsewhere would mean
  // moving the file, and a space operation must never mutate the vault. A
  // control that cannot be honoured is worse than an absent one.
  return spaces.filter((s) => !isFolderSpace(s)).map((space) => {
    const addablePaths: string[] = [];
    let sharedFolder: string | null = null;
    for (const path of paths) {
      const { held, viaFolder } = heldBy(space, path);
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
