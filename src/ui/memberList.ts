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
import type { MemberEntry, MemberKind, SpaceDefinition } from "../types";

type MemberStatus =
  /** Resolves to a real vault object and is the reason it is in the space. */
  | "present"
  /** Nothing lives at this path. Kept, and recoverable. */
  | "missing"
  /** Real, but a member FOLDER already covers it, so the entry adds nothing. */
  | "redundant"
  /** A tag no note currently carries. Not the same as a missing file. */
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

export type MemberRow = PathMemberRow | TagMemberRow;

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
 */
export function memberRows(
  space: SpaceDefinition,
  exists: (path: string) => boolean,
  matchCount?: (tag: string) => number
): MemberRow[] {
  return space.members.map((m): MemberRow => {
    if (m.kind === "tag") {
      const count = matchCount === undefined ? null : matchCount(m.tag);
      return {
        kind: "tag",
        tag: m.tag,
        status: count === 0 ? "matches-nothing" : "present",
        matchCount: count,
      };
    }
    // Missing wins over redundant. A file that is gone AND sat under a member
    // folder is still gone, and reporting it as merely redundant would hide
    // the only fact worth acting on.
    if (!exists(m.path)) {
      return { path: m.path, kind: m.kind, status: "missing" as const, coveredBy: null };
    }
    const coveredBy = inheritedFromFolder(space, m.path);
    return {
      path: m.path,
      kind: m.kind,
      status: coveredBy === null ? ("present" as const) : ("redundant" as const),
      coveredBy,
    };
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
  return members.filter((m) => m.kind === "tag" || m.path !== path);
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
