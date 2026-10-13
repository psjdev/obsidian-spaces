/**
 * The bounded head read: the window, the cap, and the three measured
 * divergences from the metadata cache.
 *
 * `tests/propertyRepairEquivalence.test.ts` is the test that matters — it
 * compares this path against the cached path over the whole boundary table.
 * This one covers what that comparison cannot see, because every document
 * there fits in the first window: what happens when the frontmatter block does
 * NOT close inside the bytes we read.
 *
 * Layer 1. The reader is a map of path to text; nothing here touches a disk.
 */
import { describe, expect, it, vi } from "vitest";
import { getFrontMatterInfo } from "obsidian";
import {
  createFrontmatterSource,
  frontmatterFromHead,
  memoizeFrontmatterSource,
  FRONTMATTER_HEAD_BYTES,
  FRONTMATTER_HEAD_CAP_BYTES,
  type HeadReader,
} from "../src/visibility/frontmatterHead";

/**
 * A reader over a map, truncating on BYTES, and counting what it was asked.
 * `complete` is true only when the read did not fill the window, which is the
 * contract `createNodeHeadReader` honours against the real filesystem.
 */
function mapReader(files: Readonly<Record<string, string>>): HeadReader & { asked: number[][] } {
  const asked: number[][] = [];
  const read: HeadReader = async (path, bytes) => {
    const text = files[path];
    if (text === undefined) return null;
    asked.push([bytes]);
    const slice = Buffer.from(text, "utf8").subarray(0, bytes);
    return { text: slice.toString("utf8"), complete: slice.length < bytes };
  };
  return Object.assign(read, { asked });
}

/** A frontmatter block whose closing delimiter sits `pad` bytes in. */
const padded = (pad: number): string =>
  `---\nk: v\nfiller: ${"x".repeat(pad)}\n---\nbody\n`;

describe("the stub models what a real Obsidian recorded", () => {
  // The stub is the only thing standing between this suite and a guess, so the
  // offsets it was built from are asserted here rather than left in a comment.
  // Every expectation is a line of `e2e/wave6-gfmi-offsets.mjs` output, taken
  // from Obsidian 1.13.7.
  it.each([
    ["---\nk: Active\n---\nbody\n", true, 4, 14, 18, "k: Active\n"],
    ["---\nk: v\n---", true, 4, 9, 12, "k: v\n"],
    ["---\nk: v\n---\n", true, 4, 9, 13, "k: v\n"],
    ["---\n---\nbody\n", true, 4, 4, 8, ""],
    ["---\r\nk: v\r\n---\r\nbody\r\n", true, 5, 11, 16, "k: v\r\n"],
    ["---\nk: Active\n", false, 0, 0, 0, ""],
    ["---\nk: Active", false, 0, 0, 0, ""],
    ["---\nk: v\n----\nbody\n", false, 0, 0, 0, ""],
    ["---\nk: v\n ---\nbody\n", false, 0, 0, 0, ""],
    ["---\nk: v\n--- \nbody\n", false, 0, 0, 0, ""],
    ["---\nk: v\n---\nbody\n---\nj: w\n---\n", true, 4, 9, 13, "k: v\n"],
    ["--- \nk: v\n---\nbody\n", false, 0, 0, 0, ""],
    ["﻿---\nk: v\n---\nbody\n", false, 0, 0, 0, ""],
    ["\n---\nk: v\n---\nbody\n", false, 0, 0, 0, ""],
  ])("getFrontMatterInfo(%j)", (text, exists, from, to, contentStart, frontmatter) => {
    expect(getFrontMatterInfo(text)).toEqual({ exists, from, to, contentStart, frontmatter });
  });
});

