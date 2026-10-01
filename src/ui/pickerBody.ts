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
 * The row leads with the deduplicated number of notes the selection comes to,
 * then names the folders and tags that selected them, because a folder and a
 * tag are selectors: counting the members alone under-reports a selection of
 * two tags by however many notes carry them. Taking the union is
 * `previewPaths`'s job; saying it is this file's.
 *
 * Pure: no DOM, no `"obsidian"`.
 */

import type { MemberEntry } from "../types";
import type { PickerMode } from "./pickerFilter";
import { tagCountLabel } from "./tagRowCounts";

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
 * The summary row's words: how many notes are selected, then the selectors
 * that got there.
 *
 * `notes` leads and is the DEDUPLICATED total of the whole selection: every
 * note picked by hand, every note under a picked folder and every note
 * carrying a picked tag, each counted once. It is the figure a reader wants
 * first, and it is the only count of notes the row prints. A second one would
 * make "notes" mean two things in one line, what was picked by hand and what
 * it all comes to, and the reader would have to work out which was which.
 *
 * It is an argument rather than something counted here because resolving a
 * selector needs the vault and the tag index, and this file has neither. See
 * `previewPaths` in `memberPreview.ts`, which takes the union and whose
 * `notes` counts files only: a folder member brings in its subfolders as
 * paths, and a subfolder is not a note.
 *
 * `picked.notes` only decides whether anything was chosen at all; the figure
 * printed is `notes`. `folders` and `tags` are the number of members picked, not the number of
 * folders or tags in the union. They name the selectors, so a person can see
 * what to unpick to change the total.
 *
 * Any selection comes to some number of notes, including none, so the notes
 * figure is always printed once anything is selected. `tagCountLabel` words
 * it, rather than a second spelling of the same sentence living here: it is
 * the words each tag row already uses for exactly this quantity, down to
 * "no notes" for none, and it groups digits by locale.
 *
 * A kind of selector with nothing in it is left out. "253 notes, 0 folders,
 * 0 tags" spends two thirds of a one-line row on things that are not there.
 *
 * Nothing chosen is still a sentence. An empty row would read as a row that
 * failed to draw, and the state it is reporting is the one the window opens
 * in.
 *
 * "notes" and "folders" rather than "files" and "items", because that is what
 * the plugin calls them everywhere a user can read.
 */
export function pickedSummary(picked: PickedCounts, notes: number): string {
  const selectors: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n <= 0) return;
    selectors.push(n === 1 ? `1 ${one}` : `${n.toLocaleString()} ${many}`);
  };
  add(picked.folders, "folder", "folders");
  add(picked.tags, "tag", "tags");
  // The members picked, not `notes`: a note picked by hand that has since left
  // the vault resolves to no notes, and that is still a selection.
  if (picked.notes + picked.folders + picked.tags === 0) return "Nothing selected";
  return [tagCountLabel(notes), ...selectors].join(", ");
}
