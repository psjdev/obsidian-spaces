import type { MemberEntry } from "../types";

/**
 * What the space being created would actually hold, resolved from its members
 * as they stand.
 *
 * Members are a UNION: a list of them means "any of these", so every member
 * adds to the result and none of them narrows it. That is the whole reason
 * this exists rather than the picker previewing one candidate tag on its own —
 * a tag shown alone would claim the space contains those notes and no others,
 * which is false the moment a second member is there, and an intersection
 * would be wrong in every case.
 *
 * A reading of the vault as it is now, and nothing more. A tag member resolves
 * live forever after, so the space this describes is the one that would exist
 * this second; the preview is a way to recognise the right selector, not a
 * list of what the space is frozen to.
 *
 * Pure: no DOM, no `"obsidian"`, no visibility engine. The vault and the tag
 * lookup arrive as arguments, which is the arrangement `createSpaceForm.ts`
 * and `tagCandidates.ts` already use.
 */

/**
 * The slice of the vault this needs, declared locally so the module depends on
 * nothing. `VaultSource` satisfies it structurally.
 */
export interface PreviewVault {
  allPaths(): string[];
  kindOf(path: string): "file" | "folder" | null;
}

export interface Preview {
  /**
   * Every path the space covers: the notes, and the folders a folder member
   * brought in. Both, because the tree that draws this wants the folders as
   * branches and `visibleRows` keeps a node whose descendant survives.
   */
  paths: Set<string>;
  /** How many of those are notes. Folders are structure, not contents. */
  notes: number;
}

/**
 * The union of everything the given members select.
 *
 * - A file member contributes itself.
 * - A folder member contributes itself and everything beneath it, which is
 *   what a folder in a curated space means.
 * - A tag member contributes whatever `pathsMatching` says, which already
 *   includes the notes carrying a tag nested under it.
 *
 * `allPaths` is read only if there IS a folder member, and only once however
 * many there are: the picker's common case is tags alone, and the preview is
 * redrawn on every keystroke that changes the candidate.
 *
 * Duplicates collapse, because it is a set. A note carried by two members is
 * in the space once, and counting it twice would make the preview's number
 * disagree with its own rows.
 */
export function previewPaths(
  members: readonly MemberEntry[],
  vault: PreviewVault,
  pathsMatching: (tag: string) => readonly string[]
): Preview {
  const paths = new Set<string>();
  let all: readonly string[] | null = null;

  for (const member of members) {
    if (member.kind === "tag") {
      for (const path of pathsMatching(member.tag)) paths.add(path);
      continue;
    }
    paths.add(member.path);
    if (member.kind === "file") continue;
    // A trailing slash, so `Projects` does not swallow `Projects Archive`.
    const prefix = `${member.path}/`;
    all ??= vault.allPaths();
    for (const path of all) if (path.startsWith(prefix)) paths.add(path);
  }

  let notes = 0;
  for (const path of paths) if (vault.kindOf(path) === "file") notes += 1;
  return { paths, notes };
}

/**
 * What the preview's header says it is showing.
 *
 * Nouned rather than left as a bare numeral, because the header's other half
 * is only the words "In this space". Zero is worded rather than numbered: a
 * grey `0 notes` reads as a count that failed to arrive, and the state is a
 * real one either way, whether nothing has been chosen or what was chosen
 * matches nothing right now.
 *
 * Grouped by locale, since the vaults where a preview is worth having are the
 * ones where the digits are hard to read unseparated.
 */
export function previewLabel(notes: number): string {
  if (notes <= 0) return "nothing yet";
  if (notes === 1) return "1 note";
  return `${notes.toLocaleString()} notes`;
}
