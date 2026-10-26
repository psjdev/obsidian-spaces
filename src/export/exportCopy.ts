import type { ConfirmPrompt } from "../ui/settingsEdits";
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
  | "collision"
  | "not-our-folder"
  | "another-space";

export const BLOCKED_REASONS: readonly BlockedReason[] = [
  "no-space",
  "indexing",
  "missing-root",
  "inside-vault",
  "contains-vault",
  "unknown-vault",
  "collision",
  "not-our-folder",
  "another-space",
];

/**
 * The gate in front of the one destructive thing this feature does.
 *
 * Names the full path, because the folder being replaced is outside the
 * vault and the space's name alone does not say where it is.
 */
export function replaceConfirmPrompt(fullPath: string, spaceName: string): ConfirmPrompt {
  return {
    title: `Replace the existing export of ${spaceName}?`,
    body:
      `${fullPath} already holds an export of this space. ` +
      "Replacing it deletes that folder and writes the space again. " +
      "Notes and folders you have added to it since will be lost.",
    confirmLabel: "Replace",
  };
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
    case "not-our-folder":
      return "A folder of that name is already there and is not an export of this space. Pick a different folder, or move that one out of the way.";
    case "another-space":
      return "That folder holds an export of a different space. Rename this space, or pick a different folder.";
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
