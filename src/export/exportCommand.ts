import type { OrderMap, SpaceDefinition } from "../types";
import type { VaultIndex } from "../visibility/VaultIndex";
import type { VisibilitySnapshot } from "../visibility/VisibilityEngine";
import type { ConfirmPrompt } from "../ui/settingsEdits";
import type { ExportSink } from "./ExportSink";
import { buildExportPlan } from "./exportPlan";
import { MANIFEST_FILENAME, buildSpaceManifest, spaceIdOfManifest } from "./spaceManifest";
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
  /**
   * Whether this is a folder space whose root is declared but is not a
   * folder in the vault. Not merely whether `rootOf` answers null: that is
   * true only for an empty or vault-root value and never consults the
   * vault at all.
   */
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
 * Exports one space.
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
/** `realpath` where it resolves, the original where it does not yet exist. */
async function resolveIfPresent(ctx: ExportContext, p: string): Promise<string> {
  try {
    return await ctx.realpath(p);
  } catch {
    return p;
  }
}

export async function exportSpace(ctx: ExportContext): Promise<void> {
  const { space, snapshot } = ctx;
  if (space === null) return ctx.notify(blockedMessage("no-space"));
  if (snapshot === null) return ctx.notify(blockedMessage("indexing"));
  const progress = ctx.parseProgress();
  if (progress !== null && progress > 0) return ctx.notify(blockedMessage("indexing"));
  if (ctx.rootMissing) return ctx.notify(blockedMessage("missing-root"));

  try {
    const chosen = await ctx.pickDir();
    // `showOpenDialog` yields `undefined` for a cancelled dialog, not null.
    if (chosen === null || chosen === undefined || chosen === "") return;
    const realChosen = await ctx.realpath(chosen);
    const exportDir = resolveExportDir(realChosen, space.name);
    // Both sides resolved, or the comparison is only as good as its
    // spelling. The export folder is resolved SEPARATELY from the folder
    // the user picked: a junction at `<chosen>/<SpaceName>` is a different
    // link from the one on its parent, and resolving only the parent left
    // it able to point into the vault. It may not exist yet on a first
    // export, which is not an error, so an unresolvable path is used as
    // given.
    const realExportDir = await resolveIfPresent(ctx, exportDir);
    const realVault = ctx.vaultBasePath === null
      ? null
      : await resolveIfPresent(ctx, ctx.vaultBasePath);
    const problem = checkExportDir(realExportDir, realVault);
    if (problem !== null) return ctx.notify(blockedMessage(problem));

    const plan = buildExportPlan({
      snapshot,
      vault: ctx.vault,
      links: ctx.links,
      isIgnored: ctx.isIgnored,
      isExcluded: ctx.isExcluded,
    });
    if (plan.collisions.length > 0) return ctx.notify(blockedMessage("collision"));

    const sink = ctx.makeSink(realExportDir);
    // ANY folder that is already there is flagged, empty or not. A folder
    // the user made earlier is still a folder they made on purpose, and the
    // only case worth writing into without a word is one that does not
    // exist yet. An existing folder is then either ours, which the replace
    // confirmation handles, or theirs, which is refused.
    if (await sink.exists("")) {
      // Ours, or somebody's? The manifest's space id is the only honest
      // answer. Its mere presence is not: space names are not unique and
      // `safeFolderName` is lossy, so `Work/2026` and `Work-2026` share a
      // destination, and accepting any manifest would delete one space's
      // export while telling the user it was replacing the other's.
      const existingId = spaceIdOfManifest(await sink.readText(MANIFEST_FILENAME));
      if (existingId === null) return ctx.notify(blockedMessage("not-our-folder"));
      if (existingId !== space.id) return ctx.notify(blockedMessage("another-space"));
      // The path in the prompt is the path that gets removed, same string.
      if (!(await ctx.confirm(replaceConfirmPrompt(realExportDir, space.name)))) return;
      await sink.removeDir("");
    }

    const manifest = buildSpaceManifest({
      space,
      order: ctx.order,
      entries: plan.entries,
      now: ctx.now(),
    });
    const outcome = await runExport({ plan, manifest, sink, readBinary: ctx.readBinary });
    ctx.notify(outcomeMessage(outcome, realExportDir));
  } catch (e) {
    // A file where a folder was expected throws ENOTDIR, a locked file
    // throws mid-delete. Either would otherwise escape as an unhandled
    // rejection with nothing on screen.
    ctx.notify(`Export could not finish: ${e instanceof Error ? e.message : String(e)}`);
  }
}
