import type { MemberEntry, PathMember, SpaceDefinition } from "../types";
import type { PropertyIndex } from "../visibility/PropertyIndex";
import type { TagIndex } from "../visibility/TagIndex";
import { canonicalPath } from "../visibility/glob";

/**
 * The member list the visibility engine is handed, with every tag member
 * expanded into the notes carrying that tag and every property member into
 * the notes whose frontmatter matches it.
 *
 * The engine never learns what a tag is. It receives file members, which it
 * already knows how to seed, so scaffolding, pruning, ignore precedence and
 * the reason vocabulary all apply with no change. This is the same trick
 * `membersForSnapshot` already plays for a folder space, which presents
 * itself as a space whose single member is its root.
 *
 * Exclusions are applied HERE for tag and property matches rather than left
 * to the engine. An expanded note arrives as a seed, and seeds bypass the
 * engine's ignore step by design, so an excluded match that reached the
 * engine would be visible. A hand-added member is a seed for the same reason and survives its
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
  tags: TagIndex,
  // `null` when no property snapshot is ready. A property member then
  // contributes nothing. That is "not known yet", not "matches nothing", so a
  // caller that publishes the result as a space's membership must keep its
  // previous result instead; this function cannot tell the two apart.
  properties: PropertyIndex | null
): PathMember[] {
  // Null rather than an empty Set. The usual space has no exclusions at all,
  // and a null test per matched path is cheaper than a hash lookup that can
  // never hit — and cheaper still than building the Set to make it.
  const stored = space.exclude;
  const excluded =
    stored === undefined || stored.length === 0 ? null : new Set(stored.map(canonicalPath));
  const out: PathMember[] = [];
  // The index is already in hand here, so the thunk the expansion wants costs
  // nothing. Whether to read it AT ALL for this space is `membersForSnapshot`'s
  // decision, one level up, and it must stay there: that is what keeps a space
  // with no property member from paying for a vault walk.
  expandMembers(space.members, tags, () => properties, excluded, (m) => out.push(m));
  return out;
}

/** The slice of a tag index the expansion needs. `TagIndex` satisfies it structurally. */
export interface MemberTags {
  pathsMatching(tag: string): readonly string[];
}

/**
 * THE member expansion: every member turned into the vault paths it names,
 * de-duplicated, in member order.
 *
 * `resolveMembers` and the create panel's preview both run THIS, rather than
 * a copy each. The preview had its own, whose chain ended
 * `if (m.kind === "file" || m.kind === "folder")` with no exhaustive tail, so
 * a fifth member kind would have contributed nothing to a preview silently —
 * at the one site a compile error was wanted most, since the preview is what
 * promises the user what the space will hold.
 *
 * `add` receives the member AND the folded key, which is already computed
 * here: deriving it again is what made every match pay for the same string
 * twice. It is called once per distinct path, never twice. The key is the
 * bare canonical path, not kind-plus-path, because by this point every entry
 * is a path member and only one vault object can occupy a given path, so the
 * path alone already identifies it uniquely.
 *
 * `excluded` is `null`, never an empty Set, for a space with no exclusions:
 * the usual space has none, and a null test per matched path is cheaper than
 * a hash lookup that can never hit — and cheaper still than building the Set
 * to make it.
 *
 * `properties` is a FUNCTION, asked at most once and only when a property
 * member is actually reached, so a selection with none never asks for an
 * index at all. `undefined` is the only "not asked yet": a `null` answer is
 * remembered too, or each further property member asks again.
 */
export function expandMembers(
  members: readonly MemberEntry[],
  tags: MemberTags,
  properties: () => PropertyIndex | null,
  excluded: ReadonlySet<string> | null,
  add: (member: PathMember, key: string) => void
): void {
  const seen = new Set<string>();
  const take = (m: PathMember, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    add(m, key);
  };
  let index: PropertyIndex | null | undefined;

  for (const m of members) {
    switch (m.kind) {
      case "file":
      case "folder":
        // A hand picked member is never dropped by an exclusion. Removing one
        // removes the member.
        take(m, canonicalPath(m.path));
        break;
      case "tag":
        for (const path of tags.pathsMatching(m.tag)) {
          const key = canonicalPath(path);
          if (excluded !== null && excluded.has(key)) continue;
          take({ kind: "file", path }, key);
        }
        break;
      case "property": {
        if (index === undefined) index = properties();
        if (index === null) break;
        const matched =
          m.value === undefined ? index.pathsWithKey(m.key) : index.pathsMatching(m.key, m.value);
        for (const path of matched) {
          const key = canonicalPath(path);
          if (excluded !== null && excluded.has(key)) continue;
          take({ kind: "file", path }, key);
        }
        break;
      }
      default: {
        // A member kind with no case above. Adding one to `MemberEntry` fails
        // HERE, at compile time, instead of silently contributing nothing —
        // for the preview as well as for the tree, now that both run this.
        const unreached: never = m;
        return unreached;
      }
    }
  }
}
