import { includedPaths } from "../visibility/includedPaths";
import { expandMembers, type MemberTags } from "../controller/resolveMembers";
import type { IgnoreMatcher } from "../visibility/glob";
import type { VaultIndex } from "../visibility/VaultIndex";
import type { MemberEntry } from "../types";
import type { PropertyIndex } from "../visibility/PropertyIndex";

/**
 * The slice of the tag index this needs. `TagIndex` satisfies it structurally.
 *
 * The expansion's own type, re-exported under the name this seam has always
 * used, so there is one shape to satisfy rather than two identical ones.
 */
export type PreviewTags = MemberTags;

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
 * under the picker could promise notes the space would never contain. It now
 * runs `expandMembers`, THE expansion a recompute runs rather than a copy of
 * it, and hands the seeds to `includedPaths`, which is the same ignore and
 * pruning a recompute runs. A copy lived here and had drifted: its chain had
 * no exhaustive tail, so a fifth member kind would have gone missing from
 * every preview without a compile error.
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
  // hold a property member, which `expandMembers` is what guarantees: a
  // selection with no property member must not ask the controller for an
  // index at all.
  properties: () => PropertyIndex | null,
  excluded: ReadonlySet<string> = new Set()
): (members: readonly MemberEntry[]) => Preview {
  return (members) => {
    // The seeds, in member order, de-duplicated on the folded path by the
    // expansion itself. `includedPaths` de-duplicates seeds EXACTLY, so
    // without that a case-sensitive vault holding `Docs/a.md` and `docs/a.md`
    // would count 2 here where a recompute, which keeps the first spelling,
    // counts 1. Exclusions drop a tag or property match and never a
    // hand-picked path, which is the expansion's precedence and not this
    // seam's to choose, and the global ignore drops one on the same terms.
    const seeds: string[] = [];
    expandMembers(
      members,
      tags,
      properties,
      // Null rather than an empty Set for the common case, the same fast path
      // `resolveMembers` takes.
      excluded.size === 0 ? null : excluded,
      // The same matcher `includedPaths` is handed below. A tag or property
      // match the vault hides is dropped during the expansion, so the number
      // under the picker counts what the space will actually show.
      ignore,
      (m) => seeds.push(m.path)
    );
    const { included } = includedPaths(vault, seeds, ignore, excluded);
    let notes = 0;
    for (const p of included) if (vault.kindOf(p) === "file") notes += 1;
    return { paths: included, notes };
  };
}
