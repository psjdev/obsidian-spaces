import { getFrontMatterInfo, parseYaml } from "obsidian";

/**
 * Reading a file's frontmatter OURSELVES, for the files Obsidian has not
 * parsed.
 *
 * ## Why this is allowed to exist
 *
 * Property members read exactly one thing out of a cache entry:
 * `cache.frontmatter`. Headings, links, embeds, sections and list items are
 * never touched. The whole-file parse is Obsidian's cost of producing an
 * entry, not our requirement for reading one — and `getFileCache` is
 * all-or-nothing per file, so a 33 MB note whose properties sit in its first
 * 200 bytes gives us nothing until Obsidian has finished with the other
 * 32.99 MB. Measured: it does not finish. See `ObsidianPropertyIndex.ts`.
 *
 * ## Why it does not diverge from the cache
 *
 * `getFrontMatterInfo` and `parseYaml` are Obsidian's OWN, exported from
 * `obsidian.d.ts`. Using them means the shapes this feature depends on come
 * out identical because they are produced by identical code: `pad: 02` as the
 * number 2, `date: 2026-08-31` as the string, `blank:` as null, a list as an
 * Array.
 *
 * Verified rather than assumed, on Obsidian 1.13.7 against the real 5,000-note
 * property fixture: `cache.frontmatter` compared with
 * `parseYaml(getFrontMatterInfo(text).frontmatter)` for every one of the 5,000
 * files — 4,513 carried frontmatter, and there were ZERO mismatches. The probe
 * is `e2e/wave6-cache-vs-head.mjs` beside the design notes.
 *
 * ## The three places it DID diverge, and what each one cost
 *
 * The same probe planted edge files and compared the two paths on each. Three
 * answers could not have been reasoned out, and all three are handled below:
 *
 * 1. **A byte-order mark hides the frontmatter.** `\uFEFF---\nk: v\n---` gives
 *    `exists: false` from `getFrontMatterInfo`, while the cache reports
 *    `{ k: "v" }`: Obsidian strips the BOM upstream of the call. Stripping one
 *    leading BOM makes the two agree, which is what `stripBom` is for. Without
 *    it a BOM-prefixed note would silently lose its properties on the repaired
 *    path only.
 * 2. **Malformed YAML throws.** `k: [unclosed` inside a CLOSED block raises
 *    `YAMLParseError`, and the cache's answer for that same file is "no
 *    frontmatter". So a throw is `"none"`, not `"unreadable"` — measured, not
 *    chosen.
 * 3. **A frontmatter block that is not a map.** `---\njust a string\n---` and
 *    an empty `---\n---` parse to a string and to null; the cache reports no
 *    frontmatter for both. So anything that is not a plain object is `"none"`.
 *
 * A LEADING BLANK LINE is not a divergence and is not special-cased: both
 * paths agree that `\n---\nk: v\n---` has no frontmatter.
 */

/** One file's answer. The three states are distinct because they must be. */
export type FrontmatterRead =
  /** The file has frontmatter, and this is it. */
  | { readonly kind: "frontmatter"; readonly frontmatter: Record<string, unknown> }
  /** The file has no frontmatter. It contributes nothing, and that is correct. */
  | { readonly kind: "none" }
  /**
   * We could not say. NOT the same as "none", and collapsing the two is the
   * mistake this whole design exists to avoid: a file counted as having no
   * properties when nobody actually looked is an answer labelled complete that
   * is wrong, which is worse than an answer labelled incomplete.
   */
  | { readonly kind: "unreadable" };

/** `frontmatterFromHead` also has to be able to say "read me more". */
export type HeadVerdict = FrontmatterRead | { readonly kind: "truncated" };

/**
 * 16 KB. Three measured facts set it: frontmatter sits at the start of the
 * file, the probe found no note in a 5,000-note vault whose block ran past a
 * few hundred bytes, and the window is only ever paid for files Obsidian has
 * already failed to parse — at most `PROPERTY_REPAIR_MAX_FILES` of them. Big
 * enough that growing is the rare path, small enough that 200 of them is 3 MB
 * read once, against the 33 MB a single `cachedRead` of the jamming file would
 * pull into memory and into Obsidian's own read cache.
 */
export const FRONTMATTER_HEAD_BYTES = 16 * 1024;

/**
 * 256 KB, and then we stop. A quarter-megabyte of YAML is not a property
 * anyone is matching on, and the alternative — no cap — is a reader that
 * happily pulls the 33 MB file into memory to look for a delimiter that may
 * not be there. Past the cap the file is `"unreadable"`, not `"none"`: we did
 * not look at the whole block, so we do not get to say it has no properties.
 */
