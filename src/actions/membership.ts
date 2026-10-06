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

/**
 * What a membership notice calls what it just acted on.
 *
 * One is named. The name is shorter than a count and says more: "Added
 * plan.md to Work" confirms which note, so a misclick on the wrong row is
 * obvious from the toast. A count of one would read "1 notes and folders",
 * and fixing that with a singular branch would still say less than the name.
 *
 * Several are counted, because listing them would outrun a toast. "notes and
 * folders" rather than one kind, because a multi-select can hold both and
 * counting them separately is more words for no more meaning.
 */
function subject(files: TAbstractFile[]): string {
  return files.length === 1 ? files[0].name : `${files.length} notes and folders`;
}

/**
 * What to say after an add, counting only what changed.
 *
 * The dedupe in `addToSpace` and `addAll` is silent by design, and the notice
 * used to report the whole batch regardless -- "Added plan.md to Work" for a file the
 * space already held. A drop on a space icon makes that easy to hit, so the
 * notice reports the outcome instead of the request.
 *
 * `is`/`are` rather than one spelling: "3 notes and folders is already in
 * Work" reads as a bug in the plugin rather than a fact about the space.
 */
export function addOutcomeMessage(
  added: readonly TAbstractFile[],
  already: readonly TAbstractFile[],
  spaceName: string
): string {
  if (added.length > 0) return `Added ${subject([...added])} to ${spaceName}`;
  if (already.length > 0) {
    const verb = already.length === 1 ? "is" : "are";
    return `${subject([...already])} ${verb} already in ${spaceName}`;
  }
  return `Nothing to add to ${spaceName}`;
}

/**
 * Splits a batch into what an add would change and what the space already
 * holds, each counting DISTINCT paths.
 *
 * Distinct by `canonicalPath`, the same fold `samePath` uses, because the
 * write loop skips a path it has just written: a batch of `[a.md, a.md]` (or
 * `A.md` and `a.md` on a filesystem that allows both) writes one member, so
 * counting both as added would make the notice say "Added 2 notes and folders"
 * for a single change.
 */
function splitBatch(
  files: readonly TAbstractFile[],
  held: readonly { path: string }[]
): { added: TAbstractFile[]; already: TAbstractFile[] } {
  const seen = new Set<string>();
  const added: TAbstractFile[] = [];
  const already: TAbstractFile[] = [];
  for (const f of files) {
    const key = canonicalPath(f.path);
    if (seen.has(key)) continue;
    seen.add(key);
    (held.some((m) => samePath(m.path, f.path)) ? already : added).push(f);
  }
  return { added, already };
}

async function addAll(ctx: MembershipContext, files: TAbstractFile[]): Promise<void> {
  const space = ctx.controller.activeSpace();
  if (!space) return;
  // Split BEFORE the write, against the space as it is now, for the same
  // reason as in `addToSpace`: reading it back afterwards cannot tell a path
  // this call added from one that was already there.
  const current = ctx.defs.get().spaces.find((s) => s.id === space.id);
  const held = current ? pathMembers(current) : [];
  const { added, already } = splitBatch(files, held);
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
  new Notice(addOutcomeMessage(added, already, space.name));
}

/**
 * Adds to a space named by id rather than to the active one, which is
 * what *All* needs — there is no active space there. Each of the two
 * resolves its own space, `addAll` from the active one and this by id, and
 * that separation is deliberate: `addAll` reads the active space and must
 * keep doing so. What they share is `entryFor`, `splitBatch` and
 * `addOutcomeMessage`, because those are rules rather than lookups, and a
 * rule written twice lands on one path and not the other.
 */
export async function addToSpace(
  ctx: MembershipContext,
  spaceId: string,
  files: TAbstractFile[]
): Promise<void> {
  const name = ctx.defs.get().spaces.find((s) => s.id === spaceId)?.name ?? spaceId;
  if (files.length === 0) return;
  // Split BEFORE the write, against the space as it is now. Reading it back
  // afterwards cannot tell a path this call added from one that was already
  // there.
  const current = ctx.defs.get().spaces.find((s) => s.id === spaceId);
  const held = current ? pathMembers(current) : [];
  const { added, already } = splitBatch(files, held);
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
  new Notice(addOutcomeMessage(added, already, name));
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
  new Notice(`Removed ${subject(files)} from ${space.name}`);
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
