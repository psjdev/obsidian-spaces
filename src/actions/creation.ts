import { Notice, TFolder, normalizePath, type App } from "obsidian";
import { canonicalPath } from "../visibility/glob";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { SpaceController } from "../controller/SpaceController";
import { isFolderSpace } from "../visibility/folderSpace";
import { pathMembers } from "../definitions/membership";

interface CreationContext {
  defs: DefinitionStore;
  controller: SpaceController;
}

/**
 * The policy, with no lookups and no fallback of its own: given a space's
 * root and whether that root is a real folder right now, where should a new
 * file go?
 *
 * `path: null` means "use your own fallback" — deliberately NOT "ask
 * `getNewFileParent`", because one of this function's two callers IS
 * `getNewFileParent` (`newFileLocation.ts` patches it). An earlier version
 * folded the fallback in here; the patched method then called back into it
 * and recursed until the stack blew, raising a Notice per cycle. Keeping the
 * fallback lazy and outside is what makes the same rule safe for both.
 */
export function pinnedDestination(
  root: string | undefined,
  rootIsFolder: boolean
): { path: string | null; missingRoot: boolean } {
  // A curated space has no root and is not in an error state — it simply has
  // no write target of its own, so the caller's default stands.
  if (!root) return { path: null, missingRoot: false };
  if (rootIsFolder) return { path: root, missingRoot: false };
  // Spec the missing-root state: declared, but not there any more.
  return { path: null, missingRoot: true };
}

/** Whether `root` names a real folder in the vault right now. */
export function rootIsFolder(app: App, root: string): boolean {
  return app.vault.getAbstractFileByPath(root) instanceof TFolder;
}

export function noticeMissingRoot(): void {
  new Notice("Spaces: this space's folder is missing.");
}

// Exported: a pure decision worth pinning directly (tests/creation.test.ts),
// rather than only through the two creation commands below, which also touch
// the vault via `app.vault.create`/`createFolder`.
export function destinationFolder(app: App, root: string | undefined): string {
  const out = pinnedDestination(root, root ? rootIsFolder(app, root) : false);
  if (out.missingRoot) noticeMissingRoot();
  // Lazy on purpose: only asked for when the root cannot be honoured, which
  // is what keeps this from calling a patched `getNewFileParent` needlessly.
  return out.path ?? app.fileManager.getNewFileParent("").path;
}

async function ensureMember(
  ctx: CreationContext,
  spaceId: string,
  path: string,
  kind: "file" | "folder"
): Promise<void> {
  const snap = ctx.controller.currentSnapshot();
  if (snap?.decisionFor(path).visible) return; // already inherited
  await ctx.defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === spaceId);
    // The same one case policy as `membership.ts`. Reached only
    // when the snapshot above did NOT already report the path visible, so this
    // is the second line of the same guard rather than a separate defect.
    if (s && !pathMembers(s).some((m) => canonicalPath(m.path) === canonicalPath(path))) {
      s.members.push({ path, kind });
    }
  });
}

export async function newNoteInActiveSpace(
  app: App,
  ctx: CreationContext
): Promise<void> {
  const space = ctx.controller.activeSpace();
  if (!space) {
    new Notice("Spaces: switch to a space first.");
    return;
  }
  const dir = destinationFolder(app, space.root);
  const base = dir === "/" || dir === "" ? "" : `${dir}/`;

  let path = normalizePath(`${base}Untitled.md`);
  let n = 1;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${base}Untitled ${++n}.md`);
  }

  let file;
  try {
    file = await app.vault.create(path, "");
  } catch (e) {
    new Notice(`Spaces: could not create note (${String(e)})`);
    return;
  }
  try {
    // A folder space has no member list: anything created under its root is
    // already in the space by definition, and writing a record for it would
    // reintroduce exactly the state the design removed.
    if (!isFolderSpace(space)) await ensureMember(ctx, space.id, file.path, "file");
  } catch (e) {
    // The file exists (spaces never deletes vault content). Only membership
    // failed, so still open it and tell the user why it may not be filtered.
    new Notice(
      `Spaces: note created, but could not add it to the space (${String(e)})`
    );
  }
  await app.workspace.getLeaf(false).openFile(file);
}

export async function newFolderInActiveSpace(
  app: App,
  ctx: CreationContext
): Promise<void> {
  const space = ctx.controller.activeSpace();
  if (!space) {
    new Notice("Spaces: switch to a space first.");
    return;
  }
  const dir = destinationFolder(app, space.root);
  const base = dir === "/" || dir === "" ? "" : `${dir}/`;

  let path = normalizePath(`${base}New folder`);
  let n = 1;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${base}New folder ${++n}`);
  }

  try {
    await app.vault.createFolder(path);
  } catch (e) {
    new Notice(`Spaces: could not create folder (${String(e)})`);
    return;
  }
  try {
    // A folder space has no member list: anything created under its root is
    // already in the space by definition, and writing a record for it would
    // reintroduce exactly the state the design removed.
    if (!isFolderSpace(space)) await ensureMember(ctx, space.id, path, "folder");
  } catch (e) {
    // The folder exists (spaces never deletes vault content). Only membership
    // failed.
    new Notice(
      `Spaces: folder created, but could not add it to the space (${String(e)})`
    );
  }
}
