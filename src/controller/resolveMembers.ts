import type { MemberEntry, PathMember, SpaceDefinition } from "../types";
import type { PropertyIndex } from "../visibility/PropertyIndex";
import type { TagIndex } from "../visibility/TagIndex";
import { canonicalPath, type IgnoreMatcher } from "../visibility/glob";

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
 * Exclusions AND the global ignore are applied HERE for tag and property
 * matches rather than left to the engine. An expanded note arrives as a seed,
 * and seeds bypass the engine's ignore step by design, so a filtered match
 * that reached the engine would be visible. A hand-added member is a seed for
 * the same reason and survives both its own exclusion and the global ignore,
 * which is the intended precedence: the person pointed at that note, and a
 * rule must not overrule a finger.
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
 *
 * Issue #41 put one thing BACK on that tail: an `ignore.matches` per path a
 * rule member reaches. Measured on the same 3,785 match expansion, with each
 * variant run interleaved so machine drift hits all of them equally. Two
 * people measured it on different machines and got different absolute
 * numbers, which is why the DELTA is what is quoted and not the floor:
 *
 *  - an EMPTY `globalIgnore`, against no ignore test at all:  +5 to 10%
 *  - three patterns, against no ignore test at all:           about +0.9 ms
 *
 * An empty ignore is therefore CHEAP, not free: `matches()` is still a call
 * per path and still allocates the closure `[].some` takes, even with nothing
 * to compare against. An earlier version of this comment said it "pays
 * nothing measurable", which did not reproduce.
 *
 * The 0.9 ms at three patterns is about 240 ns per PATH — all three regex
 * tests together, not 240 ns per test. Measured again at the supported cap of
 * `MAX_PATTERNS`, the cost is linear in the pattern count and has no cliff:
 * about 15 ms for 100 patterns over the same 3,785 paths, once per recompute.
 *
 * There is no cheaper place to put the filter: doing it later, in
 * `includedPaths`, would mean carrying an origin on every seed — an object
 * allocation per matched path, which is strictly more than one regex test.
 */
export function resolveMembers(
  space: SpaceDefinition,
  tags: TagIndex,
  // `null` when no property snapshot is ready. A property member then
  // contributes nothing. That is "not known yet", not "matches nothing", so a
  // caller that publishes the result as a space's membership must keep its
  // previous result instead; this function cannot tell the two apart.
  properties: PropertyIndex | null,
  // The vault's global ignore, compiled. Required, and with no default,
  // because every answer this function gives depends on it: a caller that
  // could leave it out would get a space holding notes the tree does not
  // show. `compileIgnore([])` is the explicit "nothing is ignored".
  ignore: IgnoreMatcher
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
  expandMembers(space.members, tags, () => properties, excluded, ignore, (m) => out.push(m));
  return out;
}

/** The slice of a tag index the expansion needs. `TagIndex` satisfies it structurally. */
export interface MemberTags {
  pathsMatching(tag: string): readonly string[];
}

/**
 * How a member names the notes it brings in — the one thing that decides
 * whether a space's filters apply to what it brought.
 *
 * `"picked"`: the person pointed at this exact note or this exact folder.
 * Nothing the vault is configured to hide may overrule that; refusing the
 * note would be refusing the gesture that added it.
 *
 * `"rule"`: the member states a condition and the vault answers it. The
 * global ignore is a condition too, and the narrower of two conditions wins,
 * so a note the vault hides is not collected.
 */
export type MemberNaming = "picked" | "rule";

/**
 * Which side each member kind falls on.
 *
 * A `Record` keyed by `MemberEntry["kind"]`, and that is the whole point.
 * Adding a kind to `MemberEntry` leaves this object missing a key, which
 * `tsc` reports HERE — at the one line whose job is to decide — before the
 * new kind can reach a filter and inherit an answer nobody chose. A boolean
 * parameter, or a `kind === "tag" || kind === "property"` test, would both
 * have let it default silently into one side.
 *
 * It is `Record<..., MemberNaming>` and not `Partial<...>` or an index
 * signature for the same reason: only a total map is a compile error when it
 * stops being total.
 */
