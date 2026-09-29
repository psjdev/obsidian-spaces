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
