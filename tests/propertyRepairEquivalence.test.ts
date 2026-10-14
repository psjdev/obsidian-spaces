/**
 * THE TEST THAT MATTERS: the repaired path and the cached path must give
 * IDENTICAL answers.
 *
 * When Obsidian has not parsed a file, `src/visibility/frontmatterHead.ts`
 * reads that file's head off disk and parses the frontmatter itself. The whole
 * design rests on one claim — that doing so produces exactly what the metadata
 * cache would have produced — and that claim is only worth anything if
 * something fails when it stops being true.
 *
 * So every row of the spec's boundary table in `tests/propertyValues.test.ts`
 * is driven BOTH ways here:
 *
 *   cached   — the frontmatter shape the cache hands over, straight into
 *              `createPropertyIndex`, which is what the plugin does today;
 *   repaired — the same note as MARKDOWN TEXT, through the real
 *              `FrontmatterSource` over a map of path to text, into
 *              `mergeRepairedWalk` and `snapshotFromWalk`, which is what the
 *              plugin does for an unparsed file.
 *
 * and the two indexes are compared on everything a caller can ask them:
 * `listKeys`, `listValues`, `pathsWithKey` and `pathsMatching` for every value
 * either side offers plus a set of near-misses. If head-parsing ever diverges
 * — a BOM, a window that cuts a block in half, a YAML schema change — a row
 * fails and names itself.
 *
 * ## What is real here
 *
 * `createFrontmatterSource`, `frontmatterFromHead`, `mergeRepairedWalk`,
 * `snapshotFromWalk` and `createPropertyIndex` are the production modules. The
 * filesystem is not: the reader is a map, as the brief requires, and it
 * truncates on BYTE boundaries so the window logic is exercised honestly.
 *
 * `getFrontMatterInfo` and `parseYaml` come from `tests/helpers/obsidian-stub.ts`,
 * which models them on readings taken from a real Obsidian 1.13.7 — see that
 * file for the probes and what they recorded. The `cached` column of the table
 * below is ALSO a reading from that run, not a prediction: the same probe
 * compared `getFileCache().frontmatter` against the head parse for all 5,000
 * files of the property fixture and for ten planted edge files.
 */
import { describe, expect, it } from "vitest";
import { createFrontmatterSource, type FrontmatterRead, type FrontmatterSource } from "../src/visibility/frontmatterHead";
import { mergeRepairedWalk } from "../src/visibility/propertyRepair";
import { snapshotFromWalk, type PropertyWalk } from "../src/visibility/ObsidianPropertyIndex";
import { createPropertyIndex, type PropertyIndex } from "../src/visibility/PropertyIndex";

const PATH = "a.md";

/** No frontmatter at all — what the cache reports as `undefined`. */
const NONE = Symbol("no frontmatter");

/**
 * The boundary table, as (frontmatter YAML, the shape the cache gives).
 *
 * Every row of `propertyValues.test.ts` is here except `undefined`, which has
 * no YAML spelling: a parser cannot produce a key whose value is `undefined`,
 * so there is no document to drive the repaired path with. It is called out
 * rather than dropped, and asserted below for what it is.
 */
const ROWS: ReadonlyArray<[string, string, Record<string, unknown> | typeof NONE]> = [
  ["a string", "k: Active", { k: "Active" }],
  ["a number", "k: 2", { k: 2 }],
  ["a boolean", "k: true", { k: true }],
  ["an empty string", 'k: ""', { k: "" }],
  ["whitespace", 'k: "   "', { k: "   " }],
  ["null", "k:", { k: null }],
  ["an explicit null", "k: null", { k: null }],
  ["an object", "k:\n  k: v", { k: { k: "v" } }],
  ["an empty array", "k: []", { k: [] }],
  ["a flat array", "k: [a, b]", { k: ["a", "b"] }],
  ["a block list", "k:\n  - a\n  - b", { k: ["a", "b"] }],
  ["a repeated entry", "k: [a, A]", { k: ["a", "A"] }],
  ["a nested array", "k: [a, [b]]", { k: ["a", ["b"]] }],
  ["an array holding an object", "k: [a, {k: c}]", { k: ["a", { k: "c" }] }],
  ["an array holding null", "k: [a, null]", { k: ["a", null] }],
  ["text with a slash", "k: a/b", { k: "a/b" }],
  ["text with an equals", "k: a=b", { k: "a=b" }],
  ["text with a comma", "k: a,b", { k: "a,b" }],
  ["an accented value already composed", "k: Caf\u00e9", { k: "Caf\u00e9" }],
  ["the same value decomposed", "k: Cafe\u0301", { k: "Cafe\u0301" }],
  ["a decomposed entry beside its composed twin", "k: [cafe\u0301, caf\u00e9]", { k: ["cafe\u0301", "caf\u00e9"] }],
  // The two that pin the YAML schema. `02` is the number 2 and the date is a
  // STRING; a 1.1 schema would make the date a `Date` and `12:30` the number
  // 750, and this table would then fail rather than quietly changing meaning.
  ["the bare 02", "k: 02", { k: 2 }],
  ["the quoted 02", 'k: "02"', { k: "02" }],
  ["the text null", 'k: "null"', { k: "null" }],
  ["a date", "k: 2026-08-31", { k: "2026-08-31" }],
  ["a time-looking value", "k: 12:30", { k: "12:30" }],
  ["several keys at once", "status: active\narea: area-1\nblank:", { status: "active", area: "area-1", blank: null }],
];

