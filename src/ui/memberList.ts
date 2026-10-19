/**
 * The member list, pure — no DOM, no `"obsidian"` import.
 *
 * A deleted member's entry is no longer swept away — the sweep destroyed
 * membership on every external move — so entries outlive what they point at,
 * and the settings tab's bare count reported more members than a space could
 * show.
 *
 * `members` holds only EXACT members; inherited ones are computed and never
 * stored. Every row here is therefore a stored entry, and the question per row
 * is whether it still does anything.
 */

import { inheritedFromFolder } from "../actions/membershipMenu";
import { isVaultRoot } from "../visibility/folderSpace";
import type { TagIndex } from "../visibility/TagIndex";
import { resolveMembers } from "../controller/resolveMembers";
import type { PropertyIndex } from "../visibility/PropertyIndex";
import { memberIdentity } from "../definitions/schema";
import type { IgnoreMatcher } from "../visibility/glob";
import type { MemberEntry, MemberKind, PropertyMember, SpaceDefinition } from "../types";
import { valueLabel } from "./propertyRows";

/** A stored property member, as `memberRows` hands it to a counter. */
export type { PropertyMember };

type MemberStatus =
  /** Resolves to a real vault object and is the reason it is in the space. */
  | "present"
  /** Nothing lives at this path. Kept, and recoverable. */
  | "missing"
  /** Real, but a member FOLDER already covers it, so the entry adds nothing. */
  | "redundant"
  /** A tag or property no note currently matches. Not the same as a missing file. */
  | "matches-nothing";

/** A row for a member that names a vault path. */
export interface PathMemberRow {
  path: string;
  kind: MemberKind;
  status: Exclude<MemberStatus, "matches-nothing">;
  /** The innermost member folder that covers it, when redundant. */
  coveredBy: string | null;
}

/**
 * A row for a tag member. It carries no path, so it can never be `missing`:
 * a tag reaching no note has lost nothing and has nothing to recover.
 */
export interface TagMemberRow {
  kind: "tag";
  tag: string;
  status: "present" | "matches-nothing";
  /**
   * How many notes the tag brings in right now, or null when the caller did
   * not count.
   *
   * NULL IS NOT ZERO and must never be drawn as one. Counting means expanding
   * the tag over every note in the vault, and the settings tab cannot afford
   * that: Obsidian builds a declarative tab during `onload()`, so the count
   * cost a full vault metadata walk — 20.9 ms and 10,000 `getFileCache` calls
   * on the measured vault — inside the load Obsidian awaits, for a page
   * nobody had opened. The contents dialog, which the user opens
   * deliberately, still counts and still passes a counter.
   */
  matchCount: number | null;
}

/**
 * A row for a property member. It names no path, so like a tag row it can
 * never be `missing`.
 */
export interface PropertyMemberRow {
  kind: "property";
  key: string;
  /** Absent for the existence shape. In the spelling the user picked. */
  value?: string;
  /** What the row reads as: the key, or `key: value`. */
  label: string;
  status: "present" | "matches-nothing";
  /**
   * The distinct notes this member contributes to THIS space after the
   * space's exclusions AND after the global ignore, counted whether or not
   * another member also brings them in — the same two filters the tree
   * applies to a rule member (see `propertyMemberCount`). Scaffold folders
   * are never counted.
   *
   * NULL IS NOT ZERO and must never be drawn as one. It means the count is
   * unavailable: the caller did not count, or no property index has ever been
   * ready. A cold metadata cache must not read as "nothing matches", so a null
   * count is always `status: "present"`.
   */
  matchCount: number | null;
}

export type MemberRow = PathMemberRow | TagMemberRow | PropertyMemberRow;

/** A property member never reads the tag index, so the resolver gets an empty one. */
const NO_TAGS: TagIndex = { pathsMatching: () => [] };

