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
import { pathMembers } from "../definitions/membership";
import { isVaultRoot } from "../visibility/folderSpace";
import type { MemberKind, SpaceDefinition } from "../types";

type MemberStatus =
  /** Resolves to a real vault object and is the reason it is in the space. */
  | "present"
  /** Nothing lives at this path. Kept, and recoverable. */
  | "missing"
  /** Real, but a member FOLDER already covers it, so the entry adds nothing. */
  | "redundant";

export interface MemberRow {
  path: string;
  kind: MemberKind;
  status: MemberStatus;
  /** The innermost member folder that covers it, when redundant. */
  coveredBy: string | null;
}

/**
 * One row per stored member, in definition order.
 *
 * Definition order rather than grouping by status, matching the switcher and
 * the header's dropdown: a list that re-sorted as entries were cleared would
 * move rows out from under the pointer mid-tidy.
 *
 * `exists` is injected so this stays pure; the caller passes a vault lookup.
 */
export function memberRows(
  space: SpaceDefinition,
  exists: (path: string) => boolean
): MemberRow[] {
  return pathMembers(space).map((m) => {
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

/**
 * How many rows resolve to nothing.
 *
 * `members.length` counts entries rather than members, and so overstates a
 * space that has lost files.
 */
export function missingCount(rows: readonly MemberRow[]): number {
  return rows.filter((r) => r.status === "missing").length;
}

/**
 * The one-line summary of a space's contents, shown on its settings row.
 *
 * The per-member rows live behind a modal, so this line is the only thing that
 * says the modal is worth opening: the attention count is the affordance.
 *
 * "Needs attention" is missing OR redundant, because those are exactly the two
 * states the file tree cannot show you: a missing entry has no row to look at,
 * and a redundant one is indistinguishable from a member doing work. Silence
 * when nothing is wrong is the point.
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
 * is injected rather than looked up so this stays testable in plain node.
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
  exists: (path: string) => boolean
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
  return `Curated · ${memberSummary(memberRows(space, exists))}`;
}
