import { getAllTags, type App } from "obsidian";
import { createMapTagIndex, pathsByTag, type TagIndex } from "./TagIndex";

/**
 * Snapshot of which notes carry which tags, rebuilt when the caller rebuilds
 * it rather than queried live, so one recompute sees one consistent picture.
 * Same contract as `createObsidianVaultIndex`.
 *
 * `getAllTags` is the only reader, because a note's tags live in two places.
 * `frontmatter.tags` and inline `#tag` are stored separately in the metadata
 * cache, so reading frontmatter alone would silently miss every inline tag.
 * It returns null for a note with no usable metadata, which `pathsByTag`
 * treats as untagged rather than letting it reach the matcher.
 *
 * Only the two things that need the Obsidian runtime are here — the vault
 * walk and `getAllTags`. What goes INTO the map, including which tags a note
 * is filed under and the ancestor expansion that makes a nested tag findable
 * from its parent, is `pathsByTag`'s and is tested in plain node.
 */
export function createObsidianTagIndex(app: App): TagIndex {
  return createMapTagIndex(
    pathsByTag(
      app.vault.getMarkdownFiles(),
      (file) => file.path,
      (file) => {
        const cache = app.metadataCache.getFileCache(file);
        return cache === null ? null : getAllTags(cache);
      }
    )
  );
}
