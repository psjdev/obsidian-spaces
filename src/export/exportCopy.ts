import type { ConfirmPrompt } from "../ui/settingsEdits";
import type { ExistingExport } from "./spaceManifest";
import type { ExportOutcome } from "./runExport";

/**
 * Every word the export says.
 *
 * Pure, and separate from the command, following `settingsEdits.ts`: the
 * wording is then testable in plain node and the modal stays thin.
 */

export type BlockedReason =
  | "no-space"
  | "indexing"
  | "missing-root"
  | "inside-vault"
  | "contains-vault"
  | "unknown-vault"
  | "collision";

export const BLOCKED_REASONS: readonly BlockedReason[] = [
  "no-space",
  "indexing",
  "missing-root",
  "inside-vault",
  "contains-vault",
  "unknown-vault",
  "collision",
];

/** What the export found waiting at the destination. */
export interface OccupiedDestination {
  fullPath: string;
  /** How many entries the folder holds, dotfiles included. */
  entries: number;
  /**
   * What the folder's own manifest says, or null when there is none and the
   * folder is therefore not an export at all.
   */
  existing: ExistingExport | null;
  /** True when `existing` records the space being exported right now. */
  isThisSpace: boolean;
}

/**
 * The gate in front of the one destructive thing this feature does.
 *
 * Always a question, never a refusal. Whatever is in the way, the user is
 * told what it is and asked; refusing outright left them with a dead end
 * inside the plugin and nothing to do about it.
 *
 * That makes this text the only thing between someone and a recursive
 * delete of a folder that is not ours, so it says three things every time:
 * the full path, what the folder appears to be, and how much is in it. A
 * space called "Documents" pointed at a home directory produces "holds 412
 * notes and folders", which is what tells someone to stop.
 *
 * It REPORTS rather than asserts ownership. A space id is a slug of its
 * name and is freed when the space is deleted, so deleting a space and
 * creating another with the same name recycles the id and an export of the
 * OLD space matches the new one exactly. A matching id is evidence, not
 * proof.
 */
export function replaceConfirmPrompt(at: OccupiedDestination): ConfirmPrompt {
  const lost = "Replacing it deletes that folder and everything in it, then writes this space again.";
  // An export holds a copy of a vault, so "notes and folders" is right for
  // it. A folder that is NOT an export is just a folder on disk and its
  // contents are not notes, so calling them that would be wrong rather
  // than merely loose.
  const held = `It holds ${countPhrase(at.entries, at.existing !== null)}.`;

  if (at.existing !== null && at.isThisSpace) {
    const made = describeDate(at.existing.exportedAt);
    const named = at.existing.spaceName === null ? "an export" : `an export of "${at.existing.spaceName}"`;
    return {
      title: "Replace the export already in that folder?",
      body: `${at.fullPath} holds ${named}${made}. ${held} ${lost} Check it is the one you mean.`,
      confirmLabel: "Replace",
    };
  }

  if (at.existing !== null) {
    const named = at.existing.spaceName === null ? "another space" : `the space "${at.existing.spaceName}"`;
    return {
      title: "That folder holds another space's export",
      body:
        `${at.fullPath} holds an export of ${named}, not this one. ${held} ${lost} ` +
        "Pick a different folder unless you meant to replace it.",
      confirmLabel: "Replace anyway",
    };
  }

  return {
    title: "A folder of that name is already there",
    body:
      `${at.fullPath} already exists and is not an export. ${held} ${lost} ` +
      "Make sure this is a folder you want to lose.",
    confirmLabel: "Delete it and export",
  };
}

/**
 * "nothing", "1 note or folder", "412 files and folders".
 *
 * `vaultContent` picks the noun. Inside an export the entries came out of a
 * vault and are notes; anywhere else they are whatever happened to be on
 * disk, and this feature writes outside the vault.
 */
function countPhrase(n: number, vaultContent: boolean): string {
  if (n <= 0) return "nothing";
  const one = vaultContent ? "note" : "file";
  const many = vaultContent ? "notes and folders" : "files and folders";
  return n === 1 ? `1 ${one} or folder` : `${String(n)} ${many}`;
}

/** " made on 25 October 2026", or "" when the export did not say. */
function describeDate(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return ` made on ${d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  })}`;
}

export function blockedMessage(reason: BlockedReason): string {
  switch (reason) {
    case "no-space":
      return "Switch to a space before exporting. All cannot be exported.";
    case "indexing":
      return "Wait for the vault to finish indexing, then export again.";
    case "missing-root":
      return "Point this space at a folder that exists, then export again.";
    case "inside-vault":
      return "Pick a folder outside your vault. Exporting into the vault would add the copies to the space.";
    case "contains-vault":
      return "Pick a folder that does not hold your vault.";
    case "unknown-vault":
      return "Spaces cannot tell where this vault is on disk, so it cannot check the folder you picked. Export is not available.";
    case "collision":
      return "Two notes in this space have names that differ only in capitalization, so one would overwrite the other. Rename one, then export again.";

  }
}

export function outcomeMessage(outcome: ExportOutcome, fullPath: string): string {
  if (outcome.failed) {
    return (
      `Export stopped at ${outcome.failed.path}: ${outcome.failed.message}. ` +
      `${String(outcome.copied)} copied so far are in ${fullPath}.`
    );
  }
  if (outcome.copied === 0) {
    return `This space has nothing to copy. ${fullPath} holds its details only.`;
  }
  const noun = outcome.copied === 1 ? "note or folder" : "notes and folders";
  return `Exported ${String(outcome.copied)} ${noun} to ${fullPath}.`;
}
