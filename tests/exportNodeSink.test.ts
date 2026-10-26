import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeExportSink, joinUnderRoot } from "../src/export/nodeExportSink";
import { runExport } from "../src/export/runExport";
import { MANIFEST_FILENAME, type SpaceManifest } from "../src/export/spaceManifest";

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

  it("reads text back, and answers null rather than throwing when absent", async () => {
    // The manifest read is the gate on the recursive delete, so a throw
    // here would become "export could not finish" and a wrong null would
    // turn a replace into a refusal.
    const sink = createNodeExportSink(root);
    expect(await sink.readText("nope.json")).toBe(null);
    await sink.writeText("there.json", '{"a":1}');
    expect(await sink.readText("there.json")).toBe('{"a":1}');
  });

  it("answers null for a directory rather than throwing", async () => {
    const sink = createNodeExportSink(root);
    await sink.ensureDir("adir");
    expect(await sink.readText("adir")).toBe(null);
  });

  it("refuses to read outside the root", async () => {
    const sink = createNodeExportSink(root);
    await expect(sink.readText("../outside.json")).rejects.toThrow();
  });

  it("round-trips non-ASCII text", async () => {
    const sink = createNodeExportSink(root);
    await sink.writeText("u.json", '{"name":"計画"}');
    expect(await sink.readText("u.json")).toContain("計画");
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

/**
 * `runExport` driven by the REAL sink, not the fake.
 *
 * These exist because the fake hid a bug the fake was written to prevent:
 * it seeded itself with the export root, so an empty space passed in the
 * suite and failed with ENOENT against a filesystem. On the replace path
 * the previous export is already gone by then, so the user was left with
 * nothing at all.
 */
describe("runExport against the real sink", () => {
  const manifest: SpaceManifest = {
    formatVersion: 1,
    exportedAt: "2026-10-25T10:00:00.000Z",
    space: { id: "x", name: "X", icon: "book", color: "#fff", members: [] },
    contents: { members: [], referenced: [] },
  };

  it("creates the export folder and writes the manifest for an EMPTY space", async () => {
    const parent = await mkdtemp(join(tmpdir(), "spaces-empty-"));
    const root = join(parent, "X");
    const outcome = await runExport({
      plan: { entries: [], folders: [], collisions: [] },
      manifest,
      sink: createNodeExportSink(root),
      readBinary: async () => new Uint8Array(),
    });
    expect(outcome.failed).toBe(null);
    expect(outcome.copied).toBe(0);
    expect((await stat(join(root, MANIFEST_FILENAME))).isFile()).toBe(true);
    await rm(parent, { recursive: true, force: true });
  });

  it("writes a real file at a mirrored path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "spaces-real-"));
    const root = join(parent, "X");
    const outcome = await runExport({
      plan: {
        entries: [
          { sourcePath: "a/b.md", destRelativePath: "a/b.md", why: "member" },
        ],
        folders: [],
        collisions: [],
      },
      manifest,
      sink: createNodeExportSink(root),
      readBinary: async () => new TextEncoder().encode("# B"),
    });
    expect(outcome.failed).toBe(null);
    expect(await readFile(join(root, "a", "b.md"), "utf8")).toBe("# B");
    await rm(parent, { recursive: true, force: true });
  });
});
