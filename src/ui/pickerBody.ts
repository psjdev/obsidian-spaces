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
 * The row reports what was picked AND the deduplicated number of notes that
 * comes to, because a folder and a tag are selectors: counting the members
 * alone under-reports a selection of two tags by however many notes carry
 * them. Taking the union is `previewPaths`'s job; saying it is this file's.
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
 * The summary row's words: what was picked, then what it comes to.
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
 *
 * `notes` is the DEDUPLICATED total the whole selection comes to, which is
 * what the kinds on the left cannot say: a folder selects everything under it
 * and a tag selects every note carrying it, so three members can be three
 * notes or three hundred. It is a separate argument rather than something
 * counted here because resolving a selector needs the vault and the tag
 * index, and this file has neither — see `previewPaths` in `memberPreview.ts`,
 * which is where the union is actually taken.
 *
 * The total is left off when notes alone were picked. A note selects itself,
 * so the left half already IS the total, and printing the same number twice
 * sends the reader looking for a difference between two figures that cannot
 * differ.
 *
 * `tagCountLabel` words the total, rather than a second spelling of the same
 * sentence living here: it is the words each tag row already uses for exactly
 * this quantity, down to "no notes" for none, so the row and its total read as
 * one vocabulary.
 */
export function pickedSummary(counts: PickedCounts, notes: number): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n <= 0) return;
    parts.push(n === 1 ? `1 ${one}` : `${n.toLocaleString()} ${many}`);
  };
  add(counts.notes, "note", "notes");
  add(counts.folders, "folder", "folders");
  add(counts.tags, "tag", "tags");
  if (parts.length === 0) return "Nothing selected";
  const picked = parts.join(", ");
  if (counts.folders === 0 && counts.tags === 0) return picked;
  return `${picked} · ${tagCountLabel(notes)}`;
}
