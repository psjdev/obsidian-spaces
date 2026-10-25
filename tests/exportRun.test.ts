import { describe, expect, it } from "vitest";
import type { ExportPlan } from "../src/export/exportPlan";
import { MANIFEST_FILENAME, type SpaceManifest } from "../src/export/spaceManifest";
import { runExport } from "../src/export/runExport";
import { fakeExportSink } from "./helpers/fakeExportSink";

const manifest: SpaceManifest = {
  formatVersion: 1,
  exportedAt: "2026-10-25T10:00:00.000Z",
  space: { id: "reading", name: "Reading", icon: "book-open", color: "#4ecdc4", members: [] },
  contents: { members: [], referenced: [] },
};

const plan: ExportPlan = {
  entries: [
    { sourcePath: "Attachments/diagram.png", destRelativePath: "Attachments/diagram.png", why: "referenced" },
    { sourcePath: "Projects/Kitchen/plan.md", destRelativePath: "Projects/Kitchen/plan.md", why: "member" },
    { sourcePath: "Reading/book.md", destRelativePath: "Reading/book.md", why: "member" },
  ],
  folders: ["Projects/Empty"],
  collisions: [],
};

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Suspends on a real deferred promise, so concurrency can actually be observed. */
function countingReader(fail?: string) {
  let live = 0;
  let max = 0;
  const reader = async (path: string): Promise<Uint8Array> => {
    live += 1;
    max = Math.max(max, live);
    await new Promise((r) => setTimeout(r, 0));
    live -= 1;
    if (path === fail) throw new Error("EACCES: permission denied");
    return bytes(path);
  };
  return { reader, maxConcurrent: () => max };
}

describe("runExport", () => {
  it("writes exactly the planned set, and nothing else", async () => {
    const sink = fakeExportSink();
    const { reader } = countingReader();
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect([...sink.files.keys()].sort()).toEqual([
      "Attachments/diagram.png",
      "Projects/Kitchen/plan.md",
      "Reading/book.md",
    ]);
  });

  it("creates a directory before writing into it", async () => {
    // The fake throws ENOENT otherwise, as the real filesystem would.
    const sink = fakeExportSink();
    const { reader } = countingReader();
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect(sink.order.indexOf("dir:Reading")).toBeLessThan(sink.order.indexOf("file:Reading/book.md"));
  });

  it("creates a member folder that holds no files", async () => {
    const sink = fakeExportSink();
    const { reader } = countingReader();
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect(sink.dirs.has("Projects/Empty")).toBe(true);
  });

  it("reads one file at a time", async () => {
    // A space holding video must not be read into memory at once.
    const sink = fakeExportSink();
    const { reader, maxConcurrent } = countingReader();
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect(maxConcurrent()).toBe(1);
  });

  it("writes the manifest last on success", async () => {
    const sink = fakeExportSink();
    const { reader } = countingReader();
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect(sink.order.at(-1)).toBe(`text:${MANIFEST_FILENAME}`);
  });

  it("counts what it copied", async () => {
    const sink = fakeExportSink();
    const { reader } = countingReader();
    expect((await runExport({ plan, manifest, sink, readBinary: reader })).copied).toBe(3);
  });

  it("stops at the first failure and names the file", async () => {
    const sink = fakeExportSink();
    const { reader } = countingReader("Projects/Kitchen/plan.md");
    const outcome = await runExport({ plan, manifest, sink, readBinary: reader });
    expect(outcome.failed?.path).toBe("Projects/Kitchen/plan.md");
    expect(outcome.failed?.message).toContain("EACCES");
    // Stopped rather than carried on: the third entry was never read.
    expect(outcome.copied).toBe(1);
    expect(sink.files.has("Reading/book.md")).toBe(false);
  });

  it("writes no manifest when the export failed", async () => {
    // A manifest is what makes a folder look like a complete export.
    const sink = fakeExportSink();
    const { reader } = countingReader("Reading/book.md");
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect(sink.texts.has(MANIFEST_FILENAME)).toBe(false);
  });

  it("does not roll back what it already wrote", async () => {
    // A half-written folder the user can see and delete beats a silent
    // cleanup that might remove something else.
    const sink = fakeExportSink();
    const { reader } = countingReader("Reading/book.md");
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect(sink.removed).toEqual([]);
    expect(sink.files.size).toBeGreaterThan(0);
  });

  it("creates the export folder before anything else", async () => {
    // Nothing else creates it: folders and parents are only made because
    // something is going into them.
    const sink = fakeExportSink();
    const { reader } = countingReader();
    await runExport({ plan, manifest, sink, readBinary: reader });
    expect(sink.order[0]).toBe("dir:");
  });

  it("reports an empty space honestly", async () => {
    const sink = fakeExportSink();
    const { reader } = countingReader();
    const empty: ExportPlan = { entries: [], folders: [], collisions: [] };
    const outcome = await runExport({ plan: empty, manifest, sink, readBinary: reader });
    expect(outcome.copied).toBe(0);
    expect(outcome.failed).toBe(null);
    // The manifest still goes out, so the folder says which space it was.
    expect(sink.texts.has(MANIFEST_FILENAME)).toBe(true);
  });

  it("reports a sink failure the same way as a read failure", async () => {
    const sink = fakeExportSink();
    const { reader } = countingReader();
    sink.writeFile = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const outcome = await runExport({ plan, manifest, sink, readBinary: reader });
    expect(outcome.failed?.message).toContain("ENOSPC");
    expect(outcome.copied).toBe(0);
  });
});
