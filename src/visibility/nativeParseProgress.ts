/**
 * PRIVATE OBSIDIAN API — QUARANTINE MODULE.
 *
 * `MetadataCache.inProgressTaskCount` is absent from `obsidian.d.ts` 1.13.x
 * while existing at runtime. This is the ONLY place in the codebase that
 * reaches for it, so a future Obsidian change has exactly one repair point —
 * the contract `nativeTagCounts.ts` holds for `getTags()`,
 * `nativeExplorerSort.ts` for the file explorer's sort and
 * `nativeMenuSubmenu.ts` for `MenuItem.setSubmenu()`. Nothing outside this
 * module may name `inProgressTaskCount`; verify with
 * `grep -rn "inProgressTaskCount" src/`.
 *
 * ## What is private, and what it is used for
 *
 * How many files Obsidian still has queued to parse. Measured on 1.13.7, on
 * four separately jammed instances: it equalled the count of files reporting
 * `null` from `getFileCache` in EVERY reading, and never fell once a jam
 * formed. The metadata cache carries exactly three scalars in that build —
 * `inProgressTaskCount`, `initialized`, `userIgnoreFiltersString` — and this
 * is the only one that distinguishes "still working" from "stopped".
 *
 * It backs the stall decision in `lifecycle/parseStall.ts` and nothing else.
 * It never decides what a space CONTAINS; it decides when to go and look.
 *
 * ## Why not `resolved`, or `initialized`, or the plugin's `metadataReady`
 *
 * Because all three say yes on a vault that will never finish. Measured, with
 * a listener registered from a plugin's own `onload`: `resolved` fired at
 * +167 ms with TWELVE files still queued, and again at +570 ms with eleven —
 * and then not once in the following 10.8 minutes, with 14 of 18 files still
 * null. `initialized` is true on every jammed instance from about a second
 * after start. `metadataReady` answers true by both of its routes.
 *
 * So "Obsidian says it is finished and we are not" — which is what the design
 * originally proposed as the trigger — would fire during an ORDINARY cold
 * start, because `resolved` arrives mid-index. This counter is what separates
 * the two cases: mid-index it is falling, jammed it is not.
 *
 * ## Fail-open
 *
 * `nativeParseProgress` returns null whenever the capability is not exactly as
 * expected, and callers must treat null as "this build cannot say", never as
 * zero. A future Obsidian that renames or removes the field therefore costs
 * the automatic repair and leaves the feature exactly where it is today: a
 * jammed vault reports unavailable, which is wrong but honest.
 */

/** The shape we hope for, expressed so no `any` escapes this file. */
interface MaybeParseProgress {
  metadataCache?: {
    inProgressTaskCount?: unknown;
  };
}

/**
 * How many files Obsidian still has queued, or null when this build cannot
 * say.
 *
 * `app` is `unknown` so this file imports no Obsidian types, matching
 * `nativeTagCounts.ts`. Every step is checked rather than assumed: a future
 * field that exists but holds a string, a getter that throws, `NaN` or a
 * negative number would otherwise be compared against the previous sample and
 * silently read as "no progress", which is the one reading that makes this
 * code DO something.
 */
export function nativeParseProgress(app: unknown): number | null {
  if (typeof app !== "object" || app === null) return null;
  const cache = (app as MaybeParseProgress).metadataCache;
  if (typeof cache !== "object" || cache === null) return null;
  try {
    const count: unknown = cache.inProgressTaskCount;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
    return count;
  } catch {
    // Private API: a throw here is exactly what this module exists to absorb,
    // and the caller's fallback is to do nothing at all.
    return null;
  }
}
