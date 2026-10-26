import type { ExportSink } from "../../src/export/ExportSink";

/**
 * An in-memory `ExportSink` that enforces what a real filesystem enforces.
 *
 * It refuses a write into a directory nothing created, because a fake that
 * allows it is green in the suite and `ENOENT` in production, which is
 * exactly the kind of test this project keeps finding.
 */
export interface FakeExportSink extends ExportSink {
  files: Map<string, Uint8Array>;
  texts: Map<string, string>;
  dirs: Set<string>;
  removed: string[];
  /** Every call in order, as `kind:path`, so ordering can be asserted. */
  order: string[];
}

const parentOf = (rel: string): string => {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
};

export function fakeExportSink(opts: { existing?: Set<string> } = {}): FakeExportSink {
  const files = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  // NOT seeded with the root. A real sink starts with nothing, and seeding
  // it here hid a bug where `runExport` never created the export folder:
  // an empty space failed with ENOENT against the real filesystem while
  // every test here stayed green.
  const dirs = new Set<string>();
  const removed: string[] = [];
  const order: string[] = [];
  for (const d of opts.existing ?? []) dirs.add(d);

  const requireDir = (rel: string): void => {
    const parent = parentOf(rel);
    if (!dirs.has(parent)) {
      throw new Error(`ENOENT: no such directory ${parent || "<root>"} for ${rel}`);
    }
  };

  return {
    files,
    texts,
    dirs,
    removed,
    order,
    ensureDir: async (rel) => {
      // Recursive, like `mkdir -p`, and it creates the directory NAMED as
      // well as its ancestors. `""` is the export root, which real `mkdir`
      // creates and an earlier version of this fake silently did not.
      const parts = rel.split("/").filter(Boolean);
      let acc = "";
      dirs.add("");
      for (const p of parts) {
        acc = acc === "" ? p : `${acc}/${p}`;
        dirs.add(acc);
      }
      order.push(`dir:${rel}`);
    },
    writeFile: async (rel, data) => {
      requireDir(rel);
      files.set(rel, data);
      order.push(`file:${rel}`);
    },
    writeText: async (rel, text) => {
      requireDir(rel);
      texts.set(rel, text);
      order.push(`text:${rel}`);
    },
    readText: async (rel) => texts.get(rel) ?? null,
    countEntries: async (rel) => {
      const prefix = rel === "" ? "" : `${rel}/`;
      const held = new Set<string>();
      for (const p of [...files.keys(), ...texts.keys(), ...dirs]) {
        if (p === rel || p === "" || !p.startsWith(prefix)) continue;
        held.add(p.slice(prefix.length).split("/")[0]);
      }
      return held.size;
    },
    exists: async (rel) => dirs.has(rel) || files.has(rel) || texts.has(rel),
    removeDir: async (rel) => {
      removed.push(rel);
      order.push(`rm:${rel}`);
      const prefix = rel === "" ? "" : `${rel}/`;
      for (const m of [files, texts]) {
        for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
      }
    },
  };
}
