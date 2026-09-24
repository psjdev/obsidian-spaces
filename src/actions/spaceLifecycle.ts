import type { DefinitionStore } from "../definitions/DefinitionStore";
import {
  DEFAULT_SPACE_COLOR,
  PALETTE,
  isIconIdShape,
  normalizeHex,
} from "../definitions/appearance";
import { RESERVED_IDS } from "../definitions/schema";
import type { MemberEntry } from "../types";

/**
 * `PALETTE`, `PALETTE_NAMES`, `isIconIdShape` and `normalizeHex` live in
 * `definitions/appearance.ts`: importing the two validators from `ui/` had
 * the application layer reading its `data.json` validation out of the view
 * layer, while five `ui/` modules imported this file back. Re-exported here
 * so `main.ts`, `ui/CreateSpacePanel.ts` and `ui/ColorPickerPopover.ts` keep
 * compiling; the shim is meant to be deleted once those import from
 * `definitions/appearance` directly.
 */
export { PALETTE, PALETTE_NAMES, DEFAULT_SPACE_COLOR } from "../definitions/appearance";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/**
 * Canonicalise a member path the way Obsidian's own `normalizePath()`
 * would — collapse doubled separators, strip leading/trailing slashes, and
 * NFC-normalize unicode — so `"Projects//Console 2030"` or
 * `"/Projects/Console 2030"` land as the same string a real vault path uses.
 * This is NOT a call to the real `normalizePath()`: this module is pure by
 * design (no `"obsidian"` import — see `src/actions/membershipMenu.ts`'s
 * structural-interface pattern), and
 * `tests/spaceLifecycle.test.ts` runs in plain node, where the "obsidian"
 * package on disk is type declarations only (`main: ""`, no runtime) — an
 * import of `normalizePath` from it would resolve to `undefined` and throw
 * the instant this ran under vitest. Kept deliberately narrow: it covers the
 * two malformations it targets, not the full breadth of the real function.
 */
