import { Modal, Notice, Setting, type App } from "obsidian";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { SpaceDefinition, SpacesDefinitions, OrderMap } from "../types";
import type { RestoreProblem } from "./restoreCheck";
import { hasRoot, isVaultRoot, rootOf } from "../visibility/folderSpace";
import { isSafeVaultPath } from "../definitions/schema";
import { repairExclude } from "../lifecycle/pathRepair";
import { insertAt } from "../order/orderModel";
import { FolderSuggest } from "./FolderSuggest";
import type { AnchoredPopover } from "./AnchoredPopover";
import { openFolderPickerPopover } from "./FolderPickerPopover";
import type { VaultSource } from "./createSpaceForm";

/**
 * The gate in front of a restore that cannot be clean.
 *
 * Archiving keeps a space whole, including paths the vault has moved on from
 * while it sat put. Restoring it blind puts a space back with rows that lead
 * nowhere, in a tree where nothing says why. So what no longer resolves is
 * named BEFORE the space comes back, with the three answers that exist for
 * it: point it somewhere, take it out, or leave it.
 *
 * Three rules hold this together, and each is a decision rather than an
 * implementation detail:
 *
 *  - **One mutation, not two.** `applyRestoreFixes` clears `archived` itself,
 *    so the fixes and the flag land in a single `mutate`. Calling
 *    `restoreSpace` and then writing the fixes would leave a window in which
 *    the space is back on the strip with its paths still broken.
 *    `restoreSpace` keeps the clean path, where there is nothing to stage.
 *  - **Staged, not live.** `RestoreGate` holds the decisions and writes
 *    nothing until Restore. Cancel writes nothing at all.
 *  - **A root is never removed.** See `actionsFor`.
 */

/** One line in the gate: a member that no longer resolves, or the root. */
export interface RestoreRow {
  kind: "member" | "root";
  path: string;
  /** What is expected at `path`. Always `"folder"` for a root. */
  memberKind: "file" | "folder";
}

/** What a row can be answered with. `"leave"` is the default: no fix at all. */
export type RestoreAction = "point" | "remove" | "leave";

/**
 * One staged decision, resolved to what it does to the document. A `"leave"`
 * produces no fix, which is what makes leaving cost nothing.
 */
export type StagedFix =
  | { kind: "point-member"; from: string; to: string }
  | { kind: "remove-member"; path: string }
  // `from` is carried for a root exactly as it is for a member, so the commit
  // can tell whether the root the user answered about is still the root. See
  // `applyRestoreFixes`.
  | { kind: "point-root"; from: string; to: string };

/* ------------------------------------------------------------------ *
 * What the gate shows
 * ------------------------------------------------------------------ */

/**
 * The paths this gate is accountable for: the one root, or the distinct
 * member paths.
 *
 * **A space that declares a root is checked on its root alone.**
 * `SpaceController.membersForSnapshot` answers `[{ path: root }]` for a space
 * whose root resolves to a path, and `[]` for the two no-folder-chosen
 * spellings, so a folder space's member list is never what the TREE draws: a
 * missing member of one is true, and invisible in the thing a restore puts
 * back. Counting it would make the lede describe notes the restored space
 * will not show.
 *
 * The member list itself is not hidden — `memberRows` lists it for the
 * settings row's summary and for the Contents dialog — and that is the
 * argument for leaving it alone here rather than the argument against: the
 * place to remove a member is where members are listed and managed, not a
 * dialog about what the tree will draw. Removing one HERE would discard
 * curation that matters again the moment the root is cleared.
 *
 * Distinct, because the same path can be stored twice — see `restoreRows`.
 * Tag and property members name no path and are not checked at all, matching
 * `restoreProblems`.
 */
export function checkedPaths(space: SpaceDefinition): string[] {
  if (hasRoot(space)) {
    const root = rootOf(space);
    // `""` and `"/"` are the no-folder-chosen state, which is not a fault to
    // answer for: `MissingRootNotice` already names it and repairs it.
    return root === null ? [] : [root];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of space.members) {
    if (m.kind !== "file" && m.kind !== "folder") continue;
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    out.push(m.path);
  }
  return out;
}