export const FRONTMATTER_HEAD_CAP_BYTES = 256 * 1024;

/**
 * One leading byte-order mark, removed. See divergence 1 above.
 *
 * ONE, not all: `\uFEFF\uFEFF---` is not frontmatter after stripping one, and
 * no reading says what Obsidian makes of a doubled mark, so stripping until
 * none are left would be inventing an answer.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * What the head of a file says, through Obsidian's own two functions.
 *
 * `complete` is whether `head` is the WHOLE file. It is the only thing that
 * separates "this file has no frontmatter" from "the block has not closed
 * yet": an unterminated block reads as `exists: false`, measured, so without
 * knowing whether more bytes exist the two are indistinguishable and we would
 * report "none" for a file whose properties are 20 KB in.
 */
export function frontmatterFromHead(head: string, complete: boolean): HeadVerdict {
  const text = stripBom(head);
  const info = getFrontMatterInfo(text);
  if (!info.exists) return complete ? { kind: "none" } : { kind: "truncated" };
  let doc: unknown;
  try {
    doc = parseYaml(info.frontmatter);
  } catch {
    // Divergence 2: the cache reports no frontmatter for a block it cannot
    // parse, so we must too, or a note with broken YAML would keep a whole
    // vault's property snapshot unavailable.
    return { kind: "none" };
  }
  // Divergence 3. `typeof null === "object"` and `typeof [] === "object"`, so
  // both are named rather than left to the typeof.
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { kind: "none" };
  return { kind: "frontmatter", frontmatter: doc as Record<string, unknown> };
}

/**
 * Bytes from the start of a file.
 *
 * Injected, so everything above and below it is testable without a
 * filesystem. Returns null when the file cannot be read at all — missing,
 * locked, on a disconnected share — which is one of the causes a persistent
 * `null` from `getFileCache` can have in the first place.
 *
 * `complete` must be true only when `text` is certainly the whole file.
 */
export type HeadReader = (
  path: string,
  bytes: number
) => Promise<{ text: string; complete: boolean } | null>;

/**
 * The seam the repair reads through. Tests supply a map of path to text.
 *
 * `stamp` is the file's mtime, carried so a memo can tell a re-read from a
 * re-ask; an implementation that does not memoize ignores it.
 */
export interface FrontmatterSource {
  read(path: string, stamp: number): Promise<FrontmatterRead>;
}

/**
 * The reader, as a widening window: 16 KB, then 64 KB, then 256 KB, then stop.
 *
 * Three reads at worst, and the first one answers for every file anyone has
 * ever written. Growing is driven by `"truncated"`, which can only be returned
 * when the read filled the window — so a file SHORTER than the window is
 * answered in one read whatever it contains.
 *
 * Encoding: the bytes are decoded as UTF-8 and a multibyte character may be
 * split at the window boundary. Harmless, because nothing past the closing
 * delimiter is consumed and the delimiter is required to be inside the window;
 * a split character can only ever appear after it.
 */
export function createFrontmatterSource(readHead: HeadReader): FrontmatterSource {
  return {
    async read(path) {
      let window = FRONTMATTER_HEAD_BYTES;
      for (;;) {
        const head = await readHead(path, window);
        if (head === null) return { kind: "unreadable" };
        const verdict = frontmatterFromHead(head.text, head.complete);
        if (verdict.kind !== "truncated") return verdict;
        if (window >= FRONTMATTER_HEAD_CAP_BYTES) return { kind: "unreadable" };
        window = Math.min(window * 4, FRONTMATTER_HEAD_CAP_BYTES);
      }
    },
  };
}

/**
 * The same source, answering a repeat ask for an unchanged file from memory.
 *
 * A jammed vault still delivers metadata events — a note the user types in
 * fires `changed` — and each one installs a fresh snapshot accessor, so
 * without this the repair re-reads every unparsed file's head on every burst.
 * Keyed on path AND mtime, so a file that actually changed is read again.
 *
 * `"unreadable"` is NEVER memoized. It is the one answer that can be
 * transient — a share that came back, a lock that cleared — and caching it
 * would turn a momentary failure into a permanent one for the session.
 */
export function memoizeFrontmatterSource(inner: FrontmatterSource): FrontmatterSource {
  const seen = new Map<string, { stamp: number; read: FrontmatterRead }>();
  return {
    async read(path, stamp) {
      const found = seen.get(path);
      if (found !== undefined && found.stamp === stamp) return found.read;
      const read = await inner.read(path, stamp);
      if (read.kind !== "unreadable") seen.set(path, { stamp, read });
      return read;
    },
  };
}
