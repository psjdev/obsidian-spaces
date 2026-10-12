import { includedPaths } from "../visibility/includedPaths";
import { canonicalPath, type IgnoreMatcher } from "../visibility/glob";
import type { VaultIndex } from "../visibility/VaultIndex";
import type { MemberEntry } from "../types";
import type { PropertyIndex } from "../visibility/PropertyIndex";

/** The slice of the tag index this needs. `TagIndex` satisfies it structurally. */
export interface PreviewTags {
  pathsMatching(tag: string): readonly string[];
}

export interface Preview {
  /**
   * Every path the space covers: the notes, and the folders a folder member
   * brought in. The panel reads only `notes`; this is kept because it is what
   * `includedPaths` returns and the tests compare it against the engine's.
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
 * expands tag and property members into the notes they match and
 * de-duplicates on the folded path, both as `resolveMembers` does,
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
 * A property member contributes nothing while `properties()` answers `null`
 * (the metadata cache is cold). That is "not known yet", not "matches
 * nothing", so a count taken then can be low and a later preview corrects it.
 *
 * Curried: `main.ts` binds the vault, the compiled ignore and the tag index,
 * and the panel calls a function of its members alone.
 */
export function buildPreview(
  vault: VaultIndex,
  ignore: IgnoreMatcher,
  tags: PreviewTags,
  // A function, called at most ONCE per preview and only when the members
  // hold a property member: while the cache is cold each ask rebuilds, and a
  // selection with no property member must not pay for it.
  properties: () => PropertyIndex | null,
  excluded: ReadonlySet<string> = new Set()
): (members: readonly MemberEntry[]) => Preview {
  return (members) => {
    const seeds: string[] = [];
    // One `seen` over tag matches and path members alike, keyed on the folded
    // path and filled in member order, exactly as `resolveMembers` does it.
    // `includedPaths` de-duplicates seeds exactly, so without this a
    // case-sensitive vault holding `Docs/a.md` and `docs/a.md` would count
    // 2 here where a recompute, which keeps the first spelling, counts 1.
    const seen = new Set<string>();
    const add = (path: string, key: string): void => {
      if (seen.has(key)) return;
      seen.add(key);
      seeds.push(path);
    };
    // Resolved on the first property member, then reused for the rest.
    let index: PropertyIndex | null | undefined;
    for (const m of members) {
      if (m.kind === "property") {
        // `undefined` is the only "not asked yet": a `null` answer must be
        // remembered too, or each further property member asks again, and
        // while the cache is cold every ask is a vault walk.
        if (index === undefined) index = properties();
        if (index === null) continue;
        // A property match is dropped by an exclusion, as a tag match is.
        const matched =
          m.value === undefined
            ? index.pathsWithKey(m.key)
            : index.pathsMatching(m.key, m.value);
        for (const p of matched) {
          const key = canonicalPath(p);
          if (!excluded.has(key)) add(p, key);
        }
        continue;
      }
      if (m.kind === "tag") {
        // A tag match is dropped by an exclusion; a hand-picked path is not,
        // the same precedence `resolveMembers` gives them.
        for (const p of tags.pathsMatching(m.tag)) {
          const key = canonicalPath(p);
          if (!excluded.has(key)) add(p, key);
        }
        continue;
      }
      if (m.kind === "file" || m.kind === "folder") add(m.path, canonicalPath(m.path));
    }
    const { included } = includedPaths(vault, seeds, ignore, excluded);
    let notes = 0;
    for (const p of included) if (vault.kindOf(p) === "file") notes += 1;
    return { paths: included, notes };
  };
}
