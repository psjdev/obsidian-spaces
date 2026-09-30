import type {
  SpaceDefinition,
  VisibilityDecision,
  VisibilityReason,
} from "../types";
import { canonicalPath, type IgnoreMatcher } from "./glob";
import type { VaultIndex } from "./VaultIndex";
import { pathMembers } from "../definitions/membership";

export interface VisibilitySnapshot {
  decisionFor(path: string): VisibilityDecision;
  visiblePaths(): Set<string>;
}

const HIDDEN_NONMEMBER: VisibilityDecision = {
  visible: false,
  reason: "hidden-nonmember",
  canRemoveMembership: false,
  overridesIgnore: false,
};

/**
 * Resolve a stored path to the live path it names.4's
 * case-insensitive policy, or `null` when the vault holds nothing by that
 * name in any casing.
 *
 * An exact hit short-circuits, so a case-sensitive filesystem holding both
 * `a/Note.md` and `a/note.md` still gives each stored path itself; the fold
 * only ever decides a lookup that would otherwise have failed. That is also
 * what keeps this off the hot path — the walk runs only for a member the
 * verbatim lookup missed, and costs one `childrenOf` per segment rather than
 * an O(vault) rescan.
 */
function resolveLivePath(vault: VaultIndex, stored: string): string | null {
  if (vault.exists(stored)) return stored;
  let at = "";
  for (const seg of stored.split("/")) {
    const want = canonicalPath(seg);
    const offset = at === "" ? 0 : at.length + 1;
    const hit = vault
      .childrenOf(at)
      .find((c) => canonicalPath(c.slice(offset)) === want);
    if (hit === undefined) return null;
    at = hit;
  }
  return at;
}

export function buildVisibilitySnapshot(
  vault: VaultIndex,
  space: SpaceDefinition,
  visitorPaths: Set<string>,
  ignore: IgnoreMatcher,
  /**
   * Paths this space leaves out, already passed through `canonicalPath`.
   *
   * Consulted in exactly one place, beside the `ignore` test when expanding
   * folder seeds. That one line gives the whole precedence table, because the
   * other two cases are decided before this function runs: a tag-matched note
   * was dropped during expansion, and a hand-added note is a seed, and seeds
   * bypass this step entirely.
   *
   * A set of literal paths rather than more ignore patterns. `escapeSeg`
   * cannot express a path containing `*` as a pattern meaning only itself.
   */
  excluded: ReadonlySet<string>
): VisibilitySnapshot {
  // Every set below is keyed by the LIVE path, so `decisionFor` — which is
  // called with paths straight out of the explorer — stays an exact lookup.
  // Only the stored side is folded.
  const exact = new Set<string>();
  // Tag members carry no path and are filtered out here because this loop
  // resolves stored paths to live ones; they contribute no seeds this way.
  for (const m of pathMembers(space)) {
    const live = resolveLivePath(vault, m.path);
    if (live !== null) exact.add(live);
  }

  const visitors = new Set<string>();
  for (const p of visitorPaths) {
    const live = resolveLivePath(vault, p);
    if (live !== null) visitors.add(live);
  }

  // 1. seeds bypass globalIgnore entirely
  const seeds = new Set<string>([...exact, ...visitors]);

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
      const hasVisibleDescendant = vault
        .descendantsOf(p)
        .some((d) => included.has(d));
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

  // 4. ancestor closure, regardless of ignore rules.
  //
  // Climbs once per DISTINCT directory instead of once per included path.
  // `ancestorsOf` rebuilds the whole chain from scratch for every path, with a
  // `split` and then a `slice` and a `join` per level, so siblings recompute
  // identical ancestor strings: on a measured 10,000 note vault a tag space's
  // 1,213 paths produced 1,213 climbs over 98 distinct directories. This is
  // 73 to 81 % of a snapshot in every space shape measured, so it is worth the
  // hand-rolled loop; `ancestorsOf` stays, because `inheritedFromFolder` wants
  // the array and is not on a hot path.
  //
  // `done` marks a directory whose WHOLE chain has been walked, which is what
  // makes stopping at the first marked level correct rather than merely fast:
  // the walk always continues upward from the directory it has just marked, so
  // nothing can be marked without everything above it being marked in the same
  // pass. A path with no `/` has no ancestors and is skipped, which is what
  // `ancestorsOf` already did for a root-level file.
  //
  // Measured against the shipped version with identical output on all three:
  // 3.8 ms to 0.8 ms at 1,213 paths, 11.9 ms to 1.9 ms at 3,371, and 32.6 ms
  // to 4.2 ms at all 10,000.
  const scaffold = new Set<string>();
  const done = new Set<string>();
  for (const p of included) {
    let i = p.lastIndexOf("/");
    if (i === -1) continue;
    let d = p.slice(0, i);
    while (d !== "" && !done.has(d)) {
      done.add(d);
      if (!included.has(d)) scaffold.add(d);
      i = d.lastIndexOf("/");
      if (i === -1) break;
      d = d.slice(0, i);
    }
  }

  const visible = new Set<string>([...included, ...scaffold]);

  function reasonFor(path: string): VisibilityReason {
    if (exact.has(path)) return "exact-member";
    if (inherited.has(path)) return "inherited-member";
    if (visitors.has(path)) return "visitor";
    if (scaffold.has(path)) return "scaffold";
    return ignore.matches(path) ? "hidden-ignore" : "hidden-nonmember";
  }

  return {
    visiblePaths: () => new Set(visible),
    decisionFor(path: string): VisibilityDecision {
      if (!visible.has(path)) {
        const reason = reasonFor(path);
        return { ...HIDDEN_NONMEMBER, reason };
      }
      return {
        visible: true,
        reason: reasonFor(path),
        canRemoveMembership: exact.has(path),
        overridesIgnore: exact.has(path) && ignore.matches(path),
      };
    },
  };
}
