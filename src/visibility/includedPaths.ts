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
  // Belt and braces against a future `resolveLivePath`, not a behaviour
  // change: today every seed is already a live path that exists.
  for (const p of seedPaths) if (vault.exists(p)) seeds.add(p);

  // 2. expand folder seeds, applying ignore to inherited descendants only
  const inherited = new Set<string>();
  let filtered = excluded.size > 0;
  for (const seed of seeds) {
    if (vault.kindOf(seed) !== "folder") continue;
    for (const d of vault.descendantsOf(seed)) {
      if (ignore.matches(d)) {
        filtered = true;
        continue;
      }
      if (excluded.has(canonicalPath(d))) continue;
      inherited.add(d);
    }
  }

  // 3. included
  const included = new Set<string>([...seeds, ...inherited]);

  // 3b. prune folders emptied by filtering, bottom-up.
  //
  // Skipped entirely when nothing could have been filtered. If no ignore
  // pattern matched and there are no exclusions, every path under a folder
  // seed is in `included`, so a folder here can only lack an included
  // descendant by being empty in the vault, which this step already spares.
  // Measured: zero removals across every shape tried. Most vaults have an
  // empty `globalIgnore`, so this is the common case, and it is the whole
  // step rather than a fast path through it.
  if (filtered) {
    // Deepest first, so everything below a folder is already decided when it
    // is reached. The previous version asked `descendantsOf` per folder
    // inside a fixpoint, which is O(folders x subtree x levels-emptied):
    // 376 ms on a 97,655-path vault with ignore rules, against 83 ms for this.
    //
    // "Carries an included descendant" is not the same as "has an included
    // child". Ignore patterns are anchored, so one can drop an intermediate
    // folder without dropping what is inside it: S/A/B ignored, S/A/B/c.md
    // kept. S/A then has no included child but still has an included
    // descendant, and the fixpoint kept it. So `carries` recurses through
    // folders that are NOT in `included` as well. It is memoised, so each
    // folder is answered once and the whole pass stays linear.
    //
    // Bucketed rather than sorted. At 11,110 folders with nothing to remove,
    // a comparison sort costs more than the whole fixpoint did.
    const carry = new Map<string, boolean>();
    const carries = (p: string): boolean => {
      const known = carry.get(p);
      if (known !== undefined) return known;
      let any = false;
      for (const k of vault.childrenOf(p)) {
        if (included.has(k) || (vault.kindOf(k) === "folder" && carries(k))) {
          any = true;
          break;
        }
      }
      carry.set(p, any);
      return any;
    };
    const byDepth: string[][] = [];
    for (const p of included) {
      if (vault.kindOf(p) !== "folder") continue;
      let d = 0;
      for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === 47) d++;
      (byDepth[d] ??= []).push(p);
    }
    for (let d = byDepth.length - 1; d >= 0; d--) {
      for (const p of byDepth[d] ?? []) {
        if (seeds.has(p)) continue;
        // A folder with no children in the vault was left empty by the user.
        if (vault.childrenOf(p).length === 0) continue;
        if (!carries(p)) included.delete(p);
      }
    }
    // Step 3b can remove a folder from `included` after step 2 recorded it as
    // inherited. Re-sync so `decisionFor` never reports a visibility-implying
    // reason for a path that is no longer visible.
    for (const p of [...inherited]) {
      if (!included.has(p)) inherited.delete(p);
    }
  }

  return { seeds, inherited, included };
}
