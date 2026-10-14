import type { FrontmatterRead } from "./frontmatterHead";
import type { PropertyEntry, PropertyWalk } from "./ObsidianPropertyIndex";

/**
 * Deciding WHICH unparsed files to read, and folding what came back into the
 * walk they came from. Both pure, both over lists, so neither needs Obsidian
 * or a disk to test.
 */

/**
 * 200 files. What this bounds, exactly, and what it does not.
 *
 * IT BOUNDS THE UNPARSED LIST AT THE MOMENT OF THE ASK. Vault size never
 * enters it. So the guarantee is: a single mistaken verdict from
 * `lifecycle/parseStall.ts` costs at most 200 files read, once. It is a blast
 * radius.
 *
 * In bytes that is 3 MB in the ordinary case, where the first 16 KB window
 * answers, and 65.6 MB in the worst one, where every file holds a frontmatter
 * block still open at the 256 KB cap and so costs all three windows —
 * 16 + 64 + 256 KB each. The worst case needs 200 such files in one vault and
 * has never been seen; it is stated because an earlier version of this comment
 * said "200 head reads of 16 KB" and was wrong by twenty times.
 *
 * It is NOT a proof that a cold start can never be read off disk. An earlier
 * version of this comment said any vault over 200 notes was "structurally
 * incapable" of that, and it was wrong: a 5,000-note vault mid-index with 150
 * files still outstanding plans a `"repair"` and reads those 150, because 150
 * is under the cap. What makes that affordable is the cost of being wrong —
 * 150 heads, once, answers identical to what the cache would have given — and
 * not the cap making it unreachable.
 *
 * The number is right on its own terms, and the measurement behind it is in
 * `sdd/property-members/jam-scale-report.md`. A jam leaves unparsed exactly the
 * suffix of Obsidian's vault walk from the jamming file onward:
 *
 *  - WARM — a vault Obsidian has opened before, into which an oversized note
 *    then arrives or syncs in, which is the case a real user meets — leaves
 *    **one file unparsed, and that file is the jammer**. 1 of 501 and 1 of
 *    5,001, `inProgressTaskCount` 1. It does not scale with vault size.
 *  - COLD, with the jammer at the vault root, leaves **everything**: 501 of 501
 *    and 5,001 of 5,001, and zero `resolve` events for the whole run. That is
 *    an Obsidian-level outage far past anything 200 head reads could paper
 *    over, and the honest answer is the one this cap produces: `"too-many"`,
 *    nothing read, the snapshot left unavailable.
 *
 * Two runs at each size agreed exactly. 200 sits two orders of magnitude above
 * the warm case and more than one below the cold one, which is where a bound of
 * this kind belongs. 200 heads at 16 KB is 3 MB read once.
 */
export const PROPERTY_REPAIR_MAX_FILES = 200;

export type RepairPlan =
  /** Read these. */
  | { readonly kind: "repair"; readonly paths: readonly string[] }
  /**
   * Too many to be a jam. Nothing is read: the snapshot stays unavailable and
   * honestly so, which is the correct answer for a cache that is merely cold.
   */
  | { readonly kind: "too-many"; readonly count: number }
  /** Nothing unparsed. There is nothing to repair. */
  | { readonly kind: "nothing" };

export function planRepair(unparsed: readonly string[]): RepairPlan {
  if (unparsed.length === 0) return { kind: "nothing" };
  if (unparsed.length > PROPERTY_REPAIR_MAX_FILES) return { kind: "too-many", count: unparsed.length };
  return { kind: "repair", paths: unparsed };
}

/**
 * The walk, with the holes we could fill filled in.
 *
 * A pure function over two lists, which is what makes the install in `main.ts`
 * safe: the caller computes a COMPLETE new walk off to the side and installs
 * it in one assignment. Nothing half-repaired is ever observable, because a
 * half-repaired walk never exists as a value anyone can see.
 *
 * The three answers, and why each lands where it does:
 *
 *  - `"frontmatter"` becomes an entry, exactly as if the cache had given it.
 *  - `"none"` becomes NOTHING, and the path leaves `unparsed`. The file really
 *    has no frontmatter — `frontmatterHead.ts` records the measurements that
 *    say when that is true — so it contributes nothing and is no longer a hole.
 *  - `"unreadable"`, and a path nobody read at all, STAY in `unparsed`. This is
 *    the honest half of the design: a file we could not answer for keeps the
 *    snapshot unavailable, rather than being quietly counted as having no
 *    properties. A count labelled complete that is missing a note is worse
 *    than a feature that says it is still looking.
 */
export function mergeRepairedWalk(
  walk: PropertyWalk,
  repaired: ReadonlyMap<string, FrontmatterRead>
): PropertyWalk {
  const entries: PropertyEntry[] = [...walk.entries];
  const unparsed: string[] = [];
  for (const path of walk.unparsed) {
    const read = repaired.get(path);
    if (read === undefined || read.kind === "unreadable") {
      unparsed.push(path);
      continue;
    }
    if (read.kind === "frontmatter") entries.push({ path, frontmatter: read.frontmatter });
  }
  return { entries, unparsed };
}
