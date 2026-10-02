import type { PathMember, SpaceDefinition } from "../types";
import type { TagIndex } from "../visibility/TagIndex";
import { canonicalPath } from "../visibility/glob";

/**
 * The member list the visibility engine is handed, with every tag member
 * expanded into the notes carrying that tag.
 *
 * The engine never learns what a tag is. It receives file members, which it
 * already knows how to seed, so scaffolding, pruning, ignore precedence and
 * the reason vocabulary all apply with no change. This is the same trick
 * `membersForSnapshot` already plays for a folder space, which presents
 * itself as a space whose single member is its root.
 *
 * Exclusions are applied HERE for tag matches rather than left to the engine.
 * An expanded note arrives as a seed, and seeds bypass the engine's ignore
 * step by design, so an excluded tag match that reached the engine would be
 * visible. A hand-added member is a seed for the same reason and survives its
 * own exclusion, which is the intended precedence.
 *
 * ## The per-path tail is the whole cost
 *
 * A tag member expands to every note carrying the tag, so anything done once
 * per MATCHED PATH is done thousands of times per recompute — measured at
 * 99.98 % of this function over a 3,785 match expansion. Two things were, and
 * are not any more:
 *
 *  - `canonicalPath` ran twice per match: once for the exclusion test, and
 *    again inside `add` to key the de-duplication. It runs once now and the
 *    key is threaded through.
 *  - an exclusion `Set` was built and queried even for a space with no
 *    `exclude` at all, which is every space until someone removes a note from
 *    one.
 *
 * 7.59 ms to 2.51 ms over those 3,785 paths, with identical output. The
 * canonical-path de-duplication is exactly what must NOT change: two
 * spellings of one note (a tag match and a hand-added member differing only
 * in case) must still seed once, or the user gets a duplicate row.
 */
export function resolveMembers(
  space: SpaceDefinition,
  tags: TagIndex
): PathMember[] {
  // Null rather than an empty Set. The usual space has no exclusions at all,
  // and a null test per matched path is cheaper than a hash lookup that can
  // never hit — and cheaper still than building the Set to make it.
  const stored = space.exclude;
  const excluded =
    stored === undefined || stored.length === 0 ? null : new Set(stored.map(canonicalPath));
  const out: PathMember[] = [];
  // Keyed on the bare canonical path, not kind-plus-path: by this point
  // every entry is a path member, and only one vault object can occupy a
  // given path, so the path alone already identifies it uniquely.
  const seen = new Set<string>();

  // `key` is passed in rather than derived here, because both call sites
  // below have already canonicalised the path for their own reasons.
  // Deriving it again is what made every match pay for the same string twice.
  const add = (m: PathMember, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  for (const m of space.members) {
    if (m.kind !== "tag") {
      // A hand picked member is never dropped by an exclusion. Removing one
      // removes the member.
      add(m, canonicalPath(m.path));
      continue;
    }
    for (const path of tags.pathsMatching(m.tag)) {
      const key = canonicalPath(path);
      if (excluded !== null && excluded.has(key)) continue;
      add({ kind: "file", path }, key);
    }
  }
  return out;
}
