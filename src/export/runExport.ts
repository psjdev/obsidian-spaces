import type { ExportSink } from "./ExportSink";
import type { ExportPlan } from "./exportPlan";
import { MANIFEST_FILENAME, type SpaceManifest } from "./spaceManifest";

export interface ExportOutcome {
  copied: number;
  /** The file it stopped on, or null when the whole plan was written. */
  failed: { path: string; message: string } | null;
}

export interface RunExportArgs {
  plan: ExportPlan;
  manifest: SpaceManifest;
  sink: ExportSink;
  readBinary: (path: string) => Promise<Uint8Array>;
}

const parentOf = (rel: string): string => {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
};

/**
 * Copies a plan into a sink.
 *
 * Strictly one file at a time. A `Promise.all` would be faster and would
 * break the rule that a space holding video must not be read into memory at
 * once; a test pins the maximum concurrency at one.
 *
 * Stops at the first failure and says which file. It does NOT roll back: a
 * half-written folder the user can see and delete is more honest than a
 * cleanup that might remove something else, given this writes outside the
 * vault.
 *
 * The manifest goes last, so a failure partway leaves no manifest and the
 * folder cannot be mistaken for a complete export.
 *
 * `removeDir` is never called here. Replacing a destination happens in the
 * command, after the confirmation, before this runs.
 */
export async function runExport(args: RunExportArgs): Promise<ExportOutcome> {
  const { plan, manifest, sink, readBinary } = args;
  let copied = 0;

  try {
    for (const folder of plan.folders) await sink.ensureDir(folder);

    for (const entry of plan.entries) {
      try {
        await sink.ensureDir(parentOf(entry.destRelativePath));
        const data = await readBinary(entry.sourcePath);
        await sink.writeFile(entry.destRelativePath, data);
        copied += 1;
      } catch (e) {
        return { copied, failed: { path: entry.sourcePath, message: messageOf(e) } };
      }
    }

    await sink.writeText(MANIFEST_FILENAME, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    // A folder or the manifest failed. Neither names a source file, so the
    // destination stands in for one rather than reporting an empty path.
    return { copied, failed: { path: MANIFEST_FILENAME, message: messageOf(e) } };
  }

  return { copied, failed: null };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
