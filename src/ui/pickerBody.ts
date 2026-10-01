/**
 * Which body the create panel's explorer window draws, and what the row
 * pinned under it says about the result.
 *
 * The window shows one of two things and the two buttons above it choose
 * which. Both bodies do the same job: show everything the vault holds of that
 * kind, mark what this space has already taken, and narrow to whatever the
 * filter box says. That symmetry is the design — two buttons that mean the
 * same kind of thing — so the rule here is small on purpose, and the summary
 * row is what makes a choice made in one body still visible from the other.
 *
 * Pure: no DOM, no `"obsidian"`.
 */

import type { MemberEntry } from "../types";
import type { PickerMode } from "./pickerFilter";

/**
 * The body to draw, given the mode the buttons hold and whether this is a
 * folder space.
 *
 * Folder mode overrules the buttons, which is why this exists at all rather
 * than the panel reading its own field: a folder space is a window onto one
 * root and a tag is not one, so that mode is offered no Tags button and must
 * not be left showing tags by a button press that happened before the switch.
 */
export function readPickerBody(mode: PickerMode, folderMode: boolean): PickerMode {
  return folderMode ? "items" : mode;
}

/** What this space has taken so far, in the kinds the summary row names. */
export interface PickedCounts {
  notes: number;
  folders: number;
  tags: number;
}

/** The counts behind a curated space's current members. */
export function countPicked(items: readonly MemberEntry[]): PickedCounts {
  const counts: PickedCounts = { notes: 0, folders: 0, tags: 0 };
  for (const item of items) {
    if (item.kind === "tag") counts.tags += 1;
    else if (item.kind === "folder") counts.folders += 1;
    else counts.notes += 1;
  }
  return counts;
}

/**
 * The summary row's words.
 *
 * "notes" and "folders" rather than "files" and "items", because that is what
 * the plugin calls them everywhere a user can read: the README, the settings
 * tab and the tag rows' own counts. A picker that invented a third vocabulary
 * for the same two things would make the reader check whether a third thing
 * was meant.
 *
 * A kind with nothing in it is left out entirely. "3 notes, 0 folders, 0 tags"
 * spends two thirds of the row on things that are not there, and the row is
 * one line tall.
 *
 * Nothing chosen is still a sentence. An empty row would read as a row that
 * failed to draw, and the state it is reporting is the one the window opens
 * in.
 */
export function pickedSummary(counts: PickedCounts): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n <= 0) return;
    parts.push(n === 1 ? `1 ${one}` : `${n.toLocaleString()} ${many}`);
  };
  add(counts.notes, "note", "notes");
  add(counts.folders, "folder", "folders");
  add(counts.tags, "tag", "tags");
  return parts.length === 0 ? "Nothing selected" : parts.join(", ");
}
