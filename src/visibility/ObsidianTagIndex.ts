import { getAllTags, type App } from "obsidian";
import { createMapTagIndex, tagsByPath, type TagIndex } from "./TagIndex";

/**
 * Snapshot of every TAGGED note's tags, rebuilt when the caller rebuilds it
 * rather than queried live, so one recompute sees one consistent picture.
 * Same contract as `createObsidianVaultIndex`.
 *
 * `getAllTags` is the only reader, because a note's tags live in two places.
 * `frontmatter.tags` and inline `#tag` are stored separately in the metadata
 * cache, so reading frontmatter alone would silently miss every inline tag.
 * It returns null for a note with no usable metadata, which `tagsByPath`
 * treats as untagged rather than letting it reach the matcher.
 *
 * Only the two things that need the Obsidian runtime are here — the vault
 * walk and `getAllTags`. What goes INTO the map, including the decision to
 * store nothing at all for an untagged note, is `tagsByPath`'s and is tested
 * in plain node.
 */
export function createObsidianTagIndex(app: App): TagIndex {
  return createMapTagIndex(
    tagsByPath(
      app.vault.getMarkdownFiles(),
      (file) => file.path,
      (file) => {
        const cache = app.metadataCache.getFileCache(file);
        return cache === null ? null : getAllTags(cache);
      }
    )
  );
}
