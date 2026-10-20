import { Modal, Notice, Setting, type App } from "obsidian";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { SpaceDefinition, SpacesDefinitions, OrderMap } from "../types";
import type { RestoreProblem } from "./restoreCheck";
import { hasRoot, isVaultRoot, rootOf } from "../visibility/folderSpace";
import { isSafeVaultPath } from "../definitions/schema";
import { repairExclude } from "../lifecycle/pathRepair";
import { insertAt } from "../order/orderModel";
import { FolderSuggest } from "./FolderSuggest";
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
  | { kind: "point-root"; to: string };

/* ------------------------------------------------------------------ *
 * What the gate shows
 * ------------------------------------------------------------------ */

/**
 * The paths this gate is accountable for: the one root, or the distinct
 * member paths.
 *
 * **A space that declares a root is checked on its root alone.**
 * `SpaceController.membersForSnapshot` answers `[{ path: root }]` for any
 * space with a `root`, usable or not, so a folder space's member list is
 * never what the TREE draws: a missing member of one is true, and invisible
 * in the thing a restore puts back. Counting it would make the lede describe
 * notes the restored space will not show.
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
 *    member sharing a path, yield the same path twice. The loader's own key
 *    is `"p:" + path`, not namespaced by kind, so only a hand-edited
 *    `data.json` gets there — but two identical rows would let one path be
 *    given two contradictory answers, and a fix applies to every member
 *    naming the path anyway (`applyRestoreFixes`). The first report wins,
 *    which keeps stored order.
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
 *  - A path `isSafeVaultPath` rejects (a leading slash, a backslash, `..`)
 *    fails `validateMembers`, and the whole `mutate` is then rejected as an
 *    "invalid mutation" with nothing restored and a schema error in a
 *    notice. Refusing it here costs one message instead.
 */
export function pointProblem(
  row: RestoreRow,
  to: string,
  kindOf: (path: string) => "file" | "folder" | null,
  source: PointSource = "typed"
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
    // backslash, a drive letter and a `.` or `..` segment, and naming only
    // the leading slash gave the wrong instruction to anyone who typed
    // `Notes\a.md` or `../a.md`.
    return (
      "Not a vault path. Give a path inside the vault, with forward slashes, " +
      "no leading slash, no drive letter, and no . or .. steps."
    );
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
export function restoreLede(ok: number, bad: number): string {
  const total = ok + bad;
  const subject = total === 1 ? "note or folder is" : "notes and folders are";
  const not = bad === 1 ? "is" : "are";
  return `${ok} of ${total} ${subject} still there. ${bad} ${not} not, and nothing has changed yet.`;
}

/** What is wrong with one row, in the words of what is expected there. */
export function rowProblem(row: RestoreRow): string {
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

/**
 * Apply the staged fixes to a mutation DRAFT and clear the archived flag, in
 * place.
 *
 * The flag goes last and unconditionally: a gate answered with nothing but
 * "leave" is still a restore. The flag is DELETED rather than set to false,
 * exactly as `restoreSpace` does, so the restored space carries no record of
 * having been archived.
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
): void {
  const space = draft.spaces.find((s) => s.id === spaceId);
  if (!space) return;
  const order = draft.orders?.bySpaceId?.[spaceId];
  for (const fix of fixes) {
    if (fix.kind === "point-root") {
      // The root's exclusions sit under it exactly as a member folder's do.
      // Its ORDER keys are a different question, and left alone: see
      // `repointInOrder`. A stale order puts a row in the wrong place, which
      // is visible and self-correcting; a stale exclusion silently returns a
      // note the user took out.
      followExclusions(space, space.root ?? "", fix.to);
      space.root = fix.to;
      continue;
    }
    if (fix.kind === "point-member") {
      for (const m of space.members) {
        if ((m.kind === "file" || m.kind === "folder") && m.path === fix.from) m.path = fix.to;
      }
      // NESTED folder fixes are order-dependent here, and left that way: an
      // outer `Old/Dir` fix rewrites the exclusions under `Old/Dir/Sub`
      // before the fix for `Old/Dir/Sub` sees them, so they follow the outer
      // destination rather than the inner one. Both destinations are folders
      // the user just named, each entry is still carried rather than
      // dropped, and the gate stages at most one fix per path — so the
      // narrow case is "excluded under the wrong one of two chosen folders",
      // which is stated here rather than solved.
      followExclusions(space, fix.from, fix.to);
      if (order) repointInOrder(order, fix.from, fix.to);
      continue;
    }
    space.members = space.members.filter(
      (m) => !((m.kind === "file" || m.kind === "folder") && m.path === fix.path)
    );
    if (order) dropFromOrder(order, fix.path);
  }
  delete space.archived;
}

/** The fixes and the flag clear, in ONE write. See this file's docstring. */
export async function commitRestore(
  defs: DefinitionStore,
  spaceId: string,
  fixes: readonly StagedFix[]
): Promise<void> {
  await defs.mutate((d) => {
    applyRestoreFixes(d, spaceId, fixes);
  });
}

/* ------------------------------------------------------------------ *
 * Staging
 * ------------------------------------------------------------------ */

/** The side of the gate that touches Obsidian, kept behind an interface. */
export interface RestoreGateIo {
  apply(fixes: readonly StagedFix[]): Promise<void>;
  close(): void;
  onError(message: string): void;
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
  /** A second Restore click while the first write is in flight writes twice. */
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
        ? { kind: "point-root", to }
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
    try {
      await this.io.apply(this.fixes());
    } catch (e) {
      this.io.onError(String(e));
      return false;
    } finally {
      this.running = false;
    }
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
  apply(fixes: readonly StagedFix[]): Promise<void>;
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
    });
  }

  override onOpen(): void {
    const { space, rows } = this.deps;
    this.titleEl.setText(restoreTitle(space));
    const ok = checkedPaths(space).length - rows.length;
    this.contentEl.createEl("p", { text: restoreLede(ok, rows.length) });

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
      const problem = pointProblem(row, to, (p) => this.deps.source.kindOf(p), source);
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
        openFolderPickerPopover({
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
        b.setButtonText("Remove").onClick(() => {
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

  override onClose(): void {
    // The suggesters own document-level listeners; the modal's own teardown
    // does not reach them.
    for (const s of this.suggests) s.close();
    this.suggests.length = 0;
    this.contentEl.empty();
  }
}
