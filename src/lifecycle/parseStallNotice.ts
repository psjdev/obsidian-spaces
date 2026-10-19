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
 * The FIRST path, in the vault's own listing order, which is the order
 * `walkPropertyCache` collects them in. Measured on a jammed vault: the
 * unparsed set is a run of the vault walk starting at the offending note, so
 * the first entry is the one at the head of the queue. It is the best
 * available guess rather than a guarantee, which is why the wording says it is
 * first in the queue rather than that it is the cause.
 */

/**
 * The message, or `null` when there is nothing to report.
 *
 * `null` for an empty list so the caller has one thing to test. An unavailable
 * snapshot with no unparsed paths is a real state and means "nobody has
 * walked yet", which is not worth interrupting anyone over.
 */
export function parseStallMessage(unparsed: readonly string[]): string | null {
  const first = unparsed[0];
  if (first === undefined) return null;
  const tail = "Move or split that note.";
  if (unparsed.length === 1) {
    return (
      `Spaces: Obsidian has not finished reading "${first}", so spaces that ` +
      `collect notes by a property are incomplete. ${tail}`
    );
  }
  return (
    `Spaces: Obsidian has not finished reading ${unparsed.length} notes, so ` +
    `spaces that collect notes by a property are incomplete. "${first}" is ` +
    `first in the queue. ${tail}`
  );
}