export const MEMBER_NAMING: Record<MemberEntry["kind"], MemberNaming> = {
  file: "picked",
  folder: "picked",
  tag: "rule",
  property: "rule",
};

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
 * ## Both filters live in `take`, under one flag
 *
 * `MEMBER_NAMING` answers, per member, whether its paths are filtered at all,
 * and `take` applies both filters under that answer. The per-kind cases live
 * in `expandOne` below, which is handed `take` and NOT the raw `add` sink, so
 * a later member kind cannot slip past either filter: there is no other sink
 * in its scope, and it cannot be written at all until `MEMBER_NAMING` has a
 * key for it. Both halves are compile errors, not conventions — see
 * `expandOne`'s own docblock for what went wrong when only one of them was.
 *
 * A filtered path is NOT marked seen, exactly as the per-case `continue` it
 * replaced did not. That is what makes the precedence order-free: a note that
 * a tag member reaches and the ignore hides, and that the same space also
 * names by hand, is taken for the hand-added member whichever of the two is
 * listed first.
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
  // The vault's global ignore, compiled. Consulted once per path a RULE
  // member reaches and never for a hand-picked one.
  ignore: IgnoreMatcher,
  add: (member: PathMember, key: string) => void
): void {
  const seen = new Set<string>();
  // The current member's side of `MEMBER_NAMING`, assigned at the top of the
  // loop below. Held here rather than passed to `take` so that no case can
  // pass the wrong one, and read rather than re-derived so the lookup is once
  // per MEMBER and not once per matched path.
  let naming: MemberNaming = "picked";
  const take = (m: PathMember, key: string): void => {
    if (seen.has(key)) return;
    if (naming === "rule") {
      if (excluded !== null && excluded.has(key)) return;
      // The LIVE path, not the folded key: `patternToRegExp` compiles with
      // `i` and folds its own side, and a stored spelling never reaches here
      // because only a rule member is tested and a rule member's paths come
      // straight out of the vault's own indexes.
      if (ignore.matches(m.path)) return;
    }
    seen.add(key);
    add(m, key);
  };
  // Asked at most once across every member, and only when a property member
  // is actually reached. `undefined` is the only "not asked yet"; a `null`
  // answer is remembered too, or each further property member asks again.
  let index: PropertyIndex | null | undefined;
  const propertyIndex = (): PropertyIndex | null => {
    if (index === undefined) index = properties();
    return index;
  };

  for (const m of members) {
    // Missing key here = compile error. See `MEMBER_NAMING`.
    naming = MEMBER_NAMING[m.kind];
    expandOne(m, take, tags, propertyIndex);
  }
}

/**
 * One member, turned into the paths it names.
 *
 * ## Why this is a separate function
 *
 * **So that `take` is the only way out, by construction rather than by
 * convention.** This used to be the body of the loop in `expandMembers`,
 * where `add` — the raw, unfiltered sink — was a parameter in scope. Nothing
 * stopped a future `case` from calling it directly and skipping the
 * de-duplication, the space's exclusions and the global ignore, and nothing
 * would have complained: a reviewer proved it by adding a member kind whose
 * case called `add`, and `tsc` reported no error at all. The docblock
 * claiming a later kind "has no other way to emit a path" was simply false.
 *
 * Here it is true. `add` is not in this scope, so the only sink reachable
 * from any case is `take`, and `take` applies both filters under the naming
 * its caller set. A new kind cannot opt out of filtering without changing
 * this function's signature, which is a conversation rather than an
 * oversight.
 *
 * Adding a kind to `MemberEntry` therefore fails twice at compile time: at
 * `MEMBER_NAMING`, which must say which side it falls on, and at the `never`
 * below, which must gain a case.
 */
function expandOne(
  m: MemberEntry,
  take: (member: PathMember, key: string) => void,
  tags: MemberTags,
  propertyIndex: () => PropertyIndex | null
): void {
  switch (m.kind) {
    case "file":
    case "folder":
      // A hand picked member is never dropped by an exclusion or by the
      // global ignore. Removing one removes the member.
      take(m, canonicalPath(m.path));
      return;
    case "tag":
      for (const path of tags.pathsMatching(m.tag)) {
        take({ kind: "file", path }, canonicalPath(path));
      }
      return;
    case "property": {
      const index = propertyIndex();
      if (index === null) return;
      const matched =
        m.value === undefined ? index.pathsWithKey(m.key) : index.pathsMatching(m.key, m.value);
      for (const path of matched) {
        take({ kind: "file", path }, canonicalPath(path));
      }
      return;
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