/**
 * Whole documents rather than a frontmatter body, for the cases where the
 * DELIMITERS are the subject. Each `cached` is what the metadata cache
 * reported for that exact file, planted in a running Obsidian.
 */
const DOCUMENTS: ReadonlyArray<[string, string, Record<string, unknown> | typeof NONE]> = [
  ["no frontmatter", "just a note, no frontmatter\n", NONE],
  ["an empty file", "", NONE],
  // The one real divergence the probe found, and the reason `stripBom` exists.
  ["a byte-order mark before the block", "\ufeff---\nk: v\n---\nbody\n", { k: "v" }],
  ["a blank line before the block", "\n---\nk: v\n---\nbody\n", NONE],
  ["a block that is not a map", "---\njust a string\n---\nbody\n", NONE],
  ["an empty block", "---\n---\nbody\n", NONE],
  ["malformed YAML", "---\nk: [unclosed\n---\nbody\n", NONE],
  ["CRLF line endings", "---\r\nk: v\r\nlist:\r\n  - a\r\n---\r\nbody\r\n", { k: "v", list: ["a"] }],
  ["a horizontal rule further down", "---\nk: v\n---\nbody\n\n---\n\nmore\n", { k: "v" }],
  ["a block closed at end of file", "---\nk: v\n---", { k: "v" }],
];

/**
 * A `FrontmatterSource` over a map of path to text. No filesystem.
 *
 * Truncation is done on the BYTES, not the characters, because that is what a
 * real head read does and it is the only way the window arithmetic and the
 * split-multibyte case are exercised rather than assumed.
 */
function sourceOver(files: Readonly<Record<string, string>>): FrontmatterSource {
  return createFrontmatterSource(async (path, bytes) => {
    const text = files[path];
    if (text === undefined) return null;
    const slice = Buffer.from(text, "utf8").subarray(0, bytes);
    return { text: slice.toString("utf8"), complete: slice.length < bytes };
  });
}

/** The cached path: the shape the cache gives, straight into the index. */
function cachedIndex(frontmatter: Record<string, unknown> | typeof NONE): PropertyIndex {
  const walk: PropertyWalk =
    frontmatter === NONE ? { entries: [], unparsed: [] } : { entries: [{ path: PATH, frontmatter }], unparsed: [] };
  const snap = snapshotFromWalk(walk, 1);
  if (snap.status !== "ready") throw new Error("the cached path must be ready");
  return snap.index;
}

/** The repaired path: markdown text, read through the seam, into the index. */
async function repairedIndex(text: string): Promise<PropertyIndex> {
  const read: FrontmatterRead = await sourceOver({ [PATH]: text }).read(PATH, 0);
  const merged = mergeRepairedWalk({ entries: [], unparsed: [PATH] }, new Map([[PATH, read]]));
  const snap = snapshotFromWalk(merged, 1);
  if (snap.status !== "ready") {
    throw new Error(`the repaired path left ${merged.unparsed.join(", ")} unreadable`);
  }
  return snap.index;
}

/**
 * Everything a caller can ask an index, as one comparable value.
 *
 * `pathsMatching` is probed with every value either side offers plus a fixed
 * set of near-misses — the ones the table's prose is about: the whole array
 * stringified, the text "null", a differently-cased spelling, an untrimmed
 * one, and a value from one level too deep.
 */