describe("frontmatterFromHead", () => {
  it("reads a closed block", () => {
    expect(frontmatterFromHead("---\nk: v\n---\nbody\n", true)).toEqual({
      kind: "frontmatter",
      frontmatter: { k: "v" },
    });
  });

  it("calls an UNCLOSED block truncated when there may be more file", () => {
    // The one distinction the equivalence test cannot make, because every
    // document there fits in the first window. An unterminated block reads as
    // `exists: false`, so without `complete` it is indistinguishable from a
    // file with no frontmatter at all.
    expect(frontmatterFromHead("---\nk: v\n", false)).toEqual({ kind: "truncated" });
    expect(frontmatterFromHead("---\nk: v\n", true)).toEqual({ kind: "none" });
  });

  it("strips exactly one byte-order mark", () => {
    expect(frontmatterFromHead("﻿---\nk: v\n---\n", true)).toEqual({
      kind: "frontmatter",
      frontmatter: { k: "v" },
    });
    // Two is not one. Nothing measured says what Obsidian makes of a doubled
    // mark, so this asserts the conservative answer rather than an invention.
    expect(frontmatterFromHead("﻿﻿---\nk: v\n---\n", true)).toEqual({ kind: "none" });
  });
});

describe("the widening window", () => {
  it("answers a small file in ONE read", async () => {
    const reader = mapReader({ "a.md": padded(10) });
    expect(await createFrontmatterSource(reader).read("a.md", 0)).toEqual({
      kind: "frontmatter",
      frontmatter: { k: "v", filler: "x".repeat(10) },
    });
    expect(reader.asked).toEqual([[FRONTMATTER_HEAD_BYTES]]);
  });

  it("grows when the block does not close inside the first window", async () => {
    // 20 KB of filler: the block closes past 16 KB and inside 64 KB.
    const reader = mapReader({ "a.md": padded(20 * 1024) });
    const read = await createFrontmatterSource(reader).read("a.md", 0);
    expect(read.kind).toBe("frontmatter");
    expect(reader.asked).toEqual([[FRONTMATTER_HEAD_BYTES], [FRONTMATTER_HEAD_BYTES * 4]]);
  });

  it("gives up at the cap, and says UNREADABLE rather than none", async () => {
    // Past the cap we did not see the whole block, so we do not get to say the
    // file has no properties. Reporting "none" here is precisely the lie the
    // design rejects: a note silently missing from a count labelled complete.
    const reader = mapReader({ "a.md": padded(FRONTMATTER_HEAD_CAP_BYTES * 2) });
    expect(await createFrontmatterSource(reader).read("a.md", 0)).toEqual({ kind: "unreadable" });
    expect(reader.asked).toEqual([[16 * 1024], [64 * 1024], [256 * 1024]]);
  });

  it("is unreadable when the file cannot be read at all", async () => {
    const reader = mapReader({});
    expect(await createFrontmatterSource(reader).read("gone.md", 0)).toEqual({ kind: "unreadable" });
  });

  it("does not grow for a short file that has no frontmatter", async () => {
    const reader = mapReader({ "a.md": "just a note\n" });
    expect(await createFrontmatterSource(reader).read("a.md", 0)).toEqual({ kind: "none" });
    expect(reader.asked).toHaveLength(1);
  });
});

describe("the memo", () => {
  it("reads a file once per mtime", async () => {
    const inner = { read: vi.fn(async () => ({ kind: "none" }) as const) };
    const source = memoizeFrontmatterSource(inner);
    await source.read("a.md", 10);
    await source.read("a.md", 10);
    expect(inner.read).toHaveBeenCalledTimes(1);
    await source.read("a.md", 11);
    expect(inner.read).toHaveBeenCalledTimes(2);
  });

  it("never memoizes UNREADABLE, because it can be transient", async () => {
    // A share that came back or a lock that cleared must not be remembered as
    // a permanent failure for the rest of the session.
    const inner = { read: vi.fn(async () => ({ kind: "unreadable" }) as const) };
    const source = memoizeFrontmatterSource(inner);
    await source.read("a.md", 10);
    await source.read("a.md", 10);
    expect(inner.read).toHaveBeenCalledTimes(2);
  });

  it("keeps each path's answer apart", async () => {
    const source = memoizeFrontmatterSource(
      createFrontmatterSource(mapReader({ "a.md": "---\nk: a\n---\n", "b.md": "---\nk: b\n---\n" }))
    );
    expect(await source.read("a.md", 1)).toEqual({ kind: "frontmatter", frontmatter: { k: "a" } });
    expect(await source.read("b.md", 1)).toEqual({ kind: "frontmatter", frontmatter: { k: "b" } });
    expect(await source.read("a.md", 1)).toEqual({ kind: "frontmatter", frontmatter: { k: "a" } });
  });
});
