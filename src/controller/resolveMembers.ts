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
 */
export function resolveMembers(
  space: SpaceDefinition,
  tags: TagIndex
): PathMember[] {
  const excluded = new Set((space.exclude ?? []).map(canonicalPath));
  const out: PathMember[] = [];
  // Namespaced nothing here: every entry is a path member by this point.
  const seen = new Set<string>();

  const add = (m: PathMember): void => {
    const key = canonicalPath(m.path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  for (const m of space.members) {
    if (m.kind !== "tag") {
      // A hand picked member is never dropped by an exclusion. Removing one
      // removes the member.
      add(m);
      continue;
    }
    for (const path of tags.pathsMatching(m.tag)) {
      if (excluded.has(canonicalPath(path))) continue;
      add({ kind: "file", path });
    }
  }
  return out;
}
