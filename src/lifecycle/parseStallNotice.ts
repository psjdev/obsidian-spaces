/**
 * What to say when Obsidian's parse queue is stuck.
 *
 * Pure: no DOM, no `"obsidian"`, no `Notice`. The caller shows it; this
 * decides whether there is anything to say and what it reads.
 *
 * ## Why this exists instead of a repair
 *
 * Obsidian parses a note's metadata in a worker, through a serial queue. A
 * note whose text runs for very many lines without a blank line between them,
 * which is what pasted log output and exports look like, takes superlinear
 * time to parse: around a second at a quarter of a megabyte, half a minute at
 * one, and longer than anyone will wait by two. The promise the queue waits on
 * has no timeout, so the note behind it never parses either, and
 * `getFileCache` keeps answering `null` for every one of them.
 *
 * That is Obsidian's to fix, and until it does, every part of the app built on
 * metadata is equally stuck. Spaces used to read those files off disk itself
 * and carry on. It worked, and it was the wrong trade: it took a filesystem
 * dependency the rest of the plugin does not need, it could not work on
 * mobile, and it left somebody with an Obsidian where search and backlinks
 * were quietly broken while Spaces alone looked fine.
 *
 * So: say which note is holding up the queue, and let the person move or split
 * it. That is a fix they can actually apply, and it fixes the whole app rather
 * than this plugin's corner of it.
 *
 * ## Which note gets named
 *
 * THE LARGEST of the unparsed ones, not the first.
 *
 * It used to be the first in vault listing order, on the reasoning that the
 * unparsed set is a run of the vault walk starting at the offending note. A
 * real Obsidian disproved that: on a 33 MB jammed vault the first unparsed
 * path was `note-019.md`, sixty bytes long, and the notice told the user to
 * move or split it. `getMarkdownFiles()` order is not the parse queue's
 * order, and acting on that advice would have done nothing except cost
 * somebody a note.
 *
 * Size is a far better guess, because the cost that causes this is
 * superlinear in the length of the note: a note big enough to stall the queue
 * is essentially always the biggest thing in the unparsed set. It is still a
 * guess, which is why the wording says it is the largest rather than that it
 * is the cause.
 */

/**
 * The message, or `null` when there is nothing to report.
 *
 * `count` is how many notes are unparsed and `culprit` is the largest of
 * them; the caller picks it, because sizes come from the vault and this
 * stays pure. A count of zero reports nothing: an unavailable snapshot with
 * nothing unparsed means "nobody has walked yet", which is not worth
 * interrupting anyone over.
 */
export function parseStallMessage(count: number, culprit: string): string | null {
  if (count <= 0 || culprit === "") return null;
  // CONDITIONAL, not an order. Thirty seconds of a motionless queue is strong
  // evidence and not proof, and the thing being asked for is destructive: a
  // person who takes a healthy note out of their vault because of this has
  // been actively harmed by a guess.
  const tail = "If it stays that way, move that note out of the vault or split it into smaller notes.";
  if (count === 1) {
    return (
      `Spaces: Obsidian is still reading "${culprit}", so spaces that collect ` +
      `notes by a property are incomplete. ${tail}`
    );
  }
  return (
    `Spaces: Obsidian is still reading ${count} notes, so spaces that collect ` +
    `notes by a property are incomplete. The largest is "${culprit}". ${tail}`
  );
}
