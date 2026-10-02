import { includedPaths } from "../visibility/includedPaths";
import { canonicalPath, type IgnoreMatcher } from "../visibility/glob";
import type { VaultIndex } from "../visibility/VaultIndex";
import type { MemberEntry } from "../types";

/** The slice of the tag index this needs. `TagIndex` satisfies it structurally. */
export interface PreviewTags {
  pathsMatching(tag: string): readonly string[];
}

export interface Preview {
  /**
   * Every path the space covers: the notes, and the folders a folder member
   * brought in. Both, because the tree that draws this wants the folders as
   * branches.
   */
  paths: Set<string>;
  /** How many of those are notes. Folders are structure, not contents. */
  notes: number;
}

/**
 * What the space being created would hold, answered by the engine's own
 * `includedPaths`.
 *
 * The panel used to answer this itself, with a case-sensitive prefix scan that
 * consulted no ignore patterns and pruned no empty folders, so the number
 * under the picker could promise notes the space would never contain. This
 * expands tag members into the notes carrying them, as `resolveMembers` does,
 * and hands the result to `includedPaths`, which is the same expansion,
 * ignore and pruning a recompute runs.
 *
 * One step of a recompute is NOT repeated here: resolving a stored spelling to
 * the live path (`resolveLivePath`). Every member the panel holds was picked
 * from the live vault, so it already is a live path; a stored space whose
 * spelling had drifted would need that step, and this is not asked about one.
 *
 * Members are a UNION: every member adds to the result and none narrows it,
 * and a note carried by two members is in the set once, so the count agrees
 * with the rows.
 *
 * Curried: `main.ts` binds the vault, the compiled ignore and the tag index,
 * and the panel calls a function of its members alone.
 */
export function buildPreview(
  vault: VaultIndex,
  ignore: IgnoreMatcher,
  tags: PreviewTags,
  excluded: ReadonlySet<string> = new Set()
): (members: readonly MemberEntry[]) => Preview {
  return (members) => {
    const seeds: string[] = [];
    for (const m of members) {
      if (m.kind === "tag") {
        // A tag match is dropped by an exclusion; a hand-picked path is not,
        // the same precedence `resolveMembers` gives them.
        for (const p of tags.pathsMatching(m.tag)) {
          if (!excluded.has(canonicalPath(p))) seeds.push(p);
        }
        continue;
      }
      seeds.push(m.path);
    }
    const { included } = includedPaths(vault, seeds, ignore, excluded);
    let notes = 0;
    for (const p of included) if (vault.kindOf(p) === "file") notes += 1;
    return { paths: included, notes };
  };
}