/**
 * The rows to show, from what `restoreProblems` reported.
 *
 * Two things are decided here, because `restoreProblems` deliberately decides
 * neither:
 *
 *  - **One row per path.** A duplicate member, or a file member and a folder
 *    member sharing a path, would yield the same path twice. The loader's own
 *    key is `"p:" + path`, not namespaced by kind, so `validateMembers` drops
 *    the second one, on load and on every write, and no document that reaches
 *    here can hold one path twice. This de-duplication is therefore defence
 *    against a state nothing today produces, kept because two identical rows
 *    would let one path be given two contradictory answers. The first report
 *    wins, which keeps stored order.
 *  - **A folder space shows its root only.** See `checkedPaths`. A member of
 *    such a space is dropped from the display AND left untouched by whatever
 *    is staged, so nothing is decided here about something the restored tree
 *    will not draw. It stays listed where members are listed.
 *
 * Members come before the root in `restoreProblems`' output and the two never
 * appear together here, so the result needs no sorting.
 */
export function restoreRows(
  space: SpaceDefinition,
  problems: readonly RestoreProblem[]
): RestoreRow[] {
  const folderSpace = hasRoot(space);
  const rows: RestoreRow[] = [];
  const seen = new Set<string>();
  for (const p of problems) {
    if (p.kind === "root") {
      rows.push({ kind: "root", path: p.path, memberKind: "folder" });
      continue;
    }
    if (folderSpace) continue;
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    rows.push({ kind: "member", path: p.path, memberKind: p.memberKind });
  }
  return rows;
}

/**
 * **A root has no "remove".** There is nothing to remove it from: a folder
 * space without its folder is still a folder space, and leaving it restores
 * the space into the missing-root state `MissingRootNotice` already announces
 * and can repair. Declining to decide therefore costs nothing, which is why
 * leaving is offered rather than the restore being blocked.
 */
export function actionsFor(row: RestoreRow): RestoreAction[] {
  return row.kind === "root" ? ["point", "leave"] : ["point", "remove", "leave"];
}

/** Where the candidate path came from, which changes one refusal's wording. */
export type PointSource = "typed" | "folder-pick";

/**
 * Why `to` cannot be pointed at, or null when it can.
 *
 * A path that does not resolve, or resolves to the other kind, would carry
 * the problem into the restored space, which is the one thing this gate
 * exists to prevent. Each message says what to do rather than what went
 * wrong.
 *
 * Two refusals are about what the document can HOLD rather than about the
 * vault, and both would otherwise be felt somewhere worse:
 *
 *  - The vault root answers a root row with the missing-root state all over
 *    again, which is what the gate was opened to settle.
 *  - A path `isSafeVaultPath` rejects lands differently depending on the row,
 *    and the quiet half is the worse one. On a MEMBER row it fails
 *    `validateMembers`, so the whole `mutate` is rejected as an "invalid
 *    mutation", with nothing restored and a schema error in a notice. On a
 *    ROOT row `validateSpace` drops `root` as a single field, the write
 *    SUCCEEDS, and the folder space silently becomes a curated one rendering
 *    its stored member list. Refusing it here costs one message instead of
 *    either.
 *
 * `taken` is what this space would already hold: its own member paths, plus
 * the destinations the other rows are staged to point at. The loader's
 * `"p:" + path` key collapses two members naming one path into one, so
 * pointing a row at a path already held does not point it, it deletes it, and
 * this is the only place that can say so before the write.
 */