/**
 * How many notes a property member contributes to a space.
 *
 * ASKS THE RESOLVER rather than restating its exclusion rule: the member is
 * resolved alone, by `resolveMembers`, against this space's exclusions, so
 * the count and the tree cannot decide the same question two ways. It counts
 * what THIS member brings, so a note a hand-named file member also holds still
 * counts, and a note this space excludes does not, even though the tree shows
 * it through that file member.
 *
 * FILTERED BY THE GLOBAL IGNORE, because the tree now filters one too. A
 * property member names a RULE, and `expandMembers` drops a rule's match that
 * the vault hides, so a count that kept it would promise a row the user
 * cannot see. The precedence this does NOT apply is the other half of the
 * same rule: a note the space also names by hand is shown, and is counted,
 * because `expandMembers` takes it for the hand-added member.
 *
 * This read "NOT FILTERED BY THE GLOBAL IGNORE, on purpose" until issue #41,
 * and warned that adding an ignore parameter to `resolveMembers` would make
 * the count silently disagree with the tree. That warning is why the
 * parameter is REQUIRED and has no default: there is no spelling of this call
 * that still compiles while skipping the filter, so the two cannot drift
 * apart again.
 *
 * Null when `index` is null, which is "unavailable", not zero.
 */
export function propertyMemberCount(
  member: PropertyMember,
  index: PropertyIndex | null,
  space: SpaceDefinition,
  ignore: IgnoreMatcher
): number | null {
  if (index === null) return null;
  return resolveMembers({ ...space, members: [member] }, NO_TAGS, index, ignore).length;
}

/**
 * How many notes a tag member contributes.
 *
 * The tag half of `propertyMemberCount`, and deliberately not the same
 * function. This one does NOT apply the space's exclusions, which is what the
 * dialog has always done for a tag row; only the global ignore is applied,
 * because that is what changed under issue #41 and a tag count that kept an
 * ignored note would name notes the tree does not draw.
 *
 * Pure and exported so the rule is testable in plain node, rather than living
 * in a closure inside the dialog where no test can reach it.
 */
export function tagMemberCount(tag: string, tags: TagIndex, ignore: IgnoreMatcher): number {
  let n = 0;
  for (const path of tags.pathsMatching(tag)) if (!ignore.matches(path)) n += 1;
  return n;
}

/**
 * One row per stored member, in definition order.
 *
 * Definition order rather than grouping by status, matching the switcher and
 * the header's dropdown: a list that re-sorted as entries were cleared would
 * move rows out from under the pointer mid-tidy.
 *
 * Every stored member gets exactly one row, tags included. A tag counts as ONE
 * entry rather than as the number of notes it reaches, the same way a folder
 * counts as one rather than as its contents: the row describes what the user
 * stored, and `matchCount` describes what that entry currently pulls in.
 *
 * `exists` and `matchCount` are both injected so this stays pure; the caller
 * passes a vault lookup and a tag lookup. `matchCount` is called once per tag
 * row, so a caller backing it with a built index must build that index once and
 * close over it rather than rebuilding it per call.
 *
 * `matchCount` is OPTIONAL, and omitting it means "I cannot afford to count",
 * not "the count is zero". A caller that omits it gets `matchCount: null` and
 * `status: "present"` — never `matches-nothing`, which would put a permanent
 * and false "needs attention" on every space holding a tag. The settings tab
 * omits it (see `TagMemberRow.matchCount`); the contents dialog supplies it.
 *
 * `propertyCount` is optional on the same terms and is called once per
 * property row. It returns null for "unavailable", and omitting it is the same
 * answer.
 *
 * The branches below narrow `m` in turn and the last one reads `m.path`, so
 * a fifth member kind fails to compile here, as it does in `membership.ts`.
 * Do not add a catch-all branch ahead of it.
 */
