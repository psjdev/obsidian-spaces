import { createMapTagIndex, pathsByTag, type TagIndex } from "../../src/visibility/TagIndex";

/**
 * A `TagIndex` built from a path -> tags literal.
 *
 * The index itself is keyed the other way round, tag -> paths, because that
 * makes a lookup a lookup. A TEST is almost always easier to read the other
 * way round again: "this note carries these tags" is how the vault is
 * described, and how `getAllTags` reports it, so writing the fixture as the
 * inverted map would make every one of these tests state its input in the
 * shape of the implementation rather than the shape of the vault.
 *
 * Runs the real `pathsByTag`, so a fixture built here goes through the same
 * normalization, ancestor expansion and duplicate guard the plugin uses. A
 * hand-written inverted map would not, and would quietly stop testing them.
 */
export function tagIndexOf(byPath: Map<string, string[]>): TagIndex {
  return createMapTagIndex(
    pathsByTag(
      [...byPath],
      ([path]) => path,
      ([, tags]) => tags
    )
  );
}
