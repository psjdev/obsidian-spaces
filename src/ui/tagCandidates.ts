/**
 * What the add-a-tag field offers, pure — no DOM, no `"obsidian"` import.
 *
 * Sits beside `TagSuggest` exactly as `folderCandidates` sits beside
 * `FolderSuggest`, and for the same reason: the suggester class cannot be
 * imported under Vitest at all, because `AbstractInputSuggest` needs a real
 * `App`. Everything that decides WHAT is offered therefore lives here, where
 * it can be tested in plain node, and the class is left adapting Obsidian's
 * popover to this function.
 */

import { normalizeTag } from "../visibility/tagMatch";

/**
 * The slice of the vault this module needs, declared locally so it depends on
 * neither Obsidian nor the visibility engine — the arrangement `VaultSource`
 * uses in `createSpaceForm.ts`.
 */
export interface TagSource {
  /**
   * Every tag the vault knows, in whatever spelling the source holds them, or
   * null when the source cannot say. Null means "no candidates", NEVER "the
   * vault has no tags": the only implementation is `nativeKnownTags`, which
   * reaches for a private Obsidian method and returns null when that method
   * is not there to call.
   */
  knownTags(): string[] | null;
}

/** How many candidates the popover offers at once. */
const DEFAULT_LIMIT = 50;

/**
 * The tags offered for `query`, normalized to the stored form, or `null` when
 * the source could not say what the vault holds.
 *
 * `null` is propagated rather than flattened to `[]`. The two are the same
 * dropdown to look at and completely different things to tell the user:
 * an empty list means this vault has no matching tag, while `null` means
 * `getTags` was not there to call and the suggester will never offer
 * anything again. Flattening it here left the caller with no way to tell
 * them apart, so the notice written for exactly that failure
 * ("tag suggestions are unavailable") fired only on a throw, which is not
 * how `nativeKnownTags` reports it — it returns null, by design.
 *
 * Normalized before matching, not after, so a user who types the `#` they see
 * everywhere else in Obsidian gets the same list as one who does not, and so
 * two spellings of one tag collapse to the single entry that will actually be
 * stored. `normalizeTag` lowercases, which is what makes the match
 * case-insensitive without a second `toLowerCase` here.
 *
 * A substring match rather than a prefix one, matching `folderCandidates`: a
 * nested tag's useful part is often its last segment, and requiring a prefix
 * would hide `project/console` from someone typing `console`.
 *
 * An empty query lists the first `limit` tags rather than nothing, so focusing
 * the field is browsable before you know what the vault holds — again what
 * `folderCandidates` does.
 *
 * Sorted alphabetically so the order is stable rather than whatever order the
 * source happened to enumerate in, and capped so a vault with thousands of
 * tags cannot build a popover thousands of rows long.
 */
export function tagCandidates(
  src: TagSource,
  query: string,
  limit = DEFAULT_LIMIT
): string[] | null {
  const unique = storedTags(src);
  if (unique === null) return null;

  const want = normalizeTag(query);
  if (want.length === 0) return unique.slice(0, limit);
  return unique.filter((t) => t.includes(want)).slice(0, limit);
}

/**
 * The vault's tags in the spelling that will be stored: normalized, unique,
 * alphabetical, or null when the source cannot say.
 *
 * `""` survives normalization of a bare `#`, and would render as a nameless
 * `#` row that adds nothing when picked. Dropped here rather than guarded at
 * every call site.
 *
 * Alphabetical so an unranked list is stable rather than whatever order the
 * source happened to enumerate in, and so a ranked one has a tie-break that
 * does not reshuffle between keystrokes that changed no score.
 *
 * Exported uncapped for the create panel's tag tree, the one caller that must
 * see every tag: a cap applied before a tree is built drops whole branches
 * rather than the rows at the bottom of a list, and that tree does its own
 * filtering and its own capping afterwards. The two capped readings above keep
 * their caps, because the flat lists they back have nothing to lose a branch
 * from.
 */
export function storedTags(src: TagSource): string[] | null {
  const known = src.knownTags();
  if (known === null) return null;
  return [...new Set(known.map(normalizeTag).filter((t) => t.length > 0))].sort();
}

/** One offered tag, with whatever the scorer said about it. */
export interface TagHit<M> {
  /** The stored spelling: no `#`, lowercased. */
  tag: string;
  /**
   * The scorer's result, or null for the empty query, which is not a search.
   * The caller renders a match with its characters highlighted and a null
   * plainly, rather than being handed a fabricated result to draw.
   */
  match: M | null;
}

/**
 * The tags offered for `query`, ranked, or null when the source could not say
 * what the vault holds.
 *
 * Ranked rather than filtered, which is the difference between this and
 * `tagCandidates` above. The create panel's picker shows tags in the same
 * place it shows the vault tree, in the same list-you-scan shape as the quick
 * switcher, so it wants the quick switcher's matching: `proj/con` should find
 * `projects/console`, and the best hit should be first. `tagCandidates` keeps
 * its substring match because the add-a-tag field it backs is an
 * autocomplete on an input, where a surprising reorder under the caret is a
 * cost rather than a feature.
 *
 * The scorer arrives as a FACTORY rather than as a built scorer, which is what
 * keeps this module free of `"obsidian"` while still owning the whole
 * decision. `prepareFuzzySearch` has exactly this shape, so the panel passes
 * it by name; a test passes something predictable. Building the scorer here
 * rather than at the call site is what lets `normalizeTag` run on the query
 * before anything is scored — otherwise the panel would have to know that a
 * typed `#Proj` and a stored `proj` are the same search, which is precisely
 * the knowledge this module exists to hold.
 *
 * Ordering is done here, not by `sortSearchResults`: that is an `"obsidian"`
 * export, and importing it would cost this module its purity for a sort two
 * lines long. The index tie-break is `spaceSuggest.ts`'s, for the same reason
 * — without it, equally scored tags come back in whatever order the sort
 * happened to leave them.
 */
export function fuzzyTagCandidates<M extends { score: number }>(
  src: TagSource,
  query: string,
  makeScorer: (query: string) => (text: string) => M | null,
  limit = DEFAULT_LIMIT
): TagHit<M>[] | null {
  const unique = storedTags(src);
  if (unique === null) return null;

  const want = normalizeTag(query);
  // A bare `#` browses. Scoring against an empty query is not a search, and
  // Obsidian's own scorer answers one with a zero for everything, which would
  // leave the list ordered by nothing.
  if (want.length === 0) return unique.slice(0, limit).map((tag) => ({ tag, match: null }));

  const score = makeScorer(want);
  const hits: { tag: string; match: M; order: number }[] = [];
  unique.forEach((tag, order) => {
    const match = score(tag);
    if (match) hits.push({ tag, match, order });
  });
  hits.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  // Capped after ranking, so the cap takes the BEST matches rather than the
  // first alphabetical ones that happened to match.
  return hits.slice(0, limit).map(({ tag, match }) => ({ tag, match }));
}
