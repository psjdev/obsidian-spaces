/**
 * Tag comparison, pure. No DOM, no `"obsidian"` import, so it runs in plain
 * node like the rest of `visibility/`.
 *
 * Tags are stored without a leading `#`, so one spelling reaches the
 * comparison and the document holds one form.
 */

/**
 * The stored form of a tag: no leading `#`, lowercased, trimmed.
 *
 * Lowercased because the rest of the plugin compares paths case-insensitively
 * (`canonicalPath`, `glob.ts`), and a tag that matched case-sensitively while
 * a path did not would be a difference nobody asked for. Whether Obsidian's
 * own tag matching is case-insensitive has NOT been checked; if it turns out
 * to be case-sensitive this is the one function to revisit.
 *
 * Only one `#` is dropped. A tag cannot contain `#`, so a second one is a
 * typo, and keeping it makes the typo visible in the member list rather than
 * silently matching something else.
 */
export function normalizeTag(raw: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return bare.toLowerCase();
}

/**
 * Whether a note carrying `noteTag` belongs to a space holding `member`.
 *
 * Nested tags always match, which is what Obsidian's own search does for
 * `tag:#project`. There is no stored flag and no setting.
 *
 * The `/` in the second test is the whole correctness argument: a bare
 * `startsWith` would put a note tagged `project` into a space whose member is
 * `proj`, because the segment boundary is what separates a child tag from an
 * unrelated one that shares a prefix.
 *
 * Both arguments must already be normalized. Normalizing here instead would
 * run on every note for every member on every recompute.
 */
export function tagMatches(member: string, noteTag: string): boolean {
  return noteTag === member || noteTag.startsWith(member + "/");
}
