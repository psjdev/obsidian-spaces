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
 *
 * ABBREVIATION arrived through this same seam, which is what it was for. The
 * joined label of a deep run overflows a narrow pane, and `text-overflow:
 * ellipsis` truncates from the RIGHT -- so the tip, the one segment that says
 * which folder the row IS, is the first thing lost. Measured in a real vault
 * at a 246px pane: `Research/2026/Q4/Projects/Atlas/Design/Decisions` rendered
 * with the tip's element squeezed to a client width of ZERO. Collapsing
 * everything above the tip's immediate parent to `..` is a change of parts and
 * a change of roles, and nothing outside this file and its stylesheet moved.
 */

/**
 * What a part IS, so a stylesheet can treat them differently.
 *
 * `gap` is not a folder name. It stands in for the ones that were left out, so
 * a reader can tell "there was more above this" from a folder actually called
 * `..`, and so the stylesheet can draw it as the marker it is rather than as a
 * name that merely happens to be short.
 */
export type LabelRole = "lead" | "sep" | "tip" | "gap";

export interface LabelPart {
  /** The characters to draw. */
  text: string;
  /** What this part IS, so a stylesheet can treat the four differently. */
  role: LabelRole;
}

/**
 * Whether to shorten a long run, and how long is long.
 *
 * `threshold` is a NUMBER here, while the setting stores a string: the
 * settings tab offers only `toggle` and `dropdown`, and a dropdown's value is
 * a string. The conversion happens once, where the setting is read, so this
 * module never has to care that a control shaped it.
 */
export interface CompactLabelOptions {
  abbreviate: boolean;
  /** Abbreviate when the run has MORE THAN this many folders. */
  threshold: number;
}

/** What stands in for the folders that were left out. */
export const GAP = "..";

/**
 * Whether this run abbreviates.
 *
 * TWO segments never do, whatever the threshold, and that is structural rather
 * than a consequence of the dropdown's lowest option. `Work/Shared` would
 * become `../Shared`, which is no shorter to read and trades a folder name the
 * reader can use for a glyph saying only "there was something here". Guarded
 * here so a threshold reached any other way -- a hand-edited document, a later
 * control, a caller of this module -- cannot produce it.
 *
 * MORE THAN, not at least: a run of exactly `threshold` folders is left in
 * full, so the number a user picks reads as "runs longer than this".
 */
function abbreviates(segments: readonly string[], opts: CompactLabelOptions): boolean {
  if (!opts.abbreviate) return false;
  if (segments.length <= 2) return false;
  return segments.length > opts.threshold;
}

export function compactLabel(
  segments: readonly string[],
  opts: CompactLabelOptions
): readonly LabelPart[] {
  if (abbreviates(segments, opts)) {
    // "Parent only": the tip and the folder directly above it, which is the
    // smallest pair that still says where in the vault this row sits. Anything
    // above them is what the pane had no room for in the first place.
    return [
      { text: GAP, role: "gap" },
      { text: "/", role: "sep" },
      { text: segments[segments.length - 2], role: "lead" },
      { text: "/", role: "sep" },
      { text: segments[segments.length - 1], role: "tip" },
    ];
  }
  const parts: LabelPart[] = [];
  segments.forEach((name, i) => {
    if (i > 0) parts.push({ text: "/", role: "sep" });
    parts.push({ text: name, role: i === segments.length - 1 ? "tip" : "lead" });
  });
  return parts;
}

/**
 * Whether a label left something out, asked of the parts rather than
 * recomputed from the options.
 *
 * The adapter needs this to decide whether the row gets a tooltip carrying the
 * full path, and asking the parts means one rule decides both. A variant that
 * elides differently -- from the middle, say -- gets the tooltip for free, and
 * one that stops eliding cannot leave a stale attribute behind.
 */
export function isAbbreviated(parts: readonly LabelPart[]): boolean {
  return parts.some((p) => p.role === "gap");
}