function everything(index: PropertyIndex): unknown {
  const keys = index.listKeys();
  const out: Record<string, unknown> = { keys: keys.map((k) => ({ key: k.key, count: k.count })) };
  for (const { key } of keys) {
    const values = index.listValues(key);
    const probes = [
      ...values.map((v) => v.value),
      ...values.map((v) => v.normalized),
      "a,b",
      "null",
      "b",
      "c",
      "ACTIVE",
      "  Active ",
      "2",
      "02",
      "caf\u00e9",
      "cafe\u0301",
    ];
    out[`values:${key}`] = values.map((v) => ({ value: v.value, normalized: v.normalized, count: v.count }));
    out[`paths:${key}`] = index.pathsWithKey(key);
    out[`matching:${key}`] = probes.map((p) => [p, index.pathsMatching(key, p)]);
  }
  return out;
}

describe("the repaired path answers exactly what the cached path answers", () => {
  it.each(ROWS)("boundary row: %s", async (_label, yaml, cached) => {
    const text = `---\n${yaml}\n---\nbody\n`;
    expect(everything(await repairedIndex(text))).toEqual(everything(cachedIndex(cached)));
  });

  it.each(DOCUMENTS)("document: %s", async (_label, text, cached) => {
    expect(everything(await repairedIndex(text))).toEqual(everything(cachedIndex(cached)));
  });

  it("the one row with no YAML spelling is `undefined`, and it is the cache's own", () => {
    // `propertyValues.test.ts` has a row for a key whose value is `undefined`.
    // No YAML document produces one, so there is nothing for the repaired path
    // to be compared against. What CAN be said is that both paths agree on
    // what such an entry means — the key is carried, and it offers no value —
    // and that the repaired path never manufactures one, because every
    // frontmatter it produces came out of `parseYaml`.
    const index = cachedIndex({ k: undefined });
    expect(index.pathsWithKey("k")).toEqual([PATH]);
    expect(index.listValues("k")).toEqual([]);
  });

  it("fails loudly if the two paths are compared vacuously", async () => {
    // A guard on the comparison above: if `everything` returned the same thing
    // for any two indexes, every row would pass without observing anything.
    const a = await repairedIndex("---\nk: Active\n---\n");
    const b = cachedIndex({ k: "Different" });
    expect(everything(a)).not.toEqual(everything(b));
    // And it is sensitive to the distinctions the table is about.
    expect(everything(cachedIndex({ k: 2 }))).not.toEqual(everything(cachedIndex({ k: "02" })));
    expect(everything(cachedIndex({ k: null }))).not.toEqual(everything(cachedIndex({ k: "null" })));
  });
});

describe("the repaired path and the cached path agree on a whole vault, not one note", () => {
  it("merges repaired entries beside cached ones and answers over both", async () => {
    // The real shape: some files the cache answered for, some it did not.
    const texts = {
      "jammed.md": "---\nstatus: done\narea: atlas\n---\nbody\n",
      "also-jammed.md": "---\nstatus: active\n---\nbody\n",
    };
    const source = sourceOver(texts);
    const repaired = new Map<string, FrontmatterRead>();
    for (const path of Object.keys(texts)) repaired.set(path, await source.read(path, 0));

    const cachedEntries = [
      { path: "parsed.md", frontmatter: { status: "done", area: "billing" } },
      { path: "plain.md", frontmatter: { status: "active" } },
    ];
    const merged = mergeRepairedWalk(
      { entries: cachedEntries, unparsed: ["jammed.md", "also-jammed.md"] },
      repaired
    );
    const snap = snapshotFromWalk(merged, 7);
    if (snap.status !== "ready") throw new Error("expected ready");

    // The same four notes, had the cache answered for all of them.
    const asIfParsed = createPropertyIndex(
      [
        ...cachedEntries,
        { path: "jammed.md", frontmatter: { status: "done", area: "atlas" } },
        { path: "also-jammed.md", frontmatter: { status: "active" } },
      ],
      7
    );
    expect(everything(snap.index)).toEqual(everything(asIfParsed));
    expect(snap.index.pathsMatching("status", "done")).toEqual(["jammed.md", "parsed.md"]);
  });
});
