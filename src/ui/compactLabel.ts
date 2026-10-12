/**
 * What a compacted row reads as, as parts rather than a finished string.
 *
 * THE EXPERIMENT SEAM. The rule for WHICH folders compact is settled and lives
 * in `visibility/compactChains.ts`. How the result reads is not, and is
 * expected to change after being looked at in a real vault. Keeping it here
 * means a variant that only changes which parts are produced and what role
 * each one has is this file, its test and a style rule, with nothing in the
 * sort seam moving. A variant that needs a new INPUT is a wider change, and
 * abbreviation below is the worked example of one.
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
 * a change of roles, which is all this module itself had to do.
 *
 * IT WAS NOT A ONE FILE CHANGE, and nothing here should be read as claiming
 * it was. Abbreviation also added a setting (`types.ts`, `schema.ts`,
 * `SettingsTab.ts`, `README.md`), a `gap` style rule, and -- the largest part
 * -- the measure, redraw and tooltip pass in `ExplorerAdapter`. What the seam
 * actually bought is the paragraph above: the SHAPE of a shortened label was
 * decided here and nowhere else.
 *
 * WHICH ROWS abbreviate is not decided here and never was decided well. It
 * was a count of folders, and a count of folders answers the wrong question:
 * two long names overflow a narrow pane just as a seven folder run does, and
 * under a count that row never shortened and so never carried the tooltip
 * either. The pane is the only thing that knows, so the ADAPTER draws the full
 * label, measures it, and calls this module again with `abbreviate` set when
 * it did not fit. This module is handed the decision; it does not make it.
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
 * The decision for ONE row: draw this run short, or draw it whole.
 *
 * `abbreviate` is an instruction, not a permission. The caller has already
 * drawn this row's full label and measured it against the pane, so by the time
 * it reaches here the question "does it fit" is answered. The only judgement
 * left in this module is the structural one below, which no measurement can
 * override.
 */
export interface CompactLabelOptions {
  /** Shorten this run, subject to the two-segment guard below. */
  abbreviate: boolean;
}

/**
 * What the USER chose, which is a different thing from the decision above.
 *
 * One setting, `abbreviateCompactedPaths`, and it now reads as "shorten a row
 * that does not fit". Someone who wants the whole path on every row whatever
 * it costs them turns it off, and then nothing is measured at all.
 *
 * Kept separate from `CompactLabelOptions` deliberately: one object meaning
 * "the user allows this" in one layer and "do this to this row" in the next is
 * how a permission gets applied as an instruction. They are two types, and
 * `applyCompactLabels` is the one place that turns one into the other.
 */
export interface CompactLabelPolicy {
  /** Whether a row whose label does not fit its pane may be shortened. */
  abbreviateWhenOverflowing: boolean;
}

/** What stands in for the folders that were left out. */
export const GAP = "..";

/**
 * Whether this run abbreviates.
 *
 * TWO segments never do, however badly the row overflows, and that is
 * structural rather than a consequence of any measurement. `Work/Shared` would
 * become `../Shared`, which is no shorter to read and trades a folder name the
 * reader can use for a glyph saying only "there was something here". A pane
 * narrow enough to clip `Work/Shared` is narrow enough to clip `../Shared`
 * too, so shortening buys that row nothing and costs it a name.
 *
 * Guarded HERE rather than at the call site so a decision reached any other
 * way -- a later variant, a second caller of this module -- cannot produce it.
 */
function abbreviates(segments: readonly string[], opts: CompactLabelOptions): boolean {
  if (!opts.abbreviate) return false;
  return segments.length > 2;
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
