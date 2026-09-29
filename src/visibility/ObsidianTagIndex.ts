import { getAllTags, type App } from "obsidian";
import { normalizeTag } from "./tagMatch";
import { createMapTagIndex, type TagIndex } from "./TagIndex";

/**
 * Snapshot of every note's tags, rebuilt when the caller rebuilds it rather
 * than queried live, so one recompute sees one consistent picture. Same
 * contract as `createObsidianVaultIndex`.
 *
 * `getAllTags` is the only reader, because a note's tags live in two places.
 * `frontmatter.tags` and inline `#tag` are stored separately in the metadata
 * cache, so reading frontmatter alone would silently miss every inline tag.
 * It returns null for a note with no usable metadata, which becomes an empty
 * list here rather than reaching the matcher.
 */
export function createObsidianTagIndex(app: App): TagIndex {
  const byPath = new Map<string, string[]>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    const tags = cache === null ? null : getAllTags(cache);
    byPath.set(file.path, (tags ?? []).map(normalizeTag));
  }
  return createMapTagIndex(byPath);
}
