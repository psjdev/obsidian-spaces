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
 * The tags offered for `query`, normalized to the stored form.
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
): string[] {
  const known = src.knownTags();
  if (known === null) return [];

  const want = normalizeTag(query);
  // `""` survives normalization of a bare `#`, and would render as a nameless
  // `#` row that adds nothing when picked. Dropped here rather than guarded
  // at every call site.
  const unique = [...new Set(known.map(normalizeTag).filter((t) => t.length > 0))].sort();

  if (want.length === 0) return unique.slice(0, limit);
  return unique.filter((t) => t.includes(want)).slice(0, limit);
}
