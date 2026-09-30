/**
 * PRIVATE OBSIDIAN API — QUARANTINE MODULE.
 *
 * `MetadataCache.getTags()` is absent from `obsidian.d.ts` 1.13.1 while
 * existing at runtime. This is the ONLY place in the codebase that reaches for
 * it, so a future Obsidian change has exactly one repair point — the same
 * contract `nativeExplorerSort.ts` holds for the file explorer's sort and
 * `nativeMenuSubmenu.ts` holds for `MenuItem.setSubmenu()`. Nothing outside
 * this module may name `getTags`; verify with `grep -rn "getTags" src/`.
 *
 * The single repair point is worth MORE here than in the other quarantine
 * modules, not less. Those names are at least absent from the typings in a way
 * the compiler can be made to notice at the seam; this one is reached through
 * a cast, so the type system guards nothing and a grep is the whole defence.
 *
 * ## What is private, and what it is used for
 *
 * `getTags()` returns a record of tag to usage count, tags spelled with their
 * leading `#`. It backs the add-a-tag field's candidate list and nothing else.
 * Whether it merges frontmatter and inline tags has NOT been verified, and it
 * does not need to be: a miss costs a suggestion, never a wrong result.
 * Membership itself is decided by `getAllTags` in `ObsidianTagIndex.ts`, which
 * is public and does read both.
 *
 * ## Fail-open
 *
 * `nativeKnownTags` returns null whenever the capability is not exactly as
 * expected, and callers must treat null as "no candidates", never as "the
 * vault has no tags". A future Obsidian release that renames or removes the
 * method therefore costs the dropdown and leaves the field a plain input that
 * still adds whatever is typed into it.
 */

/** The shape we hope for, expressed so no `any` escapes this file. */
interface MaybeTagCounts {
  metadataCache?: {
    getTags?: unknown;
  };
}

/**
 * Every tag Obsidian knows about, in whatever spelling it hands them over, or
 * null when this build cannot say.
 *
 * `app` is `unknown` so this file imports no Obsidian types, matching
 * `nativeExplorerSort.ts`. Every step is checked rather than assumed: a future
 * `getTags` that exists but returns a string, a promise or null would
 * otherwise reach `Object.keys` and throw on a keystroke, turning a missing
 * dropdown into a dead field.
 */
export function nativeKnownTags(app: unknown): string[] | null {
  if (typeof app !== "object" || app === null) return null;
  const cache = (app as MaybeTagCounts).metadataCache;
  if (typeof cache !== "object" || cache === null) return null;
  const method = cache.getTags;
  if (typeof method !== "function") return null;
  try {
    const counts: unknown = (method as () => unknown).call(cache);
    if (typeof counts !== "object" || counts === null) return null;
    return Object.keys(counts);
  } catch {
    // Private API: a throw here is exactly what this module exists to absorb,
    // and the caller has a plain-input path to fall back on.
    return null;
  }
}