export function memberRows(
  space: SpaceDefinition,
  exists: (path: string) => boolean,
  matchCount?: (tag: string) => number,
  propertyCount?: (member: PropertyMember) => number | null
): MemberRow[] {
  return space.members.flatMap((m): MemberRow[] => {
    if (m.kind === "property") {
      const count = propertyCount === undefined ? null : propertyCount(m);
      return [
        {
          kind: "property",
          key: m.key,
          ...(m.value === undefined ? {} : { value: m.value }),
          // Through `valueLabel`, which is why that function exists: a member
          // stored with the empty string — the picker's "Empty string" row is
          // the one thing that can make one — drew `status: ` with nothing
          // after the colon, next to the existence member `status`, and the
          // same for a value that is only blanks. The picker already named
          // them; the row, the Remove tooltip and the failure notice all read
          // this label, so naming them once here covers all three.
          label: m.value === undefined ? m.key : `${m.key}: ${valueLabel(m.value)}`,
          status: count === 0 ? "matches-nothing" : "present",
          matchCount: count,
        },
      ];
    }
    if (m.kind === "tag") {
      const count = matchCount === undefined ? null : matchCount(m.tag);
      return [
        {
          kind: "tag",
          tag: m.tag,
          status: count === 0 ? "matches-nothing" : "present",
          matchCount: count,
        },
      ];
    }
    // Missing wins over redundant. A file that is gone AND sat under a member
    // folder is still gone, and reporting it as merely redundant would hide
    // the only fact worth acting on.
    if (!exists(m.path)) {
      return [{ path: m.path, kind: m.kind, status: "missing" as const, coveredBy: null }];
    }
    const coveredBy = inheritedFromFolder(space, m.path);
    return [
      {
        path: m.path,
        kind: m.kind,
        status: coveredBy === null ? ("present" as const) : ("redundant" as const),
        coveredBy,
      },
    ];
  });
}

/** A row for one of the paths a space leaves out. */
export interface ExclusionRow {
  path: string;
  /** `missing` when nothing lives at the path any more. */
  status: "present" | "missing";
}

/**
 * One row per stored exclusion, in stored order.
 *
 * An exclusion resolving to nothing was drawn exactly like a healthy one,
 * while a path MEMBER resolving to nothing has always been marked `missing`.
 * The two entries are equally dead and equally invisible from the file tree,
 * so they are worth the same word.
 *
 * `present` here means only that something lives at the path, not that the
 * exclusion is doing any work: a space can exclude a path no rule of its own
 * would have reached, and saying so would need the whole resolution rather
 * than a vault lookup.
 *
 * `exists` is injected for the same reason `memberRows` injects it: this
 * module stays pure, and the decision stays testable in plain node, where the
 * `Setting` controls that draw these rows cannot go.
 */
export function exclusionRows(
  space: SpaceDefinition,
  exists: (path: string) => boolean
): ExclusionRow[] {
  return (space.exclude ?? []).map((path) => ({
    path,
    status: exists(path) ? ("present" as const) : ("missing" as const),
  }));
}

/**
 * How many rows resolve to nothing.
 *
 * `members.length` counts entries rather than members, and so overstates a
 * space that has lost files.
 *
 * A tag row is never `missing`, so a space holding tags cannot inflate this.
 */
export function missingCount(rows: readonly MemberRow[]): number {
  return rows.filter((r) => r.status === "missing").length;
}

/**
 * The members that remain after removing the stored entry at `path`.
 *
 * Tag members carry no path and are never the target of a path-based
 * removal, so they always survive this untouched. Pulled out here rather
 * than left inline in the contents modal's Remove handler
 * (`SpaceContentsModal.ts`) so the decision is pure and testable in plain
 * node: `Setting`, which that handler is built from, is deliberately not
 * modelled under Vitest, so logic left inside it cannot be exercised at
 * this layer.
 */
export function withoutMember(members: readonly MemberEntry[], path: string): MemberEntry[] {
  return members.filter((m) => (m.kind !== "file" && m.kind !== "folder") || m.path !== path);
}

/**
 * The members that remain after removing the stored tag member `tag`.
 *
 * The counterpart to `withoutMember`, living here for exactly the same reason
 * and not inline in the contents modal: the removal is reached from a
 * `Setting` control, which the stub does not model, so a filter left there
 * could not be exercised at this layer at all.
 *
 * `tag` must already be normalized, matching the stored form. Path members
 * carry no tag and always survive, including one whose path happens to be
 * spelled like the tag.
 */
