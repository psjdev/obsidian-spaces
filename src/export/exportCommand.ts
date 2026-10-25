import type { OrderMap, SpaceDefinition } from "../types";
import type { VaultIndex } from "../visibility/VaultIndex";
import type { VisibilitySnapshot } from "../visibility/VisibilityEngine";
import type { ConfirmPrompt } from "../ui/settingsEdits";
import type { ExportSink } from "./ExportSink";
import { buildExportPlan } from "./exportPlan";
import { MANIFEST_FILENAME, buildSpaceManifest } from "./spaceManifest";
import { checkExportDir, resolveExportDir } from "./destination";
import { blockedMessage, outcomeMessage, replaceConfirmPrompt } from "./exportCopy";
import { runExport } from "./runExport";

/**
 * Everything the export needs, injected, so the whole orchestration is
 * testable without an Obsidian runtime. The picker, the modal and the
 * filesystem all arrive as functions.
 */
export interface ExportContext {
  space: SpaceDefinition | null;
  snapshot: VisibilitySnapshot | null;
  vault: VaultIndex;
  order: OrderMap | undefined;
  links: Readonly<Record<string, Readonly<Record<string, number>>>>;
  isIgnored: (path: string) => boolean;
  isExcluded: (path: string) => boolean;
  /** Null when the adapter is not a `FileSystemAdapter`. */
  vaultBasePath: string | null;
  /**
   * `metadataCache.inProgressTaskCount`, or null when that private API is
   * not shaped as expected.
   */
  parseProgress: () => number | null;
  /** Whether a folder space's root resolves to a real folder. */
  rootMissing: boolean;
  pickDir: () => Promise<string | null | undefined>;
  /** Resolves links and junctions, so the checks see a real path. */
  realpath: (p: string) => Promise<string>;
  confirm: (prompt: ConfirmPrompt) => Promise<boolean>;
  makeSink: (rootDir: string) => ExportSink;
  readBinary: (path: string) => Promise<Uint8Array>;
  notify: (message: string) => void;
  now: () => Date;
}

/**
 * Exports the active space.
 *
 * The order of the guards below IS the safety property, and each refuses
 * before the next runs:
 *
 * 1. A space has to be active. All and archived spaces both arrive as null.
 * 2. The snapshot has to exist.
 * 3. The metadata cache has to be idle. `snapshot === null` does NOT cover
 *    this: `SpaceController` nulls the snapshot only for metadata-watching
 *    spaces, so a curated space exported during a cold parse would copy
 *    every note with none of its images and report success.
 * 4. A folder space's root has to resolve.
 * 5. The destination is judged AFTER resolving links and AFTER appending the
 *    space's folder name. Judging the folder the user picked instead let a
 *    vault at `C:/Notes/Vault`, a pick of `C:/Notes` and a space called
 *    `Vault` delete the vault.
 * 6. A non-empty destination is only replaced when it holds our own
 *    manifest. Otherwise it is somebody's folder and we refuse rather than
 *    ask: a space called `Documents` must never be able to eat `~/Documents`
 *    behind a confirmation that reads as routine.
 */
export async function exportActiveSpace(ctx: ExportContext): Promise<void> {
  const { space, snapshot } = ctx;
  if (space === null) return ctx.notify(blockedMessage("no-space"));
  if (snapshot === null) return ctx.notify(blockedMessage("indexing"));
  const progress = ctx.parseProgress();
  if (progress !== null && progress > 0) return ctx.notify(blockedMessage("indexing"));
  if (ctx.rootMissing) return ctx.notify(blockedMessage("missing-root"));

  const chosen = await ctx.pickDir();
  // `showOpenDialog` yields `undefined` for a cancelled dialog, not null.
  if (chosen === null || chosen === undefined || chosen === "") return;

  try {
    const realChosen = await ctx.realpath(chosen);
    const exportDir = resolveExportDir(realChosen, space.name);
    const problem = checkExportDir(exportDir, ctx.vaultBasePath);
    if (problem !== null) return ctx.notify(blockedMessage(problem));

    const plan = buildExportPlan({
      snapshot,
      vault: ctx.vault,
      links: ctx.links,
      isIgnored: ctx.isIgnored,
      isExcluded: ctx.isExcluded,
    });
    if (plan.collisions.length > 0) return ctx.notify(blockedMessage("collision"));

    const sink = ctx.makeSink(exportDir);
    if ((await sink.exists("")) && !(await sink.isEmptyDir(""))) {
      // Ours, or somebody's? The manifest is the only honest answer.
      if (!(await sink.exists(MANIFEST_FILENAME))) {
        return ctx.notify(blockedMessage("not-our-folder"));
      }
      // The path in the prompt is the path that gets removed, same string.
      if (!(await ctx.confirm(replaceConfirmPrompt(exportDir, space.name)))) return;
      await sink.removeDir("");
    }

    const manifest = buildSpaceManifest({
      space,
      order: ctx.order,
      entries: plan.entries,
      now: ctx.now(),
    });
    const outcome = await runExport({ plan, manifest, sink, readBinary: ctx.readBinary });
    ctx.notify(outcomeMessage(outcome, exportDir));
  } catch (e) {
    // A file where a folder was expected throws ENOTDIR, a locked file
    // throws mid-delete. Either would otherwise escape as an unhandled
    // rejection with nothing on screen.
    ctx.notify(`Export could not finish: ${e instanceof Error ? e.message : String(e)}`);
  }
}
