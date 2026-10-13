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
 * The laziness bounds WORK, not memory, and the walk fills TWO maps rather
 * than one. `byKey` holds a path list per key and `captured` holds the raw
 * value per key occurrence — including a copy of every array-valued entry in
 * the vault, whether or not anyone opens that key — so both are bounded by
 * total key occurrences across the vault. `buckets`, and the sorted list
 * memoized beside it, are a third structure that grows as keys are expanded;
 * a key's captured entries are released once its buckets exist, so an
 * expanded key is not held twice. The 0.77 MB measured cold on a 5,000-note
 * fixture is all of them together, not the key map alone.
 */
export interface PropertyIndex {
  /**
   * Which snapshot this answer came from.
   *
   * CARRIED, NOT COMPARED. It said "readers compare it; they never ignore
   * it", and no reader exists: the only reads anywhere are two tests
   * asserting the field is carried. It is threaded from `main.ts`, which
   * stamps each installed snapshot with the next number, so a future
   * staleness check — "is the answer I am holding from the snapshot in
   * force?" — has a hook that does not need the walk or the install path
   * changed to get one. Nothing compares it TODAY. Keep this sentence true:
   * a comment claiming a check nobody runs is worse than a field nobody
   * reads, because it is the one a reviewer believes.
   */
  readonly generation: number;
  pathsWithKey(key: string): string[];
  pathsMatching(key: string, value: string): string[];
  /**
   * Every key the walk saw, busiest first and ties broken by name.
   *
   * Memoized and handed out, not copied, which is why it is readonly: no
   * production caller displays this order — the picker re-sorts by name
   * (`pickableKeys`) and the contents dialog reduces it to a `Set` — so the
   * order here is only a deterministic one, and the memo is what stops the
   * sort being redone on every draw and so on every keystroke in the filter
   * box.
   */
  listKeys(): ReadonlyArray<PropertyKeyCount>;
  listValues(key: string): ReadonlyArray<PropertyValueCount>;
}

/** One row of `listKeys`. Readonly through, because the rows are the memo's own. */
export interface PropertyKeyCount {
  readonly key: string;
  readonly count: number;
}

/**
 * One row of `listValues`. Readonly through: `ReadonlyArray` alone stops a
 * caller sorting or pushing, and not a write to `rows[0].count`, which would
 * corrupt what every later reader of the memo sees.
 */
export interface PropertyValueCount {
  /** The spelling the note's author used. */
  readonly value: string;
  readonly normalized: string;
  readonly count: number;
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
      // BELT AND BRACES, and said so rather than left to read as the guard.
      // `Object.keys` returns own enumerable string keys only, so this cannot
      // be false here: the protection the docblock on `hasOwnKey` describes
      // is delivered on this path by the enumeration above and by every map
      // below being a `Map`, not by this call. It is kept as the one spelling
      // of the own-key rule, so a later source of keys cannot slip past
      // without the rule being written a second time.
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

  /**
   * THE VALUE RULE. The only copy: what a frontmatter entry OFFERS as
   * matchable values, keyed on the normalized text and drawn in the spelling
   * the note's author used. The spec's boundary table is driven through this,
   * in `tests/propertyValues.test.ts`.
   *
   * Only DIRECT scalars are values. `null` and `undefined` offer NOTHING
   * rather than the text "null": `String(null)` is `"null"`, so the naive
   * rule files every blank property under a value a member could ask for, and
   * a blank property is among the commonest shapes in a real vault. An array
   * offers its direct scalar entries and is never stringified whole, because
   * `String(["atlas","billing"])` is `"atlas,billing"`, which would match a
   * member asking for exactly that. A nested array, an object or a null
   * inside a list contributes nothing, so the rule is one level deep.
   *
   * NO `Date` BRANCH. No probe produced one on this path — `date: 2026-08-31`
   * arrives as the string `"2026-08-31"` — and a branch with no input to
   * exercise it is behavior nobody can check. The shapes were measured by
   * planting frontmatter in a running Obsidian 1.13.7 and reading
   * `metadataCache.getFileCache().frontmatter` back; the planted note is in
   * the spec so the probe can be repeated. Add a branch deliberately if a
   * later Obsidian produces a `Date`, with a UTC-or-local rule decided then.
   */
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
    // Released once the buckets exist. The memo check above returns first
    // from here on, so this key's captured raws are never read again, and
    // holding both doubled the retained cost of an expanded key (0.77 MB to
    // 1.36 MB on the 5,000-note fixture after opening `created`). `byKey`
    // still answers `pathsWithKey`, which is a different map.
    captured.delete(key);
    return found;
  };

  // Memoized beside the buckets, and for the same reason. `bucketsFor` stops
  // the WALK being repeated; this stops the mapping and the SORT being
  // repeated, which the picker pays per open key per draw and therefore per
  // keystroke in its filter box. On the branch's own 5,000-note fixture
  // `created` holds 4,035 distinct values: one sort of those to show the
  // first 200, not one per keystroke.
  //
  // The memo is handed out, not copied, which is why the rows are readonly
  // through `PropertyValueCount`: they are the snapshot's own, and a caller
  // that sorted the array in place — or wrote to a row's `count` — would
  // change what every later reader sees.
  const listed = new Map<string, ReadonlyArray<PropertyValueCount>>();
  const listValues = (key: string): ReadonlyArray<PropertyValueCount> => {
    let found = listed.get(key);
    if (found !== undefined) return found;
    found = [...bucketsFor(key).entries()]
      .map(([normalized, b]) => ({ value: b.value, normalized, count: b.paths.length }))
      .sort((a, b) => b.count - a.count || (a.normalized < b.normalized ? -1 : 1));
    listed.set(key, found);
    return found;
  };

  // Memoized for the reason the value list is: both production callers throw
  // this order away — `pickableKeys` re-sorts by name and the contents dialog
  // builds a `Set` — but the picker asks on every draw, so the key list was
  // built and sorted once per keystroke to be sorted again straight after.
  let keysListed: ReadonlyArray<PropertyKeyCount> | null = null;
  const listKeys = (): ReadonlyArray<PropertyKeyCount> => {
    if (keysListed !== null) return keysListed;
    keysListed = [...byKey.entries()]
      .map(([key, paths]) => ({ key, count: paths.length }))
      .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return keysListed;
  };

  return {
    generation,
    pathsWithKey: (key) => [...(byKey.get(key) ?? [])],
    pathsMatching: (key, value) => [...(bucketsFor(key).get(normalizeValue(value))?.paths ?? [])],
    listKeys,
    listValues,
  };
}
