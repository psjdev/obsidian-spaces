import { hasOwnKey, normalizeValue } from "./propertyValues";

/**
 * Which notes carry which properties, as a SNAPSHOT.
 *
 * Same contract as `TagIndex`: pure, node-testable, built by an adapter that
 * owns the Obsidian runtime. One recompute sees one consistent picture.
 *
 * KEYS EAGERLY, VALUES ON DEMAND. The key map is built with the walk; a key's
 * value buckets are built the first time that key is asked about and memoized
 * for the life of the snapshot. A space naming one key pays for one key, and a
 * `due` date with a distinct value per note costs nothing until someone opens
 * it. This is the one place this index deliberately differs from the tag
 * index, which has few tags per note and can afford to file them all.
 *
 * The laziness bounds WORK, not memory. The key map holds a path list per key,
 * so it is bounded by total key occurrences across the vault.
 */
export interface PropertyIndex {
  /** Which snapshot this answer came from. Readers compare it; they never ignore it. */
  readonly generation: number;
  pathsWithKey(key: string): string[];
  pathsMatching(key: string, value: string): string[];
  listKeys(): Array<{ key: string; count: number }>;
  listValues(key: string): Array<{ value: string; normalized: string; count: number }>;
}

/**
 * Readiness as a SHAPE, so an empty array can never secretly mean "the cache
 * is cold". A caller that has not checked cannot query.
 */
export type PropertySnapshot =
  | { status: "unavailable" }
  | { status: "ready"; index: PropertyIndex };

interface Bucket {
  /** The spelling to draw, from the lexicographically first path. */
  value: string;
  paths: string[];
}

export function createPropertyIndex(
  entries: Iterable<{ path: string; frontmatter: Record<string, unknown> }>,
  generation: number
): PropertyIndex {
  // Captured, not referenced. The metadata cache mutates its own objects in
  // place, and a lazy value map built later would then read new contents under
  // an old generation without anything saying so.
  const byKey = new Map<string, string[]>();
  const captured = new Map<string, Array<{ path: string; raw: unknown }>>();

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, frontmatter } of sorted) {
    if (frontmatter === null || typeof frontmatter !== "object") continue;
    for (const key of Object.keys(frontmatter)) {
      if (!hasOwnKey(frontmatter, key)) continue;
      let paths = byKey.get(key);
      if (paths === undefined) {
        paths = [];
        byKey.set(key, paths);
        captured.set(key, []);
      }
      paths.push(path);
      // The raw value is copied one level: an array is re-sliced so a later
      // push cannot reach it, and a scalar is already a value. One level is
      // sound only while non-scalar entries (objects, nested arrays) offer no
      // values: they are held by reference here and never read.
      const raw = frontmatter[key];
      captured.get(key)!.push({ path, raw: Array.isArray(raw) ? [...(raw as unknown[])] : raw });
    }
  }

  const buckets = new Map<string, Map<string, Bucket>>();
  const bucketsFor = (key: string): Map<string, Bucket> => {
    let found = buckets.get(key);
    if (found !== undefined) return found;
    found = new Map<string, Bucket>();
    // Paths arrive in sorted order, so the first spelling seen for a bucket is
    // the one on the lexicographically first path. Deterministic within a
    // snapshot without depending on walk order.
    for (const { path, raw } of captured.get(key) ?? []) {
      const spellings: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [raw];
      for (const one of spellings) {
        // Only direct scalars are values, the same rule as `valuesOf`; this
        // builder keeps the authored spelling, which `valuesOf` discards.
        if (typeof one !== "string" && typeof one !== "number" && typeof one !== "boolean") continue;
        const spelling = String(one);
        const normalized = normalizeValue(spelling);
        let bucket = found.get(normalized);
        if (bucket === undefined) {
          bucket = { value: spelling, paths: [] };
          found.set(normalized, bucket);
        }
        // Entries are walked in sorted path order and one note's spellings are
        // consecutive, so a repeat of this note can only be the path pushed
        // last. Comparing against it is O(1); do not replace it with
        // `includes`, which is quadratic in the bucket size.
        if (bucket.paths[bucket.paths.length - 1] !== path) bucket.paths.push(path);
      }
    }
    buckets.set(key, found);
    return found;
  };

  return {
    generation,
    pathsWithKey: (key) => [...(byKey.get(key) ?? [])],
    pathsMatching: (key, value) => [...(bucketsFor(key).get(normalizeValue(value))?.paths ?? [])],
    listKeys: () =>
      [...byKey.entries()]
        .map(([key, paths]) => ({ key, count: paths.length }))
        .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    listValues: (key) =>
      [...bucketsFor(key).entries()]
        .map(([normalized, b]) => ({ value: b.value, normalized, count: b.paths.length }))
        .sort((a, b) => b.count - a.count || (a.normalized < b.normalized ? -1 : 1)),
  };
}
