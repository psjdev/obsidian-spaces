/**
 * What a compacted row reads as.
 *
 * THE EXPERIMENT SEAM. The rule for WHICH folders compact is settled and lives
 * in `visibility/compactChains.ts`. How the result reads is not, and is
 * expected to change after being looked at in a real vault. Keeping it here
 * means a variant is this file, its test and a style rule, with nothing in the
 * sort seam or the adapter moving. A variant that needs to touch either of
 * those is not a presentation variant and belongs in its own design.
 *
 * `/` rather than a glyph: it is what the vault calls this, what Obsidian's
 * own quick switcher shows, and the one separator a reader does not have to
 * learn.
 */
export function compactLabel(segments: readonly string[]): string {
  return segments.join("/");
}
