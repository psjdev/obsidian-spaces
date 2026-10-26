import { promises as fs } from "fs";
import * as path from "path";
import type { ExportSink } from "./ExportSink";

/**
 * Where the export's filesystem work lives. One `fs` call sits outside
 * it, `realpath` in `main.ts`, which the destination guard needs before a
 * sink exists.
 *
 * `fs` and `path` are static imports: `@typescript-eslint/no-require-imports`
 * forbids `require` (an AST rule), and both `noNetwork.test.ts` and
 * `moduleGraph.test.ts` forbid the dynamic import form, so the usual
 * `Platform.isDesktop`-guarded import is not available here.
 * `moduleGraph.test.ts` matches textually WITHOUT stripping comments, which
 * is why that spelling does not appear above; `noNetwork.test.ts` strips
 * them first.
 * Both are externalised in `esbuild.config.mjs` and provided by Obsidian's
 * desktop runtime; the manifest is `isDesktopOnly`.
 */

/**
 * Resolves a path that is relative to the export root, and refuses anything
 * that leaves it.
 *
 * This is the feature's only containment barrier. Everything the sink writes
 * or deletes goes through it, including the empty string, which is how the
 * replace addresses the export root itself.
 *
 * Resolution first, then containment: a prefix test alone accepts
 * `a/../../x`, which resolves outside the root while looking like it stays.
 */
export function joinUnderRoot(root: string, rel: string): string {
  const base = path.resolve(root);
  const joined = path.resolve(base, rel);
  const normalisedBase = base.endsWith(path.sep) ? base.slice(0, -1) : base;
  if (joined !== normalisedBase && !joined.startsWith(normalisedBase + path.sep)) {
    throw new Error(`Export path leaves the export folder: ${rel}`);
  }
  // Posix separators out, so callers and tests read one shape. The fs calls
  // below use the value from `path.resolve` directly, not this.
  return joined.split(path.sep).join("/");
}

export function createNodeExportSink(rootDir: string): ExportSink {
  const at = (rel: string): string => path.resolve(rootDir, joinUnderRoot(rootDir, rel));

  return {
    ensureDir: async (rel) => {
      await fs.mkdir(at(rel), { recursive: true });
    },
    writeFile: async (rel, data) => {
      await fs.writeFile(at(rel), data);
    },
    writeText: async (rel, text) => {
      await fs.writeFile(at(rel), text, "utf8");
    },
    readText: async (rel) => {
      // Resolved OUTSIDE the try. The catch is for "not there" and "not a
      // file", which are ordinary answers; a path that leaves the export
      // root is not, and swallowing it would turn the containment barrier
      // into a silent null.
      const full = at(rel);
      try {
        return await fs.readFile(full, "utf8");
      } catch {
        return null;
      }
    },
    exists: async (rel) => {
      try {
        await fs.stat(at(rel));
        return true;
      } catch {
        return false;
      }
    },
    removeDir: async (rel) => {
      await fs.rm(at(rel), { recursive: true, force: true });
    },
  };
}
