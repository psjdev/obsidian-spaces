import { normalizeTag, tagMatches } from "./tagMatch";

/**
 * The tag half of the engine's view of the vault, kept separate from
 * `VaultIndex` because tags are not vault structure and every member kind
 * that needed one more `VaultIndex` method would make that interface grow
 * without end.
 */
export interface TagIndex {
  /** Paths carrying this tag or a tag nested under it. Any tag spelling. */
  pathsMatching(tag: string): string[];
}

/**
 * A `TagIndex` over a path to normalized-tags map.
 *
 * Pure, so it runs in plain node. `ObsidianTagIndex` builds the map from the
 * metadata cache and hands it here, which is the same division
 * `createTreeVaultIndex` and `createObsidianVaultIndex` already use.
 *
 * A linear scan per lookup. A space holds a handful of tag members, so this
 * is a handful of passes over the vault's notes per recompute. Inverting the
 * map to tag -> paths would not help without also expanding every ancestor
 * tag of every note, since nested tags match. Measure before changing it.
 */
export function createMapTagIndex(byPath: Map<string, string[]>): TagIndex {
  return {
    pathsMatching(tag: string): string[] {
      const want = normalizeTag(tag);
      if (want.length === 0) return [];
      const out: string[] = [];
      for (const [path, tags] of byPath) {
        if (tags.some((t) => tagMatches(want, t))) out.push(path);
      }
      return out;
    },
  };
}

/**
 * A `TagIndex` that does not exist until something asks it a question.
 *
 * `createObsidianTagIndex` walks every markdown file in the vault, reads each
 * one's metadata cache and allocates a tag array per file. The coalescer's
 * flush replaces the tag index on every burst of vault events, so building it
 * eagerly there made every user pay an O(vault) allocating walk per burst,
 * including the great majority who have never put a tag in a space.
 *
 * Only `resolveMembers` ever asks, and only for a space holding a tag member,
 * so wrapping the build makes the walk happen exactly when a tag member is
 * about to be expanded and never otherwise. That is the same laziness
 * `SpaceContentsModal` and `SettingsTab` already apply to their own copies;
 * this is the flush finally applying it too.
 *
 * Built at most ONCE per wrapper, so one recompute sees one consistent
 * picture, exactly as an eagerly built snapshot does. A caller wanting a
 * fresh picture makes a fresh wrapper, which is what the flush does.
 *
 * Ordering matters and falls out right: the flush replaces the vault index
 * first and this wrapper second, so the build can only ever happen at or
 * AFTER the vault index was taken. A recompute can therefore never read a
 * fresh vault against a stale tag index, which is the pairing that would show
 * a note the vault has and the tags do not.
 */
export function createLazyTagIndex(build: () => TagIndex): TagIndex {
  let built: TagIndex | null = null;
  return {
    pathsMatching(tag: string): string[] {
      built ??= build();
      return built.pathsMatching(tag);
    },
  };
}
