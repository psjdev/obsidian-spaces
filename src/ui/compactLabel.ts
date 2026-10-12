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
 * with the tip's element squeezed to a client width of ZERO. Replacing the
 * leading folders with `..` is a change of parts and a change of roles, which
 * is all this module itself had to do.
 *
 * ONE FOLDER AT A TIME, which is the second thing the seam was for. The first
 * shipped shape shortened in one jump: a row that did not fit lost everything
 * above the tip's immediate parent, so a pane one character too narrow for
 * `Research/2026/Q4/Projects/Atlas/Design/Decisions` drew `../Design/
 * Decisions` and threw away five folder names to recover a few pixels. The
 * shape here instead drops leading folders one at a time and stops at the
 * first width that fits, so the row gives up exactly what the pane took and
 * nothing more. `drop` carries that count, the caller raises it until the row
 * fits, and the one-jump shape is just this one at its maximum.
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
 * label, measures it, and calls this module again with a higher `drop` for as
 * long as it does not fit. This module is handed the decision; it does not
 * make it.
 */

/**
 * What a part IS, so a stylesheet can treat them differently.
 *
 * `gap` is not a folder name. It stands in for the ones that were left out, so
 * a reader can tell "there was more above this" from a folder actually called
 * `..`, and so the stylesheet can draw it as the marker it is rather than as a
 * name that merely happens to be short.
 *
 * LABEL_ROLES is the runtime list, because a type is erased at build time and
 * a test cannot enumerate it. The type is DERIVED from it, so the two cannot
 * drift: a role exists in exactly one place.
 */
export const LABEL_ROLES = ["lead", "sep", "tip", "gap"] as const;
export type LabelRole = (typeof LABEL_ROLES)[number];

export interface LabelPart {
  /** The characters to draw. */
  text: string;
  /** What this part IS, so a stylesheet can treat the four differently. */
  role: LabelRole;
}

/**
 * The decision for ONE row: draw this run short, or draw it whole.
 *
 * `drop` is an instruction, not a permission. The caller has already drawn
 * this row at the level below and measured it against the pane, so by the time
 * it reaches here the question "does it fit" is answered. The only judgement
 * left in this module is the structural one below, which no measurement can
 * override.
 */
export interface CompactLabelOptions {
  /**
   * How many leading folders the `..` gap stands in for.
   *
   * Clamped here rather than trusted: `0` and anything below it draw the whole
   * run, and anything above `maxDrop` draws the shortest label this module
   * will produce. A caller climbing until a row fits can therefore ask for one
   * more than exists without checking first, and the floor stays structural.
   */
  drop: number;
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
 * The most this run will ever give up: everything above the tip and the folder
 * directly above it.
 *
 * TWO segments always survive, however badly the row overflows, and that is
 * structural rather than a consequence of any measurement. `Work/Shared` would
 * become `../Shared`, which is no shorter to read and trades a folder name the
 * reader can use for a glyph saying only "there was something here". A pane
 * narrow enough to clip `Work/Shared` is narrow enough to clip `../Shared`
 * too, so shortening buys that row nothing and costs it a name.
 *
 * Exported because the caller climbing toward a fit needs to know where the
 * climb ends -- a row still overflowing at `maxDrop` has nothing left to give
 * and must be left alone rather than measured again forever.
 */
export function maxDrop(segments: readonly string[]): number {
  return Math.max(0, segments.length - 2);
}

/**
 * The asked-for drop, brought inside what this run can actually give.
 *
 * Guarded HERE rather than at the call site so a count reached any other way
 * -- a later variant, a second caller of this module -- cannot produce a label
 * shorter than the floor above. A fractional or negative count is a caller
 * bug, and the useful response to one is the whole label rather than a throw
 * that blanks a row.
 */
function dropped(segments: readonly string[], opts: CompactLabelOptions): number {
  if (!Number.isFinite(opts.drop)) return 0;
  return Math.min(Math.max(0, Math.trunc(opts.drop)), maxDrop(segments));
}

export function compactLabel(
  segments: readonly string[],
  opts: CompactLabelOptions
): readonly LabelPart[] {
  const drop = dropped(segments, opts);
  const parts: LabelPart[] = [];
  // ONE gap for however many folders it stands in for. Two dots per dropped
  // folder would be a count the reader has to do arithmetic on, and the row
  // has no room for it -- the gap says "there was more above this", which is
  // all a reader can act on. The tooltip carries the rest.
  if (drop > 0) parts.push({ text: GAP, role: "gap" });
  const shown = segments.slice(drop);
  shown.forEach((name, i) => {
    if (i > 0 || drop > 0) parts.push({ text: "/", role: "sep" });
    parts.push({ text: name, role: i === shown.length - 1 ? "tip" : "lead" });
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
