/**
 * What a compacted row reads as, as parts rather than a finished string.
 *
 * THE EXPERIMENT SEAM. The rule for WHICH folders compact is settled and lives
 * in `visibility/compactChains.ts`. How the result reads is not, and is
 * expected to change after being looked at in a real vault. Keeping it here
 * means a variant is this file, its test and a style rule, with nothing in the
 * sort seam or the adapter moving.
 *
 * PARTS, NOT A STRING, and that is the whole point. Two of the presentations
 * worth trying -- muted separators, and the leading folders dimmed with the
 * last at full strength -- are about drawing the pieces differently, which a
 * single string cannot carry. A consumer handed one would have to split it
 * back apart on "/" to style it, which is both fragile (a variant's glyph or
 * ellipsis is not "/") and the exact thing this seam exists to prevent: it
 * would put presentation logic in the adapter, where swapping it is no longer
 * cheap. Roles let the adapter render mechanically and a stylesheet do the
 * rest.
 *
 * `/` rather than a glyph: it is what the vault calls this, what Obsidian's
 * own quick switcher shows, and the one separator a reader does not have to
 * learn.
 */

export interface LabelPart {
  /** The characters to draw. */
  text: string;
  /** What this part IS, so a stylesheet can treat the three differently. */
  role: "lead" | "sep" | "tip";
}

export function compactLabel(segments: readonly string[]): readonly LabelPart[] {
  const parts: LabelPart[] = [];
  segments.forEach((name, i) => {
    if (i > 0) parts.push({ text: "/", role: "sep" });
    parts.push({ text: name, role: i === segments.length - 1 ? "tip" : "lead" });
  });
  return parts;
}