export function pointProblem(
  row: RestoreRow,
  to: string,
  kindOf: (path: string) => "file" | "folder" | null,
  source: PointSource = "typed",
  taken: ReadonlySet<string> = new Set()
): string | null {
  const path = to.trim();
  if (path === "") return "Type a path first.";
  if (path === row.path) return "That is the path that is missing. Pick a different one.";
  if (isVaultRoot(path)) {
    return row.kind === "root"
      ? "A space cannot show the whole vault. Pick a folder inside it."
      : "The vault root is not a note or a folder a space can hold. Pick one inside it.";
  }
  if (!isSafeVaultPath(path)) {
    // Every cause, not just the first one: this refusal also catches a
    // backslash, a drive letter, a `.` or `..` segment and the 1000-character
    // cap, and naming only the leading slash gave the wrong instruction to
    // anyone who typed `Notes\a.md` or `../a.md`. The cap is named here
    // because it was the one cause the list left out, and a path over it got
    // a message whose every clause was about something else.
    return (
      "Not a vault path. Give a path inside the vault, 1000 characters or " +
      "fewer, with forward slashes, no leading slash, no drive letter, and " +
      "no . or .. steps."
    );
  }
  if (taken.has(path)) {
    return "That is already in this space. Pick a different path, or Remove from space.";
  }
  const kind = kindOf(path);
  if (kind === null) {
    // The folder came from the picker, so it is there; only the name at the
    // end is in doubt, and saying so is the difference between "check the
    // spelling" of a path the user did not type and the one word that is
    // actually theirs to correct.
    return source === "folder-pick"
      ? "Nothing by that name in that folder. Edit the name, or choose another folder."
      : "No note or folder at that path. Check the spelling.";
  }
  if (kind !== row.memberKind) {
    return kind === "folder" ? "That is a folder. Pick a note." : "That is a note. Pick a folder.";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Copy
 * ------------------------------------------------------------------ */

/** The modal's title. */
export function restoreTitle(space: SpaceDefinition): string {
  return `Restore ${space.name}`;
}

/**
 * How much of the space is intact, and that nothing has been written.
 *
 * Agreement follows the NOUN rather than the leading count, so every
 * combination reads: "0 of 7 notes and folders are", "1 of 1 note or folder
 * is". The count that is FINE leads, because it is the reassuring one and the
 * gate is not a refusal.
 */
export function restoreLede(ok: number, bad: number, rootOnly = false): string {
  // A folder space's root is the only row there is when it is a row at all
  // (see `restoreRows`), and "0 of 1 note or folder is still there" describes
  // it as a member list the space does not have.
  if (rootOnly) return "The folder this space is pinned to is missing. Nothing has changed yet.";
  const total = ok + bad;
  const subject = total === 1 ? "note or folder is" : "notes and folders are";
  const not = bad === 1 ? "is" : "are";
  return `${ok} of ${total} ${subject} still there. ${bad} ${not} not, and nothing has changed yet.`;
}

/** What is wrong with one row, in the words of what is expected there. */
export function rowProblem(row: RestoreRow): string {
  // A root row is not a member that went missing; it is the folder the whole
  // space is pinned to, and "No folder at this path" never says so.
  if (row.kind === "root") return "The folder this space is pinned to is missing";
  return row.memberKind === "folder" ? "No folder at this path" : "No note at this path";
}

/**
 * What a staged decision reads as, so the row says what will happen rather
 * than what is wrong once it has been answered.
 */
export function stagedText(row: RestoreRow, fix: StagedFix | undefined): string {
  if (!fix) return rowProblem(row);
  if (fix.kind === "remove-member") return "Taking it out of the space";
  return `Pointing at ${fix.to}`;
}

/**
 * The reassurance under the rows. Leaving a path alone is a real answer: a
 * dangling member resolves to `hidden-nonmember` and the row returns the
 * moment the note does.
 */
export function restoreFooter(rows: readonly RestoreRow[]): string {
  if (rows.length === 1) {
    const noun = rows[0].memberKind === "folder" ? "folder" : "note";
    return `Leaving it is safe. It comes back if the ${noun} does.`;
  }
  return "Leaving them is safe. They come back if the notes and folders do.";
}

/* ------------------------------------------------------------------ *
 * What it writes
 * ------------------------------------------------------------------ */

/** "" for a root-level path, matching the order map's root key. */
function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Carry a re-pointed path's ORDER POSITION to its new parent's list.
 *
 * **This departs from `repairOrderMap` (lifecycle/pathRepair.ts) on purpose.**
 * That one drops the entry when the parent folder changes, because an
 * external move's intent is unknown and synthesising a position would be
 * inventing it. Here the user has just said, explicitly, that this note is
 * that member. Following the precedent would drop the re-pointed note to the
 * bottom of the restored space, which the design names as an anti-goal.
 *
 * Nothing else in the map is rewritten: a re-pointed member FOLDER leaves the
 * order lists of its old descendants where they are, while
 * `followExclusions` below carries the exclusions under that same folder.
 *
 * **The two do not agree, and the reason is the cost of being wrong, not a
 * claim about what the user meant.** A stale order puts a row in the wrong
 * place, which is visible and corrected by dragging it; a stale exclusion
 * silently returns a note the user took out, and excludes whatever later
 * occupies the old path. In the case this gate mostly exists for — a folder
 * moved outside Obsidian while the space sat archived — the contents moved
 * with it and kept their names, which is where carrying the keys would be
 * right. `repairOrderMap` (lifecycle/pathRepair.ts) already has the
 * key-and-entry rewrite that would do it. That is a change to make
 * deliberately, with that case in front of it, rather than a line slipped
 * into this one.
 */
function repointInOrder(map: OrderMap, from: string, to: string): void {
  let at = -1;
  for (const [key, list] of Object.entries(map)) {
    const i = list.indexOf(from);
    if (i === -1) continue;
    if (at === -1) at = i;
    const kept = list.filter((p) => p !== from);
    if (kept.length > 0) map[key] = kept;
    else delete map[key];
  }
  // Unlisted before, unlisted after: a member with no saved position has
  // nothing to carry, and giving it one here would be the invention above.
  if (at === -1) return;
  const key = dirnameOf(to);
  map[key] = insertAt(map[key] ?? [], to, at);
}

/**
 * Drop a removed member's order entry, as `deleteSpace` drops a deleted
 * space's whole map, and for the same reason: nothing else would ever clear
 * it. Keys UNDER the path are left alone, matching how orders survive a
 * delete elsewhere.
 */
function dropFromOrder(map: OrderMap, path: string): void {
  for (const [key, list] of Object.entries(map)) {
    if (!list.includes(path)) continue;
    const kept = list.filter((p) => p !== path);
    if (kept.length > 0) map[key] = kept;
    else delete map[key];
  }
}

/**
 * A space's exclusions, followed through a re-point.
 *
 * `exclude` holds LITERAL vault paths that `archiveSpace` preserves, so
 * without this, re-pointing `Old/Dir` at `New/Dir` leaves `Old/Dir/skip.md`
 * naming nothing: the notes the user deliberately left out of the space come
 * back with the restore, silently, and whatever later occupies the old path
 * is excluded in their place. `repairExclude` is the rule a rename already
 * uses for this (`lifecycle/pathRepair.ts`, where the same failure is
 * documented), and a re-point is the same statement about the paths under a
 * folder — made deliberately rather than inferred from a move.
 *
 * Assigned or deleted, never spread: `repairExclude` returns `undefined` for
 * a space that now excludes nothing, and leaving the key in place would keep
 * the stale list.
 */
function followExclusions(space: SpaceDefinition, from: string, to: string): void {
  const next = repairExclude(space.exclude, from, to);
  if (next) space.exclude = next;
  else delete space.exclude;
}

/** What a commit did beyond applying every fix it was handed. */
export interface RestoreOutcome {
  /** The space was no longer in the document when the write ran. */
  missing: boolean;
  /**
   * Fixes whose source path named nothing in the live document, in the order
   * they were staged. Skipped rather than applied: see `applyRestoreFixes`.
   */
  skipped: StagedFix[];
}

/** The path a fix was staged AGAINST, which is what the live draft is re-checked for. */
function sourceOf(fix: StagedFix): string {
  return fix.kind === "remove-member" ? fix.path : fix.from;
}

/**
 * The fixes in the order they must be APPLIED: longest source path first.
 *
 * `followExclusions` rewrites every exclusion under a re-pointed path, so
 * nested folder fixes are order-dependent. Applied in row order, an outer
 * `Old/Dir -> N1` fix rewrites the exclusions under `Old/Dir/Sub` before the
 * fix for `Old/Dir/Sub -> N2` can claim them, and they end up under the
 * destination of the outer fix: a note the user deliberately left out comes
 * back when `N2` is drawn, and whatever later occupies the path under `N1` is
 * excluded in its place. Longest first means the inner fix rewrites its own
 * exclusions before the outer fix sees them, and the outer fix then finds
 * only what is still its own.
 *
 * Members are unaffected by the order: both point and remove match a member's
 * path exactly, and the gate stages at most one fix per path, so no two fixes
 * can name the same member.
 */
function inApplyOrder(fixes: readonly StagedFix[]): StagedFix[] {
  return [...fixes].sort((a, b) => sourceOf(b).length - sourceOf(a).length);
}

/**
 * Apply the staged fixes to a mutation DRAFT and clear the archived flag, in
 * place.
 *
 * **Every fix is re-checked against this draft before it is applied, and one
 * that matches nothing is skipped and reported.** The gate's rows are built
 * from the `SpaceDefinition` the settings page was rendered from, and that
 * object goes stale: `SettingsTab.spaceSignature` covers id, name and the
 * archived flag, so a member path change does not redraw the page, and
 * `repairOnRename` repairs archived spaces on purpose, so their member paths
 * DO move behind an open gate. A decision made against a path that has since
 * moved is a decision about something else, and applying it by path would act
 * on whatever now sits there. The loss that shape produces is pinned in
 * `tests/restoreModal.test.ts` ("skips a staged removal when the path it was
 * about has gone"): a space holding a gated `Old/f.md` and a live `Temp/f.md`
 * has them collapsed into one live member by a rename of `Temp` to `Old`, and
 * the staged Remove then deleted the survivor. `data.json` is the only copy
 * of a user's curation, so the skip is the conservative half of the trade and
 * the Notice is what keeps it from being silent.
 *
 * **Cost, measured, for whoever adds a "Fix all" button.** This is
 * O(fixes x exclusions) + O(fixes x order entries): `followExclusions` walks
 * the whole `exclude` list per fix and `repointInOrder` walks every order key
 * and list per fix, all synchronously inside `defs.mutate` before the write.
 * Measured in the fleet review at 1d87e00, not here, against 1000
 * exclusions and an order map: 20 fixes 14.1 ms, 100 fixes
 * 156.0 ms, 500 fixes 930.0 ms, 1000 fixes 3122.1 ms. With no exclusions and
 * no order map, 500 fixes is 7.7 ms, so the exclusion walk is the term that
 * matters. Nobody reaches it by hand today, because every staged fix costs a
 * click and the one-click default stages none; the numbers are here so that
 * a bulk action is costed before it ships rather than after. The pre-flight
 * check is linear and free by comparison: `restoreProblems` + `restoreRows`
 * + `checkedPaths` over 500 missing members is 1.4 ms.
 *
 * A ROOT fix is re-checked the same way, against `space.root` rather than
 * against the member list. That also refuses to CREATE a root on a space
 * whose root a sync cleared while the gate was open, which would have turned
 * a curated space into a folder space showing one folder and none of the
 * curation.
 *
 * The flag goes last and unconditionally: a gate answered with nothing but
 * "leave" is still a restore, and so is a gate every one of whose fixes was
 * skipped. The flag is DELETED rather than set to false, exactly as
 * `restoreSpace` does, so the restored space carries no record of having been
 * archived.
 *
 * **A removed member's exclusions are left alone, deliberately.** `exclude`
 * leaves a path out "whatever pulled it in" (types.ts) and is not owned by
 * the member it sits under: a note under the removed folder can still be
 * reached by a tag or property member of the same space, and dropping the
 * exclusion would put it back on screen as a side effect of removing
 * something else. The paths do not resolve anyway — that is why this gate is
 * open — so a kept entry excludes nothing, stays visible in the Contents
 * dialog's "Left out" list, and is one click to clear there. This follows
 * `pathRepair`'s standing position that the dangerous direction is dropping
 * membership data when a path disappears, not keeping it.
 */
export function applyRestoreFixes(
  draft: SpacesDefinitions,
  spaceId: string,
  fixes: readonly StagedFix[]
): RestoreOutcome {
  const space = draft.spaces.find((s) => s.id === spaceId);
  // Deleted on another device while the gate was open. Nothing to restore and
  // nothing to apply the decisions to, which the caller reports rather than
  // closing the modal as though the restore had happened.
  if (!space) return { missing: true, skipped: [...fixes] };
  const order = draft.orders?.bySpaceId?.[spaceId];
  const skipped: StagedFix[] = [];
  for (const fix of inApplyOrder(fixes)) {
    if (fix.kind === "point-root") {
      // Read off the live draft, not off the staged fix: the root the user
      // was shown must still be the root.
      if (space.root !== fix.from) {
        skipped.push(fix);
        continue;
      }
      // The root's exclusions sit under it exactly as a member folder's do.
      // Its ORDER keys are a different question, and left alone: see
      // `repointInOrder`. A stale order puts a row in the wrong place, which
      // is visible and self-correcting; a stale exclusion silently returns a
      // note the user took out.
      followExclusions(space, fix.from, fix.to);
      space.root = fix.to;
      continue;
    }
    if (fix.kind === "point-member") {
      let hit = false;
      for (const m of space.members) {
        if ((m.kind === "file" || m.kind === "folder") && m.path === fix.from) {
          m.path = fix.to;
          hit = true;
        }
      }
      if (!hit) {
        skipped.push(fix);
        continue;
      }
      followExclusions(space, fix.from, fix.to);
      if (order) repointInOrder(order, fix.from, fix.to);
      continue;
    }
    const before = space.members.length;
    space.members = space.members.filter(
      (m) => !((m.kind === "file" || m.kind === "folder") && m.path === fix.path)
    );
    if (space.members.length === before) {
      skipped.push(fix);
      continue;
    }
    if (order) dropFromOrder(order, fix.path);
  }
  delete space.archived;
  // Reported in the order the user staged them, not the order they were
  // applied in, because the rows are what they will go back and look at.
  skipped.sort((a, b) => fixes.indexOf(a) - fixes.indexOf(b));
  return { missing: false, skipped };
}

/** The fixes and the flag clear, in ONE write. See this file's docstring. */
export async function commitRestore(
  defs: DefinitionStore,
  spaceId: string,
  fixes: readonly StagedFix[]
): Promise<RestoreOutcome> {
  let outcome: RestoreOutcome = { missing: true, skipped: [...fixes] };
  await defs.mutate((d) => {
    outcome = applyRestoreFixes(d, spaceId, fixes);
  });
  return outcome;
}

/**
 * What to say about a commit that did not do everything it was asked.
 *
 * Null for the ordinary case, so the clean restore stays silent. Instructions
 * rather than an account of the race: the paths that were left alone are
 * named, and the next move is to go and look at the space.
 */
export function restoreReport(spaceName: string, outcome: RestoreOutcome): string | null {
  if (outcome.missing) {
    return `Spaces: "${spaceName}" was deleted somewhere else, so there was nothing to restore.`;
  }
  if (outcome.skipped.length === 0) return null;
  const paths = outcome.skipped.map(sourceOf);
  const named = paths
    .slice(0, 3)
    .map((p) => `"${p}"`)
    .join(", ");
  const more = paths.length > 3 ? `, and ${paths.length - 3} more` : "";
  if (paths.length === 1) {
    return (
      `Spaces: restored "${spaceName}" without one of your changes. ${named} changed ` +
      `while the window was open. Check the space and set it again.`
    );
  }
  return (
    `Spaces: restored "${spaceName}" without ${paths.length} of your changes. ` +
    `${named}${more} changed while the window was open. Check the space and set them again.`
  );
}

/* ------------------------------------------------------------------ *
 * Staging
 * ------------------------------------------------------------------ */

/** The side of the gate that touches Obsidian, kept behind an interface. */
export interface RestoreGateIo {
  apply(fixes: readonly StagedFix[]): Promise<RestoreOutcome>;
  close(): void;
  onError(message: string): void;
  /**
   * A write that landed but did not do everything the gate was asked for.
   * Separate from `onError` because the space IS restored: this reports what
   * was left alone, not a failure. See `restoreReport`.
   */
  onReport(outcome: RestoreOutcome): void;
}

/**
 * The decisions, held until Restore.
 *
 * Nothing here writes: `point`, `remove` and `leave` only move an entry in
 * and out of a map keyed by row index, so Cancel is the absence of a call
 * rather than an undo. The modal owns the DOM and delegates every decision to
 * this, which is what makes the rules above testable without a modal.
 */
export class RestoreGate {
  private readonly staged = new Map<number, StagedFix>();
  /**
   * Set for the length of one write, so a second Restore click cannot start a
   * second one. Without the guard it would: `restore()` is async and the
   * button stays live while the write is in flight.
   */
  private running = false;

  constructor(
    readonly rows: readonly RestoreRow[],
    private readonly io: RestoreGateIo
  ) {}

  /** Stage "this is that now". The caller validates with `pointProblem` first. */
  point(index: number, to: string): void {
    const row = this.rows[index];
    if (!row) return;
    this.staged.set(
      index,
      row.kind === "root"
        ? { kind: "point-root", from: row.path, to }
        : { kind: "point-member", from: row.path, to }
    );
  }

  /** Stage a removal. Never offered for a root — see `actionsFor`. */
  remove(index: number): void {
    const row = this.rows[index];
    if (!row || row.kind === "root") return;
    this.staged.set(index, { kind: "remove-member", path: row.path });
  }

  /** Back to the default: no fix for this row. */
  leave(index: number): void {
    this.staged.delete(index);
  }

  stagedAt(index: number): StagedFix | undefined {
    return this.staged.get(index);
  }

  /** In row order, so the write is in the order the user read. */
  fixes(): StagedFix[] {
    return this.rows.map((_, i) => this.staged.get(i)).filter((f): f is StagedFix => f !== undefined);
  }

  /**
   * Write, then close. A failed write keeps the modal open with every
   * decision intact: the alternative is closing on a write that did not land
   * and losing work the user cannot see was lost.
   */
  async restore(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    let outcome: RestoreOutcome;
    try {
      outcome = await this.io.apply(this.fixes());
    } catch (e) {
      this.io.onError(String(e));
      return false;
    } finally {
      this.running = false;
    }
    // Before the close, so the report is issued whatever the host does with
    // the modal afterwards.
    this.io.onReport(outcome);
    this.io.close();
    return true;
  }

  /** Writes nothing at all. Still archived, nothing re-pointed, nothing removed. */
  cancel(): void {
    this.io.close();
  }
}

/* ------------------------------------------------------------------ *
 * The modal
 * ------------------------------------------------------------------ */

export interface RestoreSpaceModalDeps {
  space: SpaceDefinition;
  /** What `restoreRows` returned. Never empty: a clean restore skips this. */
  rows: readonly RestoreRow[];
  /** Vault paths and their kinds, for the suggester and the kind check. */
  source: VaultSource;
  apply(fixes: readonly StagedFix[]): Promise<RestoreOutcome>;
  /** Re-render the settings tab. Only after a restore that happened. */
  onRestored(): void;
}

/** The note name at the end of a path, so a chosen folder can keep it. */
function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * The part that needs a real Obsidian modal, and nothing else. Every decision
 * it offers is `RestoreGate`'s or one of the pure functions above, which is
 * what `ConfirmModal` does with `settingsEdits.ts` and for the same reason:
 * `Modal` presentation cannot be driven under Vitest.
 */
export class RestoreSpaceModal extends Modal {
  private readonly gate: RestoreGate;
  private readonly suggests: FolderSuggest[] = [];
  /**
   * The folder picker, held rather than discarded.
   *
   * `openFolderPickerPopover` returns it so its opener can close it:
   * `AnchoredPopover` does not own its own lifetime, and its four document
   * and window listeners come off only on `close()`. Its dismissal rules
   * close it for every ordinary gesture, so the gap is an unload with the
   * picker open, which is what `MissingRootNotice` keeps its own reference
   * for.
   */
  private picker: AnchoredPopover | null = null;

  constructor(
    app: App,
    private readonly deps: RestoreSpaceModalDeps
  ) {
    super(app);
    this.gate = new RestoreGate(deps.rows, {
      apply: (fixes) => deps.apply(fixes),
      close: () => this.close(),
      onError: (message) => {
        new Notice(`Spaces: could not restore "${deps.space.name}" (${message})`);
      },
      onReport: (outcome) => {
        const message = restoreReport(deps.space.name, outcome);
        if (message !== null) new Notice(message);
      },
    });
  }

  override onOpen(): void {
    const { space, rows } = this.deps;
    this.titleEl.setText(restoreTitle(space));
    const ok = checkedPaths(space).length - rows.length;
    const rootOnly = rows.length === 1 && rows[0].kind === "root";
    this.contentEl.createEl("p", { text: restoreLede(ok, rows.length, rootOnly) });

    rows.forEach((row, i) => this.renderRow(row, i));

    this.contentEl.createEl("p", { text: restoreFooter(rows) });

    let cancelEl: HTMLElement | null = null;
    new Setting(this.contentEl)
      .addButton((b) => {
        cancelEl = b.buttonEl;
        return b.setButtonText("Cancel").onClick(() => {
          this.gate.cancel();
        });
      })
      .addButton((b) =>
        b
          .setButtonText("Restore")
          .setCta()
          .onClick(() => {
            void this.gate.restore().then((done) => {
              if (done) this.deps.onRestored();
            });
          })
      );
    // Cancel takes the focus, matching `ConfirmModal`: the reflexive Enter
    // that dismisses a modal must not be the thing that commits a restore.
    (cancelEl as HTMLElement | null)?.focus();
  }

  private renderRow(row: RestoreRow, index: number): void {
    const setting = new Setting(this.contentEl).setName(row.path).setDesc(rowProblem(row));
    const say = (): void => {
      setting.setDesc(stagedText(row, this.gate.stagedAt(index)));
    };

    let input: HTMLInputElement | null = null;
    const stage = (to: string, source: PointSource = "typed"): void => {
      const problem = pointProblem(
        row,
        to,
        (p) => this.deps.source.kindOf(p),
        source,
        this.takenPaths(index)
      );
      if (problem !== null) {
        if (input) input.value = to;
        new Notice(`Spaces: ${problem}`);
        return;
      }
      this.gate.point(index, to.trim());
      say();
    };

    setting.addText((t) => {
      input = t.inputEl;
      t.setPlaceholder(row.memberKind === "folder" ? "Point at a folder" : "Point at a note");
      t.setValue(row.path);
      if (row.memberKind !== "folder") return;
      // Folders have a suggester already; there is no file equivalent in this
      // codebase and inventing one is not this task's business. A note is
      // pointed by typing its path, or by choosing the folder it now sits in
      // (below), which keeps its name.
      try {
        this.suggests.push(
          new FolderSuggest(
            this.app,
            t.inputEl,
            this.deps.source,
            // `selectSuggestion` clears the input after this runs, so the pick
            // is staged rather than written back into the field.
            (path) => stage(path),
            (e) => console.error("Spaces: folder suggester failed in the restore gate", e)
          )
        );
      } catch (e) {
        console.error("Spaces: folder suggester failed in the restore gate", e);
      }
    });

    setting.addButton((b) =>
      b.setButtonText("Point here").onClick(() => {
        stage(input?.value ?? "");
      })
    );

    setting.addButton((b) =>
      b.setButtonText("Choose…").onClick(() => {
        // One picker at a time, and this one is held so `onClose` can take
        // its listeners off. See `picker`.
        this.picker?.close();
        this.picker = openFolderPickerPopover({
          anchor: b.buttonEl,
          app: this.app,
          folders: this.deps.source,
          current: dirnameOf(row.path),
          // No "Clear" here: see `offerClear` in `FolderPickerPopover.ts`.
          // Its wording describes the missing-root dialog, and empty is not
          // one of the three answers this row offers.
          offerClear: false,
          apply: (folder) => {
            // A folder row takes the folder itself; a note row takes the
            // folder it now sits in, keeping the name it had. A note that was
            // renamed as well as moved is refused by `pointProblem`, with the
            // composed path left in the field to edit.
            const to =
              row.memberKind === "folder"
                ? folder
                : folder === ""
                  ? basenameOf(row.path)
                  : `${folder}/${basenameOf(row.path)}`;
            stage(to, "folder-pick");
            return Promise.resolve();
          },
        });
      })
    );

    if (actionsFor(row).includes("remove")) {
      setting.addButton((b) =>
        // "Remove from space", not "Remove": the row names a note or folder
        // that is already missing from the vault, and the shorter label reads
        // on that row as though it deletes the file.
        b.setButtonText("Remove from space").onClick(() => {
          this.gate.remove(index);
          say();
        })
      );
    }

    setting.addButton((b) =>
      b.setButtonText("Leave as is").onClick(() => {
        this.gate.leave(index);
        say();
      })
    );
  }

  /**
   * The paths pointing row `index` somewhere would collide with.
   *
   * The space's own path members, minus whatever another row is removing or
   * pointing away, plus whatever another row is pointing AT. Both passes run
   * before the result is read, so two rows cannot be judged against each
   * other in the order they happen to sit in. See `pointProblem`'s `taken`.
   */
  private takenPaths(index: number): Set<string> {
    const row = this.deps.rows[index];
    const taken = new Set<string>();
    // A root is not a member, and `restoreRows` never shows a root row
    // beside a member row, so nothing here can already hold it.
    if (!row || row.kind === "root") return taken;
    for (const m of this.deps.space.members) {
      if (m.kind === "file" || m.kind === "folder") taken.add(m.path);
    }
    const staged = this.deps.rows.map((_, i) => this.gate.stagedAt(i));
    for (const fix of staged) {
      if (fix?.kind === "remove-member") taken.delete(fix.path);
      if (fix?.kind === "point-member") taken.delete(fix.from);
    }
    staged.forEach((fix, i) => {
      if (i !== index && fix?.kind === "point-member") taken.add(fix.to);
    });
    // The row's own missing path gets its own refusal, one check earlier.
    taken.delete(row.path);
    return taken;
  }

  override onClose(): void {
    // The suggesters own document-level listeners; the modal's own teardown
    // does not reach them.
    for (const s of this.suggests) s.close();
    this.suggests.length = 0;
    this.picker?.close();
    this.picker = null;
    this.contentEl.empty();
  }
}
