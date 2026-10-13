import type { FrontmatterRead } from "./frontmatterHead";
import type { PropertyEntry, PropertyWalk } from "./ObsidianPropertyIndex";

/**
 * Deciding WHICH unparsed files to read, and folding what came back into the
 * walk they came from. Both pure, both over lists, so neither needs Obsidian
 * or a disk to test.
 */

/**
 * 200 files, and this is the number that makes the whole design safe.
 *
 * AT COLD START EVERY FILE IS UNPARSED. A repair that answered that by reading
 * the vault off disk would be far worse than the outage it exists to fix, and
 * the trigger alone is not enough to guarantee it cannot happen — a trigger is
 * a judgement about timing, and this is an absolute bound. Any vault bigger
 * than 200 notes is therefore structurally incapable of having its cold start
 * read from disk by this code, whatever the trigger decides.
 *
 * It is also the right number on its own terms: the measured jams held 2 to 14
 * unparsed files, a vault where thousands are unparsed is broken in a way to
 * REPORT rather than paper over, and 200 heads at 16 KB is 3 MB read once.
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
