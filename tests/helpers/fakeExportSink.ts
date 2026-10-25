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
  const dirs = new Set<string>([""]);
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
      // Recursive, like mkdir -p.
      const parts = rel.split("/").filter(Boolean);
      let acc = "";
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
    exists: async (rel) => dirs.has(rel) || files.has(rel) || texts.has(rel),
    isEmptyDir: async (rel) => {
      const prefix = rel === "" ? "" : `${rel}/`;
      const held = [...files.keys(), ...texts.keys(), ...dirs].filter(
        (p) => p !== rel && p.startsWith(prefix) && p !== ""
      );
      return held.length === 0;
    },
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
