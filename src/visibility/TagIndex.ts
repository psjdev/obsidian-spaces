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
 * A linear scan per lookup, and a deliberate choice rather than an untested
 * assumption. A space holds a handful of tag members, so this is a handful of
 * passes over the vault's TAGGED notes per recompute (`tagsByPath` stores no
 * entry for an untagged one).
 *
 * ## Inverting this map is measured, viable, and the known next step
 *
 * This comment used to claim inversion "would not help without also expanding
 * every ancestor tag of every note, since nested tags match", and told the
 * reader to measure before changing it while being itself unmeasured. It was
 * wrong, and a wrong reason is worse than no comment: the next person budgets
 * against it. It has now been measured in a real Obsidian on a generated
 * 10,000 note vault (4,000 tagged, 6,276 tag instances, 442 distinct tags),
 * every prototype A/B'd against the live plugin across all tags with zero
 * mismatches:
 *
 * | | build | query `inbox` |
 * |---|---|---|
 * | this map, path -> tags | 12.1 ms | 0.514 ms |
 * | inverted, ancestors expanded inline | 13.5 ms | |
 * | inverted, ancestor chain memoised per tag spelling | **12.0 ms** | **0.00008 ms** |
 * | inverted, no expansion, union children at query | 12.5 ms | 0.316 ms |
 *
 * Expansion costs three extra map keys and ~35 KB, because tag depth is 3.
 * Memoising the ancestor chain per distinct spelling makes the inverted build
 * FREE against this one, and the lookup 6,400x faster.
 *
 * It is not done here because it does nothing for STARTUP, which is this
 * plugin's stated priority: the build still walks every file, since you
 * cannot bucket tags you have not read. 23x on 0.6 ms of a 6.6 ms warm
 * recompute is 9 %, and 3 % at 100k notes. So it is held for a change of its
 * own rather than folded into a startup pass.
 *
 * ## The trap whoever does it must handle
 *
 * With ancestors expanded at build, a note carrying BOTH `project` and
 * `project/atlas` lands in the `project` bucket twice. `resolveMembers`
 * dedupes, so the tree would look right — but `SettingsTab` and
 * `SpaceContentsModal` call `pathsMatching(tag).length` directly, so the
 * count shown to the user would over-count. An adjacent-duplicate guard
 * (`if (arr[arr.length - 1] !== path)`) suffices, because all of one file's
 * tags are processed together and the duplicates are therefore always
 * adjacent. A reimplementation that omits it is wrong in exactly the case
 * least likely to be tested: nested tags, on a note carrying parent and child.
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
 * The map `createMapTagIndex` scans, built from a file list, a path accessor
 * and a per-file tag lookup.
 *
 * Generic over the file so the Obsidian caller can hand it `TFile`s straight
 * from the vault walk: a version taking paths would have made it look every
 * file up again, which is the O(vault^2) this whole index exists to avoid.
 *
 * Pure and injected, for the same reason `createTreeVaultIndex` lives beside
 * its interface rather than inside `ObsidianVaultIndex`: what goes INTO the
 * map is a decision, and a decision belongs where plain node can exercise it.
 * `createObsidianTagIndex` keeps only the parts that need the Obsidian
 * runtime — the vault walk and `getAllTags`.
 *
 * AN UNTAGGED NOTE GETS NO ENTRY. `pathsMatching` can never emit one, so an
 * entry for it is bytes and loop iterations that cannot be part of any
 * answer. On the measured 10,000 note vault, 6,000 notes carry no tags: those
 * entries were 41.3 % of the structure's 613 KB, and a miss scan was 2.1x
 * slower for carrying them. Skipping them takes the scan from 10,000
 * iterations to 4,000 and changes no answer.
 *
 * `tagsOf` returns null for a note with no usable metadata — which is EVERY
 * note before Obsidian's metadata cache has parsed it — and that is treated
 * exactly like an untagged one here. Telling those two apart is the caller's
 * job, not this map's; see `SpaceController`'s cold-cache fall-open.
 */
export function tagsByPath<T>(
  files: Iterable<T>,
  pathOf: (file: T) => string,
  tagsOf: (file: T) => readonly string[] | null
): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const file of files) {
    const tags = tagsOf(file);
    if (tags === null || tags.length === 0) continue;
    byPath.set(pathOf(file), tags.map(normalizeTag));
  }
  return byPath;
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
