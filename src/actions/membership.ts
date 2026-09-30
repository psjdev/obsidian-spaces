import { Notice, TFolder, type Menu, type TAbstractFile, type Plugin } from "obsidian";
import { canonicalPath } from "../visibility/glob";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { SpaceController } from "../controller/SpaceController";
import type { MemberEntry, SpaceDefinition } from "../types";
import type { TagIndex } from "../visibility/TagIndex";
import { decorate as decorateMenu } from "./membershipMenu";
import { removeMembers } from "./definitionWrites";
import { pathMembers } from "../definitions/membership";

interface MembershipContext {
  defs: DefinitionStore;
  controller: SpaceController;
}

/**
 * Whether a stored member entry names the same file as a live path, under the
 * single case-insensitive policy that applies everywhere paths are compared.
 *
 * `canonicalPath` from `src/visibility/glob.ts` rather than a second fold
 * here: there must be ONE definition of "the same path". On the ADD side this stops a second entry appearing for a path the
 * space already holds in another casing — the row would be a duplicate the
 * user never asked for, and only one of the two would ever be removable.
 */
function samePath(a: string, b: string): boolean {
  return a === b || canonicalPath(a) === canonicalPath(b);
}

function entryFor(f: TAbstractFile): MemberEntry {
  return { path: f.path, kind: f instanceof TFolder ? "folder" : "file" };
}

async function addAll(ctx: MembershipContext, files: TAbstractFile[]): Promise<void> {
  const space = ctx.controller.activeSpace();
  if (!space) return;
  try {
    await ctx.defs.mutate((d) => {
      const target = d.spaces.find((s) => s.id === space.id);
      if (!target) return;
      for (const f of files) {
        if (!pathMembers(target).some((m) => samePath(m.path, f.path))) {
          target.members.push(entryFor(f));
        }
      }
    });
  } catch (e) {
    new Notice(`Spaces: could not add to ${space.name} (${String(e)})`);
    return;
  }
  new Notice(`Added ${files.length} to ${space.name}`);
}

/**
 * Adds to a space named by id rather than to the active one, which is
 * what *All* needs — there is no active space there. Shares nothing with
 * `addAll` beyond `entryFor`, deliberately: `addAll` reads the active space
 * and must keep doing so.
 */
async function addToSpace(
  ctx: MembershipContext,
  spaceId: string,
  files: TAbstractFile[]
): Promise<void> {
  const name = ctx.defs.get().spaces.find((s) => s.id === spaceId)?.name ?? spaceId;
  if (files.length === 0) return;
  try {
    await ctx.defs.mutate((d) => {
      const target = d.spaces.find((s) => s.id === spaceId);
      if (!target) return;
      for (const f of files) {
        if (!pathMembers(target).some((m) => samePath(m.path, f.path))) {
          target.members.push(entryFor(f));
        }
      }
    });
  } catch (e) {
    new Notice(`Spaces: could not add to ${name} (${String(e)})`);
    return;
  }
  new Notice(`Added ${files.length} to ${name}`);
}

/**
 * The removal itself lives in `definitionWrites.ts`, not here.
 * `SettingsTab.ts`'s per-row Remove button held a second, separately written
 * copy of this filter; a rule added to one of them (dropping the removed path
 * from the space's `orders` map is the obvious next one) would have landed on
 * one path and not the other. What stays here is what is local: the
 * active space, and what the user is told.
 */
async function removeAll(ctx: MembershipContext, files: TAbstractFile[]): Promise<void> {
  const space = ctx.controller.activeSpace();
  if (!space) return;
  try {
    await removeMembers(ctx.defs, space.id, files.map((f) => f.path));
  } catch (e) {
    new Notice(`Spaces: could not remove from ${space.name} (${String(e)})`);
    return;
  }
  new Notice(`Removed ${files.length} from ${space.name}`);
}

export function decorate(menu: Menu, ctx: MembershipContext, files: TAbstractFile[]): void {
  const decorateCtx = {
    controller: ctx.controller,
    spaces: (): readonly SpaceDefinition[] => ctx.defs.get().spaces,
    // The controller's own snapshot, so *All*'s "Add to space" answers from
    // the same picture the tree was drawn from. Lazy behind
    // `createLazyTagIndex`, so a vault whose spaces hold no tag member pays
    // nothing for opening a context menu.
    tags: (): TagIndex => ctx.controller.tagIndex(),
  };
  decorateMenu(menu, decorateCtx, files, {
    addAll: (fs) => void addAll(ctx, fs),
    addToSpace: (spaceId, fs) => void addToSpace(ctx, spaceId, fs),
    removeAll: (fs) => void removeAll(ctx, fs),
    // Dismissing a visitor only clears its reveal, so it goes straight
    // to the controller and never touches DefinitionStore/membership.
    dismissAll: (fs) => {
      for (const f of fs) ctx.controller.dismissRevealed(f.path);
    },
  });
}

export function registerMembershipMenus(plugin: Plugin, ctx: MembershipContext): void {
  plugin.registerEvent(
    plugin.app.workspace.on("file-menu", (menu, file) => decorate(menu, ctx, [file]))
  );
  plugin.registerEvent(
    plugin.app.workspace.on("files-menu", (menu, files) => decorate(menu, ctx, files))
  );
}