export function withoutTagMember(members: readonly MemberEntry[], tag: string): MemberEntry[] {
  return members.filter((m) => m.kind !== "tag" || m.tag !== tag);
}

/**
 * The members that remain after removing the stored property member whose
 * `memberIdentity` is `identity`.
 *
 * By identity rather than by spelling: `a: b` and a key literally named
 * `a=b` are different members. Only property members are compared, so a file,
 * folder or tag member always survives, whatever it is spelled like.
 */
export function withoutPropertyMember(
  members: readonly MemberEntry[],
  identity: string
): MemberEntry[] {
  return members.filter((m) => m.kind !== "property" || memberIdentity(m) !== identity);
}

/**
 * The one-line summary of a space's contents, shown on its settings row.
 *
 * The per-member rows live behind a modal, so this line is the only thing that
 * says the modal is worth opening: the attention count is the affordance.
 *
 * "Needs attention" is missing OR redundant OR a tag matching nothing, because
 * those are exactly the states the file tree cannot show you: a missing entry
 * has no row to look at, a redundant one is indistinguishable from a member
 * doing work, and a tag reaching no note still counts as a member while
 * contributing nothing. Silence when nothing is wrong is the point.
 */
export function memberSummary(rows: readonly MemberRow[]): string {
  if (rows.length === 0) return "No members";
  const total = `${rows.length} ${rows.length === 1 ? "member" : "members"}`;
  const attention = rows.filter((r) => r.status !== "present").length;
  if (attention === 0) return total;
  return `${total} · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
}

/**
 * A space's one-line description in Settings, for either kind.
 *
 * A folder space has no member count to show — that is the point of it — so it
 * names its root instead, and says plainly when that folder is gone. `exists`
 * and `matchCount` are injected rather than looked up so this stays testable in
 * plain node; a folder space consults neither. `matchCount` is optional here
 * for the same reason it is on `memberRows`, and is threaded straight through.
 *
 * `typeof root === "string"` is `hasRoot`'s own test, inlined, telling
 * `undefined` (curated) apart from ANY string (folder space). The vault-root
 * check must be `isVaultRoot`, not a literal `root !== ""`. Measured against
 * Obsidian 1.13.7: `getAbstractFileByPath('/')` returns the vault's own root
 * TFolder, so `exists("/")` reads as `true` and the row would print
 * `"Folder pinned · /"`, describing an unusable root as a healthy one; and
 * `getAbstractFileByPath('')` returns `null`, so an `exists("")` check would
 * call the pre-choice state "missing" — the one accusation settings must never
 * make against a root nobody has set yet. `isVaultRoot` rejects both spellings
 * the schema accepts (`""` and `"/"`, schema.ts) before either reaches
 * `exists`.
 *
 * `root: ""` is reachable in ordinary use, not just a hand-edited
 * `data.json`: the missing-root Notice's "Change folder…" picker offers a
 * Clear action that writes it explicitly through `setSpaceRoot`.
 */
export function spaceRowSummary(
  space: SpaceDefinition,
  exists: (path: string) => boolean,
  matchCount?: (tag: string) => number
): string {
  const root = space.root;
  if (typeof root === "string") {
    if (!isVaultRoot(root)) {
      return exists(root) ? `Folder pinned · ${root}` : `Folder pinned · ${root} (missing)`;
    }
    // The missing-root state, stored as "" (never chosen) or "/" (an explicit
    // vault-root spelling). It reads as unset rather than broken, and is NOT
    // the curated "No members" branch below: this space DECLARED a root, so it
    // must keep reading as a folder space (a bad root is stored, never
    // dropped), not collapse into an empty curated one.
    return "Folder pinned · no folder chosen yet";
  }
  // Reuse `memberSummary` rather than reimplementing a plainer count: that
  // would lose its singular/plural wording, its "No members" zero-case, and
  // its "needs attention" count (which also includes REDUNDANT members, not
  // only missing ones).
  return `Curated · ${memberSummary(memberRows(space, exists, matchCount))}`;
}
