import { canonicalPath, type IgnoreMatcher } from "./glob";
import type { VaultIndex } from "./VaultIndex";

/**
 * What a space holds, before anything is drawn.
 *
 * Steps 1 to 3b of a visibility snapshot, split out because the create panel
 * needs exactly this and nothing after it. The panel asks what the space will
 * contain; the ancestor closure and the per-path reasons answer a different
 * question, for the explorer, and cost about half of a snapshot.
 *
 * Splitting it is also what stops the panel keeping its own idea of
 * membership. It had one, and it disagreed with this one about case, about
 * `globalIgnore` and about empty folders.
 */
export interface IncludedPaths {
  /** Seeds as given, filtered to those that exist in the vault. */
  seeds: Set<string>;
  /** Descendants of folder seeds that survived ignore and exclusion. */
  inherited: Set<string>;
  /** seeds + inherited, minus folders left empty by filtering. */
  included: Set<string>;
}

export function includedPaths(
  vault: VaultIndex,
  seedPaths: Iterable<string>,
  ignore: IgnoreMatcher,
  excluded: ReadonlySet<string>
): IncludedPaths {
  // 1. seeds bypass globalIgnore entirely
  const seeds = new Set<string>();
  for (const p of seedPaths) if (vault.exists(p)) seeds.add(p);

  // 2. expand folder seeds, applying ignore to inherited descendants only
  const inherited = new Set<string>();
  for (const seed of seeds) {
    if (vault.kindOf(seed) !== "folder") continue;
    for (const d of vault.descendantsOf(seed)) {
      if (ignore.matches(d)) continue;
      if (excluded.has(canonicalPath(d))) continue;
      inherited.add(d);
    }
  }

  // 3. included
  const included = new Set<string>([...seeds, ...inherited]);

  // 3b. prune folders emptied by ignore rules, bottom-up to a fixpoint.
  // A folder with no children in the vault was left empty by the user and
  // must be spared; only folders emptied by filtering disappear.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of [...included]) {
      if (seeds.has(p)) continue;
      if (vault.kindOf(p) !== "folder") continue;
      if (vault.childrenOf(p).length === 0) continue;
      const hasVisibleDescendant = vault.descendantsOf(p).some((d) => included.has(d));
      if (!hasVisibleDescendant) {
        included.delete(p);
        changed = true;
      }
    }
  }

  // Step 3b can remove a folder from `included` after step 2 recorded it as
  // inherited. Re-sync so `decisionFor` never reports a visibility-implying
  // reason for a path that is no longer visible.
  for (const p of [...inherited]) {
    if (!included.has(p)) inherited.delete(p);
  }

  return { seeds, inherited, included };
}
