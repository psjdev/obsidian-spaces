/**
 * What the space quick switcher offers for a given query.
 *
 * Kept apart from the modal for the same reason as `headerPlacement.ts` and
 * `panelCoverage.ts`: `SpaceSuggestModal` imports from `"obsidian"`, so nothing
 * in that file can be reached from a plain Vitest run. All the behaviour worth
 * asserting lives here instead.
 *
 * The scorer is a parameter rather than an import, which is what keeps this
 * file free of `"obsidian"` entirely. The modal passes
 * `prepareFuzzySearch(query)`; the tests pass something predictable.
 *
 * Pure on purpose: the caller searches, this decides what to show.
 */
import type { SpaceEntry } from "./spaceEntries";

/**
 * How many spaces an empty query offers, on top of *All*.
 *
 * Small on purpose. The switcher earns its place in a vault with too many
 * spaces to scan, and a list of eighty on open is the problem it was built to
 * escape. Five is enough to cover an ordinary vault outright -- where the cap
 * never bites and nothing is hidden -- while a large one types instead, which
 * is the point of the thing.
 */
export const EMPTY_QUERY_SPACES = 5;

export interface SpaceSuggestion<M> {
  entry: SpaceEntry;
  /** The scorer's result, or null for the empty query, which is not a search. */
  match: M | null;
}

/**
 * The entries to show, in the order to show them.
 *
 * Generic over the match so this file never names an Obsidian type: the modal
 * instantiates it with `SearchResult`, and only `score` is ever read.
 */
export function spaceSuggestions<M extends { score: number }>(
  entries: readonly SpaceEntry[],
  query: string,
  score: (text: string) => M | null
): SpaceSuggestion<M>[] {
  // Whitespace counts as empty. Otherwise a stray space bar blanks the list,
  // since no space's name contains one at the point the scorer looks.
  if (!query.trim()) {
    // `spaceEntries` documents *All* as first, so this slice is exactly *All*
    // plus the cap. A vault at or below the cap keeps its whole set.
    return entries
      .slice(0, EMPTY_QUERY_SPACES + 1)
      .map((entry) => ({ entry, match: null }));
  }

  // The definition index is carried through the sort as the tie-break. Without
  // it, equally scored spaces would come back in whatever order the sort
  // happened to leave them, and the list would reshuffle between keystrokes
  // that did not change a single score.
  const hits: { entry: SpaceEntry; match: M; order: number }[] = [];
  entries.forEach((entry, order) => {
    const match = score(entry.label);
    if (match) hits.push({ entry, match, order });
  });

  hits.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  return hits.map(({ entry, match }) => ({ entry, match }));
}
