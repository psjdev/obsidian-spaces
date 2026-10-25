import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeExportSink, joinUnderRoot } from "../src/export/nodeExportSink";

/**
 * The one file the rest of the suite cannot reach, so it is tested against a
 * real filesystem in a temp directory. The design's doubt about non-ASCII
 * names is about Node, and a string-concatenation test would discharge
 * nothing.
 */
describe("joinUnderRoot", () => {
  it("resolves a path relative to the root", () => {
    expect(joinUnderRoot("C:/out", "a/b.md")).toBe(join("C:/out", "a/b.md").split("\\").join("/"));
  });

  it("accepts the empty string as the root itself", () => {
    // This is the argument the replace uses for the whole export folder.
    expect(joinUnderRoot("C:/out", "")).toBe("C:/out");
  });

  it("accepts an interior .. that stays inside", () => {
    expect(joinUnderRoot("C:/out", "a/b/../c.md")).toBe(
      join("C:/out", "a/c.md").split("\\").join("/")
    );
  });

  it("rejects every way out of the root", () => {
    // A prefix test alone accepts `a/../../x`, which resolves outside while
    // looking like it stays. This is the feature's only containment barrier.
    for (const bad of ["../x", "a/../../x", "..", "../"]) {
      expect(() => joinUnderRoot("C:/out", bad), bad).toThrow();
    }
  });

  it("rejects an absolute path, which would ignore the root entirely", () => {
    for (const bad of ["/abs/x", "C:/other/x"]) {
      expect(() => joinUnderRoot("C:/out", bad), bad).toThrow();
    }
  });

  it("does not mistake a sibling for a child", () => {
    expect(() => joinUnderRoot("C:/out", "../outside/x.md")).toThrow();
  });
});

describe("createNodeExportSink against a real filesystem", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spaces-export-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a non-ASCII path", async () => {
    // Vaults are full of these. The design asked for this to be tested
    // rather than assumed.
    const sink = createNodeExportSink(root);
    await sink.ensureDir("ノート");
    await sink.writeFile("ノート/計画.md", new TextEncoder().encode("# 計画"));
    expect(await readFile(join(root, "ノート", "計画.md"), "utf8")).toBe("# 計画");
  });

  it("writes bytes a Uint8Array carries", async () => {
    const sink = createNodeExportSink(root);
    await sink.writeFile("bin.dat", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const back = await readFile(join(root, "bin.dat"));
    expect([...back]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("creates nested directories in one call", async () => {
    const sink = createNodeExportSink(root);
    await sink.ensureDir("a/b/c");
    expect((await stat(join(root, "a", "b", "c"))).isDirectory()).toBe(true);
  });

  it("reports an empty directory as empty, and a lone dotfile as not empty", async () => {
    // "Not empty" has to include dotfiles: a folder holding only a
    // .DS_Store is still someone's folder, and replacing it would be wrong.
    const sink = createNodeExportSink(root);
    expect(await sink.isEmptyDir("")).toBe(true);
    await writeFile(join(root, ".DS_Store"), "x");
    expect(await sink.isEmptyDir("")).toBe(false);
  });

  it("answers exists without throwing on a missing path", async () => {
    const sink = createNodeExportSink(root);
    expect(await sink.exists("nope.md")).toBe(false);
    await sink.writeFile("yes.md", new TextEncoder().encode("y"));
    expect(await sink.exists("yes.md")).toBe(true);
  });

  it("removes the export root and everything under it", async () => {
    const sink = createNodeExportSink(root);
    await sink.ensureDir("a/b");
    await sink.writeFile("a/b/c.md", new TextEncoder().encode("c"));
    await sink.removeDir("");
    expect(await sink.exists("a")).toBe(false);
  });

  it("refuses to write outside the root, with the real filesystem watching", async () => {
    const sink = createNodeExportSink(root);
    await expect(sink.writeFile("../escaped.md", new Uint8Array([1]))).rejects.toThrow();
    await expect(stat(join(root, "..", "escaped.md"))).rejects.toThrow();
  });

  it("refuses to remove outside the root", async () => {
    const sink = createNodeExportSink(root);
    await expect(sink.removeDir("../..")).rejects.toThrow();
  });
});
