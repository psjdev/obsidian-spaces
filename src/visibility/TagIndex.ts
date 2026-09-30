import { normalizeTag } from "./tagMatch";

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
 * A `TagIndex` over a tag to paths map.
 *
 * Pure, so it runs in plain node. `ObsidianTagIndex` builds the map from the
 * metadata cache and hands it here, which is the same division
 * `createTreeVaultIndex` and `createObsidianVaultIndex` already use.
 *
 * A lookup, not a scan. Nesting is resolved at BUILD time: `pathsByTag` files
 * a note carrying `project/atlas` under `project` as well, so the bucket for
 * a tag already holds everything `tagMatches` would have accepted for it and
 * there is nothing left to test per query. `tagMatches` remains the
 * definition of that relation, and `tests/pathsByTag.test.ts` pins the
 * expansion against it directly rather than against a restatement of it.
 *
 * Measured in a real Obsidian on a generated 10,000 note vault (4,000 tagged,
 * 6,276 tag instances, 442 distinct tags), interleaved A/B against the live
 * plugin across all tags with zero mismatches:
 *
 * | | build | query `inbox` |
 * |---|---|---|
 * | the path -> tags map this replaces | 12.1 ms | 0.514 ms |
 * | inverted, ancestors expanded inline | 13.5 ms | |
 * | inverted, ancestor chain memoised per spelling | **12.0 ms** | **0.00008 ms** |
 * | inverted, no expansion, union children at query | 12.5 ms | 0.316 ms |
 *
 * Expansion costs three extra map keys and ~35 KB, because tag depth is 3,
 * and memoising the chain per distinct spelling makes the build free against
 * the map it replaces. Deferring expansion to the query is the row that does
 * not pay.
 *
 * ## Why this is not the throughput change it looks like
 *
 * The tag lookup is 4.2 to 5.5 % of a tag space's recompute: 0.4 ms of 9.6 ms
 * for one tag over 1,213 notes, 1.7 ms of 31 ms for three over 3,371. A
 * perfect inversion takes that second case to 29.3 ms. It is here for 60 %
 * fewer entries, for a comment that used to state something false about why
 * inversion could not work, and because it is the precondition if incremental
 * per-file maintenance is ever wanted. The snapshot's ancestor closure, at 73
 * to 81 % of every snapshot, is where the recompute time actually is.
 *
 * ## The trap, handled in `pathsByTag`
 *
 * With ancestors expanded at build, a note carrying BOTH `project` and
 * `project/atlas` would land in the `project` bucket twice. `resolveMembers`
 * dedupes, so the tree would still look right, but `SettingsTab` and
 * `SpaceContentsModal` call `pathsMatching(tag).length` directly, so the count
 * shown to the user would over-count. Guarded there, and pinned by a test,
 * because it is wrong in exactly the case least likely to be noticed: nested
 * tags, on a note carrying parent and child.
 *
 * The array is copied out rather than handed over. Callers sort what they get
 * (the tests do), and a caller that sorted the live bucket would silently
 * reorder the index for everyone after it. That copy is now the whole cost of
 * a lookup.
 */
export function createMapTagIndex(byTag: Map<string, string[]>): TagIndex {
  return {
    pathsMatching(tag: string): string[] {
      const want = normalizeTag(tag);
      if (want.length === 0) return [];
      const hit = byTag.get(want);
      return hit === undefined ? [] : [...hit];
    },
  };
}

/**
 * Every tag a note carrying `tag` is findable under: the tag itself and each
 * of its ancestors. `project/atlas/v1` gives those three names, which is
 * exactly the set of `member` values for which `tagMatches(member, tag)`
 * holds.
 *
 * An empty segment is skipped, so a malformed `/x` files only under `/x` and
 * never under the empty string, which `pathsMatching` rejects before it ever
 * looks.
 */
function tagChain(tag: string): string[] {
  const out = [tag];
  for (let i = tag.indexOf("/"); i !== -1; i = tag.indexOf("/", i + 1)) {
    if (i > 0) out.push(tag.slice(0, i));
  }
  return out;
}

/**
 * The map `createMapTagIndex` looks up, built from a file list, a path
 * accessor and a per-file tag lookup.
 *
 * Generic over the file so the Obsidian caller can hand it `TFile`s straight
 * from the vault walk: a version taking paths would have made it look every
 * file up again, which is the O(vault^2) this whole index exists to avoid.
 *
 * Pure and injected, for the same reason `createTreeVaultIndex` lives beside
 * its interface rather than inside `ObsidianVaultIndex`: what goes INTO the
 * map is a decision, and a decision belongs where plain node can exercise it.
 * `createObsidianTagIndex` keeps only the parts that need the Obsidian
 * runtime, the vault walk and `getAllTags`.
 *
 * AN UNTAGGED NOTE GETS NO ENTRY, and now cannot have one: it contributes to
 * no bucket at all. On the measured 10,000 note vault, 6,000 notes carry no
 * tags, and they were 60 % of the map this replaces.
 *
 * `tagsOf` returns null for a note with no usable metadata, which is EVERY
 * note before Obsidian's metadata cache has parsed it, and that is treated
 * exactly like an untagged one here. Telling those two apart is the caller's
 * job, not this map's; see `SpaceController`'s cold-cache fall-open.
 *
 * `chains` memoises the ancestor expansion per distinct tag SPELLING rather
 * than per tag instance. On the measured vault that is 442 chains for 6,276
 * instances, and it is what makes this build cost the same as the path-keyed
 * one it replaces rather than 1.4 ms more.
 *
 * The duplicate guard is what lets a note carry both `project` and
 * `project/atlas` without being counted twice under `project`. It compares
 * against the last element only, which suffices because all of ONE file's
 * tags are pushed before any other file's: two entries for the same path in
 * the same bucket can therefore only ever be adjacent. Anything that made
 * this loop interleave files would break that argument and need a Set.
 *
 * Insertion order within a bucket is vault-walk order, which is the order the
 * scan this replaces returned its hits in, so no caller sees a reordering.
 */
export function pathsByTag<T>(
  files: Iterable<T>,
  pathOf: (file: T) => string,
  tagsOf: (file: T) => readonly string[] | null
): Map<string, string[]> {
  const byTag = new Map<string, string[]>();
  const chains = new Map<string, string[]>();
  for (const file of files) {
    const tags = tagsOf(file);
    if (tags === null || tags.length === 0) continue;
    const path = pathOf(file);
    for (const raw of tags) {
      const tag = normalizeTag(raw);
      if (tag.length === 0) continue;
      let chain = chains.get(tag);
      if (chain === undefined) {
        chain = tagChain(tag);
        chains.set(tag, chain);
      }
      for (const name of chain) {
        let arr = byTag.get(name);
        if (arr === undefined) {
          arr = [];
          byTag.set(name, arr);
        }
        if (arr[arr.length - 1] !== path) arr.push(path);
      }
    }
  }
  return byTag;
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