function normalizeMemberPath(path: string): string {
  return path.normalize("NFC").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * The color swatch is pre-selected to the next in rotation so it
 * matches today's auto-assignment. This is the one formula for that rotation,
 * so no renderer need reimplement it.
 */
export function nextPaletteColor(spaceCount: number): string {
  // Skips PALETTE[0], the neutral swatch. The rotation exists so consecutive
  // spaces are distinguishable at a glance; handing out grey one turn in six
  // defeats the only thing it is for. Neutral stays a deliberate choice in
  // the picker, never an assignment.
  //
  // Rotating `PALETTE.slice(1)` keeps the order and starting point of the
  // vivid colors. The SEQUENCE is not frozen, and is not meant to be:
  // dropping green from the palette shortened it, so a given count now lands
  // on a different color than it once did. That moves nothing already
  // stored — a space keeps the hex it was created with, and an unlisted
  // color still renders — it only changes what the next new space is
  // offered.
  const vivid = PALETTE.slice(1);
  return vivid[spaceCount % vivid.length];
}

/**
 * The color a newly created space starts on — the whole of the
 * `autoAssignColor` preference, in one place.
 *
 * ON hands back exactly what `nextPaletteColor` would have on its own, so the
 * setting is "the behaviour as it was" rather than a second sequence that
 * merely resembles it. OFF hands back the neutral swatch, which is
 * `PALETTE[0]` and therefore the FIRST one in the color popover's grid — so
 * the popover opens with its selection already on the color the space has,
 * instead of highlighting one swatch while the space wears another.
 *
 * Pure, and separate from the toggle that feeds it, because
 * `SettingsTab.display()` cannot be driven under the obsidian stub. Keeping
 * the decision here leaves the untestable part reading a boolean and passing
 * it on.
 */
export function startingSpaceColor(autoAssign: boolean, spaceCount: number): string {
  return autoAssign ? nextPaletteColor(spaceCount) : DEFAULT_SPACE_COLOR;
}

/**
 * Settings' existing call keeps today's defaults.
 *
 * `root`: present only for a folder space, absent for a curated
 * one — mirroring `SpaceDefinition.root` itself (types.ts). Not validated
 * here for USABILITY (that is `rootOf`'s call, at read time); `createSpace`
 * only normalizes it the way it already normalizes a member path, because
 * both are vault paths handed in by the same two producers (the folder
 * chooser's suggester and a real `TFolder.path` from the context menu).
 */
export interface CreateSpaceOptions {
  icon?: string;
  color?: string;
  members?: MemberEntry[];
  root?: string;
}

export interface SpaceLifecycleHooks {
  onDeleted?(id: string): void;
}

export async function createSpace(
  defs: DefinitionStore,
  name: string,
  opts?: CreateSpaceOptions
): Promise<string> {
  const base = slugify(name) || "space";
  let id = base;

  await defs.mutate((d) => {
    // Inside the queue, not outside it. `mutate` clones the CURRENT document
    // when the callback finally runs, so an id chosen from an earlier snapshot
    // can collide with a create that landed in between, and the whole mutation
    // is then rejected as a duplicate. The reserved ids are seeded too: a space
    // named "Constructor" slugifies to one of them, which the schema refuses.
    const taken = new Set<string>([...RESERVED_IDS, ...d.spaces.map((s) => s.id)]);
    id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    d.spaces.push({
      id,
      name: name.trim() || "Untitled space",
      icon: opts?.icon ?? "box",
      color: opts?.color ?? nextPaletteColor(d.spaces.length),
      // Copy, never adopt: a caller that keeps mutating its own list must not
      // silently edit a space it already created. Normalize the path here:
      // data.json is real, synced, hand-editable config, and
      // isSafeVaultPath() in schema.ts validates format without
      // canonicalising, so an un-normalized member written here would
      // silently never match a real vault path.
      members: (opts?.members ?? []).map((m) => ({ path: normalizeMemberPath(m.path), kind: m.kind })),
      // Same normalization as members, same reason — a root
      // is a vault path too. Omitted entirely rather than written as `""`
      // when absent, so a curated space's stored shape is unchanged from
      // before this field existed (`hasRoot`, folderSpace.ts, keys off the
      // field's presence, not its value).
      ...(opts?.root === undefined ? {} : { root: normalizeMemberPath(opts.root) }),
    });
  });
  return id;
}

export async function deleteSpace(
  defs: DefinitionStore,
  id: string,
  hooks?: SpaceLifecycleHooks
): Promise<void> {
  await defs.mutate((d) => {
    d.spaces = d.spaces.filter((s) => s.id !== id);
    // The price of keeping `orders` top-level rather than nested inside each
    // SpaceDefinition: nothing else clears it, so a deleted space's order map
    // would outlive it and be re-attached if the same id were ever minted
    // again (`createSpace` de-duplicates ids, so that is reachable).
    // Only the id needs removing: `validateOrders` drops an emptied
    // `bySpaceId` and an emptied `orders` on the way through, so tidying them
    // here would be code that cannot be observed to do anything, and
    // unreachable defensive code reads as load-bearing.
    if (d.orders?.bySpaceId) delete d.orders.bySpaceId[id];
  });
  // `mutate()` runs BEFORE `onDeleted`, and
  // `main.ts`'s `onDeleted` hook (which calls `dropSortOverrideFor`) relies on
  // that order — see the comment there. `mutate()`'s notify fires synchronously
  // from inside this call, before `onDeleted` below runs, so `controller.refresh()`
  // (and so `host.apply` / `applyFilterAndOrdering()`) already sees `defs.get()`
  // with the space removed — which is what lets `onDeleted`'s cleanup skip
  // forcing a re-sort of its own. Reversing this call order (hook before mutate)
  // would run that cleanup before the active-space lookup reflects the deletion.
  hooks?.onDeleted?.(id);
}

/**
 * Validates the SHAPE of the id, not membership of a fixed list: the
 * picker now searches every icon Obsidian has registered (~1500), so a
 * whitelist would have to be that same list and would go stale the moment
 * Obsidian shipped another one.
 *
 * A shape guard still earns its place — `validateSpace` accepts any string up
 * to 64 characters, so without it a stray value persists happily. What it
 * cannot promise is that the id EXISTS, and an unknown id draws no glyph at
 * all; `renderableIcon` covers that at render time instead, which also handles
 * a `data.json` written by a future version with icons this build lacks.
 */
export async function setSpaceIcon(
  defs: DefinitionStore,
  id: string,
  icon: string
): Promise<void> {
  if (!isIconIdShape(icon)) {
    throw new Error(`Spaces: ${icon} is not a valid icon id`);
  }
  await defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === id);
    if (s) s.icon = icon;
  });
}

/**
 * `validateSpace` rejects a bad color outright, so
 * without this a mistyped value would fail the whole write rather than this one
 * field, and the space would silently keep its old color with no explanation.
 */
export async function setSpaceColor(
  defs: DefinitionStore,
  id: string,
  color: string
): Promise<void> {
  const hex = normalizeHex(color);
  if (!hex) throw new Error(`Spaces: ${color} is not a color`);
  await defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === id);
    if (s) s.color = hex;
  });
}

export async function renameSpace(
  defs: DefinitionStore,
  id: string,
  name: string
): Promise<void> {
  await defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === id);
    if (s) s.name = name.trim() || s.name;
  });
}

/**
 * The validated write path for changing — or clearing — a folder space's
 * root ("Change folder…", opened from `main.ts`'s missing-root Notice).
 * Normalizes with `normalizeMemberPath`, same as `createSpace` does for
 * `opts.root`, so a root chosen here can never diverge into a second,
 * differently-normalized shape.
 *
 * An empty string is a valid write: it returns the space to "no folder
 * chosen yet" rather than deleting the `root` field, which would silently
 * reclassify a folder space as an empty curated one. So this ALWAYS assigns
 * `s.root`, never `delete`s it.
 *
 * Usability — does the path resolve to a real folder now — is deliberately
 * NOT checked here; that is `rootOf`'s call at READ time.
 *
 * A no-op when `s.root` is not already a string: this setter only changes
 * an EXISTING folder space's root, not turns a curated one into a folder
 * space as a side effect.
 */
export async function setSpaceRoot(
  defs: DefinitionStore,
  id: string,
  root: string
): Promise<void> {
  const normalized = normalizeMemberPath(root);
  await defs.mutate((d) => {
    const s = d.spaces.find((x) => x.id === id);
    if (s && typeof s.root === "string") s.root = normalized;
  });
}
