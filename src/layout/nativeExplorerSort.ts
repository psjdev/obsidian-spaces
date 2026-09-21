/**
 * PRIVATE API. `getSortedFolderItems`, `sort` and `requestSort` are not part of
 * obsidian.d.ts. This is the ONLY place in the codebase that reaches for the
 * file explorer's sort, so a future Obsidian change has exactly one repair
 * point — the same contract `nativeWorkspaces.ts` holds for
 * `app.internalPlugins`. Nothing outside this module may know they exist.
 *
 * Ordering goes through Obsidian's own sort rather than CSS `order` because the
 * explorer renders a window of roughly 49 rows regardless of tree size, and CSS
 * cannot position a row that is not in the DOM. Patching the comparator leaves
 * windowing, scrolling and drag ghosting Obsidian's problem, not ours.
 *
 * Measured against 1.13.7 in the fixture vault: `getSortedFolderItems(folder)`
 * returns one folder's children in display order; `requestSort()` is QUEUED, so
 * `sort()` is the direct path; and **unpatching alone does not revert the
 * visible order** — the tree keeps its last sorted result, so teardown must
 * `delete` the override AND force `sort()`, or disabling the plugin leaves rows
 * in a custom order.
 *
 * Every failure mode collapses to "unknown", which callers must treat as
 * not-enabled: native sort, the whole vault shown rather than nothing.
 */

import type { Permits } from "../visibility/folderSpace";

export type SortSeamStatus = "ok" | "unknown";

/** The shape we need, declared structurally so this file imports no Obsidian types. */
interface SortableExplorerView {
  getSortedFolderItems?: unknown;
  sort?: unknown;
  requestSort?: unknown;
  sortOrder?: unknown;
}

/** One entry as Obsidian hands it to us. Every field is treated as optional. */
export interface FolderItemLike {
  file?: { path?: string };
}

/**
 * The transform applied to a folder's items: filter, then order. Named
 * `TransformItems` rather than `Reorder` because it removes items as well.
 */
export type TransformItems = (folderPath: string, items: FolderItemLike[]) => FolderItemLike[];

type Original = (folder: unknown) => FolderItemLike[];

/**
 * The override WE installed, per patched view. Kept off the view itself: a
 * property bolted onto a host object is residue, and a disabled plugin must
 * leave none. A WeakMap also drops a view that goes away.
 *
 * It stores the override rather than the original because `unpatch` must answer
 * "is the own property still MINE?" — a co-installed plugin that patched the
 * same method after us owns it now, and deleting it would silently uninstall
 * someone else's feature. Restoring the original is `delete`'s job.
 */
interface Installed {
  override: Original;
  /**
   * Makes that override a pass-through, for when it cannot be lifted out of the
   * chain because another plugin wrapped it.
   */
  deactivate: () => void;
  /**
   * Obsidian's own sort for one folder, BELOW our override -- what the
   * override itself starts from. Resolved the same way, so a plugin that
   * wrapped the prototype after us is deferred to here too.
   */
  native: Original;
}

const installed = new WeakMap<object, Installed>();

/** Named once: three sites read it, and a typo in any of them would be silent. */
const SEAM = "getSortedFolderItems";

/** Once-only guard for the fail-closed path in `requestResort`. */
let requestResortWarned = false;

/** Once-only guard for the late-prototype-patch report, per session. */
let shadowWarned = false;

function asObject(view: unknown): (SortableExplorerView & object) | null {
  if (!view || typeof view !== "object") return null;
  return view;
}

/** Both methods must be callable. Absent or non-function → "unknown" → off. */
export function probe(view: unknown): SortSeamStatus {
  try {
    const v = asObject(view);
    if (!v) return "unknown";
    if (typeof v.getSortedFolderItems !== "function") return "unknown";
    if (typeof v.sort !== "function") return "unknown";
    return "ok";
  } catch {
    return "unknown";
  }
}

/**
 * The view's own tree item for each path, skipping any it does not know.
 *
 * Obsidian keeps an item for every path in the vault, not only rendered ones
 * (measured), so this is a lookup rather than a construction — a fabricated
 * item would render as a row with no behaviour.
 */
export function itemsForPaths(view: unknown, paths: readonly string[]): FolderItemLike[] {
  const map = (asObject(view) as { fileItems?: Record<string, FolderItemLike> } | null)
    ?.fileItems;
  if (!map) return [];
  const out: FolderItemLike[] = [];
  for (const p of paths) {
    const item = Object.prototype.hasOwnProperty.call(map, p) ? map[p] : undefined;
    if (item) out.push(item);
  }
  return out;
}

export function isPatched(view: unknown): boolean {
  const v = asObject(view);
  return v !== null && installed.has(v);
}

/**
 * Installs the override as an OWN property on the view instance, shadowing the
 * prototype. The prototype is never touched, so other views and future
 * instances are unaffected.
 *
 * Returns false — and does nothing — if the seam is absent or this view is
 * already patched: double-wrapping would nest the overrides and make teardown
 * restore an intermediate layer rather than the original.
 */
export function patch(view: unknown, transform: TransformItems, permits?: Permits): boolean {
  const v = asObject(view);
  if (!v || probe(v) !== "ok" || installed.has(v)) return false;

  // Probe the property before shadowing it, rather than assuming an assignment
  // is a shadow. Two shapes must be refused: an ACCESSOR own property, where
  // assigning would run somebody's setter and `delete` would not undo it; and a
  // non-configurable or read-only data property, which we could never remove.
  // Both collapse to "not patched", which callers already treat as the seam
  // being unavailable: native sort, whole vault, fail-open.
  const own = Object.getOwnPropertyDescriptor(v, SEAM);
  if (own && (typeof own.get === "function" || typeof own.set === "function")) return false;
  if (own && (own.configurable === false || own.writable === false)) return false;

  const original = v.getSortedFolderItems as Original;

  // Held only when `original` came from the PROTOTYPE chain: our own property
  // would otherwise shadow a patch a co-installed plugin puts on that prototype
  // AFTER us, so their comparator would never run and nothing would tell them.
  // Re-resolving through the prototype at CALL time defers to whatever is there
  // now. An own property already present is another plugin's INSTANCE patch —
  // `original` is theirs, and re-reading would step over them, not compose.
  //
  // One lookup and one identity compare per call. It assumes the other wrapper
  // calls the function it captured rather than re-entering
  // `view.getSortedFolderItems` — the only shape that could recurse, and the
  // same assumption every wrapper in this chain makes of the next.
  const protoAtPatch = own ? null : (Object.getPrototypeOf(v) as object | null);

  let warned = false;
  // If another plugin wraps this override after we install it, `unpatch` cannot
  // lift ours out of the middle of their chain without deleting their feature —
  // so it goes inert instead. This seam carries FILTERING as well as ordering,
  // so a buried wrapper would otherwise leave the tree still filtered after
  // spaces is disabled, and the tree must never show LESS than the space
  // should. `nativeSortMenu.ts` does the same thing for the same reason.
  let live = true;
  const resolveSource = (): Original => {
    if (!protoAtPatch) return original;
    const now = (protoAtPatch as { getSortedFolderItems?: unknown })[SEAM];
    if (typeof now !== "function" || now === original) return original;
    if (!shadowWarned) {
      shadowWarned = true;
      console.warn(
        "Spaces: another plugin patched the file explorer's sort after us. " +
          "Deferring to it rather than shadowing it; spaces still filter."
      );
    }
    return now as Original;
  };

  const override = function (this: unknown, folder: unknown): FolderItemLike[] {
    const source = resolveSource();
    const items = source.call(this, folder);
    if (!live) return items;
    try {
      // The argument is Obsidian's, so nothing about its shape is assumed.
      const path = (folder as { path?: unknown } | null)?.path;
      if (typeof path !== "string") return items;
      if (!Array.isArray(items)) return items;
      const out = transform(path, items);
      // Two gates, because this seam removes rows as well as reordering them:
      // every returned entry must either have come from the input (by OBJECT
      // IDENTITY, not path) or be one `permits` allows for this folder, and none
      // may appear twice. Identity alone catches a transform that fabricates a
      // row (a lie about the vault) or duplicates one — and with no `permits`
      // (every folder except an active folder space's vault root) it is the
      // whole guard.
      //
      // The permission gate exists for folder spaces, where the vault root is
      // legitimately answered with another folder's children — indistinguishable
      // from fabrication by identity alone. It is computed in a different file
      // (`visibility/folderSpace.ts`), so a bug in `transform` cannot disable
      // the guard it is checked against. But it is ITSELF decided from
      // `item.file?.path` alone, so at that one folder an item failing the
      // identity half can still pass by naming a real child or elsewhere path.
      // That gap is closed only by the production caller (`itemsForPaths`),
      // which never hands this seam an item it did not look up itself.
      if (!Array.isArray(out) || !isAllowed(out, items, path, permits)) return items;
      return out;
    } catch (e) {
      // A broken order must never break the tree. Log once — this runs on
      // every sort of every folder, and a per-call log would flood the console.
      if (!warned) {
        warned = true;
        console.error("Spaces: ordering failed; falling back to native sort", e);
      }
      return items;
    }
  };

  (v as { getSortedFolderItems: unknown })[SEAM] = override;
  installed.set(v, {
    override,
    deactivate: () => {
      live = false;
    },
    native: (folder) => resolveSource().call(v, folder),
  });
  return true;
}

/**
 * Every entry of `out` either came from `items`, or is one `permits` allows for
 * this folder — and no entry appears twice.
 *
 * Identity, not path, for the subset half: two items claiming the same path are
 * exactly the duplication this rejects, and comparing by path would let a
 * fabricated item pass by wearing a real one's name. `permits` is therefore a
 * SECOND gate, not a reason to loosen this one to a path comparison.
 *
 * Unlike the subset half, the permission half IS decided by path —
 * `permits(folderPath, item.file?.path)` never sees the item itself (see
 * `makePermits`, folderSpace.ts) — because a folder space legitimately answers
 * the vault root with another folder's children. So at that root an item that
 * fails the identity check can still pass here by naming a real child or a
 * named elsewhere path: deliberate, and it means nothing here confirms an item
 * is genuine. That is left to the one production caller (`itemsForPaths`),
 * which only ever hands this seam items it looked up itself.
 */
function isAllowed(
  out: readonly FolderItemLike[],
  items: readonly FolderItemLike[],
  folderPath: string,
  permits: Permits | undefined
): boolean {
  const allowed = new Set<FolderItemLike>(items);
  const seen = new Set<FolderItemLike>();
  for (const item of out) {
    if (seen.has(item)) return false;
    if (!allowed.has(item) && !permits?.(folderPath, item.file?.path)) return false;
    seen.add(item);
  }
  return true;
}

/**
 * Removes the override and forces a re-sort.
 *
 * The forced `sort()` is not optional: `delete` restores the original method
 * but the tree keeps its last sorted result, so without this the rows stay in
 * the custom order after teardown (measured).
 */
export function unpatch(view: unknown): void {
  const v = asObject(view);
  const entry = v ? installed.get(v) : undefined;
  if (!v || !entry) return;
  installed.delete(v);
  // Deactivated FIRST and unconditionally, so the override is a pass-through
  // from this moment whether or not it can be removed below.
  entry.deactivate();
  try {
    // Only remove the own property if it is STILL ours. If another plugin
    // patched the same method after we did, that own property is theirs, and
    // deleting it would uninstall their feature along with ours. Ours stays
    // buried in their closure, but `deactivate()` above already made it a
    // pass-through, so it filters and orders nothing.
    if ((v as { getSortedFolderItems?: unknown }).getSortedFolderItems === entry.override) {
      delete (v as { getSortedFolderItems?: unknown }).getSortedFolderItems;
    } else {
      console.warn(
        "Spaces: the file explorer's sort was re-patched by something else; " +
          "leaving it in place rather than removing another plugin's override. " +
          "Ours is now inert and passes rows through untouched."
      );
    }
  } catch {
    // A non-configurable property should be impossible for an own property we
    // assigned, but failing here must not skip the re-sort below.
  }
  try {
    const sort = v.sort;
    if (typeof sort === "function") (sort as () => void).call(v);
  } catch {
    // Nothing useful to do: the override is already gone, so the next sort
    // Obsidian performs for any other reason will be native.
  }
}

/**
 * The folder's children as OBSIDIAN would sort them, under our override, or
 * null when this view is not patched or the call fails.
 *
 * The counterpart to `displayedPaths`, which deliberately returns what is on
 * screen: this returns what the sort mode alone says, with our filtering and
 * ordering not yet applied.
 *
 * It exists for the folder-space hoist. That path answers the vault root with
 * another folder's children, and building them from `TFolder.children` read
 * the vault's own array instead of the sort -- so a folder space rendered in
 * the same order whatever mode was picked, and looked correct only because
 * that array is usually alphabetical.
 */
export function nativeSortedItems(view: unknown, folder: unknown): FolderItemLike[] | null {
  try {
    const v = asObject(view);
    const entry = v ? installed.get(v) : undefined;
    if (!entry) return null;
    const items = entry.native(folder);
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

/**
 * The folder's children in the order currently DISPLAYED, or null if the seam
 * is unavailable.
 *
 * Through the seam rather than the DOM: past roughly fifty rows the explorer
 * windows its output, so reading the DOM would freeze a partial order and the
 * unrendered children would silently fall to the bottom on the first drag.
 *
 * When the patch is installed this returns OUR order, which is the right
 * answer: "displayed" means what is on screen, not what Obsidian would sort to.
 */
export function displayedPaths(view: unknown, folder: unknown): string[] | null {
  try {
    const v = asObject(view);
    if (!v || typeof v.getSortedFolderItems !== "function") return null;
    const items = (v.getSortedFolderItems as Original).call(v, folder);
    if (!Array.isArray(items)) return null;
    const out: string[] = [];
    for (const item of items) {
      const p = (item satisfies FolderItemLike)?.file?.path;
      if (typeof p === "string") out.push(p);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Asks Obsidian to re-sort, and this MUST be the direct `sort()`.
 *
 * Measured in the fixture vault: after an order changes, the queued
 * `requestSort()` leaves a WINDOWED folder's rendered rows stale — the seam
 * returned the new order while the DOM still showed the old first five rows,
 * and `sort()` re-rendered them immediately. So `requestSort` is kept only as a
 * fallback for a view that somehow lacks `sort`, which `probe` already refuses.
 * The cost is a synchronous sort per refresh: the same work the explorer does
 * on its own sort.
 *
 * Returns whether a re-sort was actually asked for, which the memo needs: a
 * memo that recorded a signature as applied when the sort THREW would skip the
 * retry the next event would otherwise have made, and leave the previous
 * filter on screen indefinitely.
 */
export function requestResort(view: unknown): boolean {
  try {
    const v = asObject(view);
    if (!v) return false;
    const sort = v.sort;
    if (typeof sort === "function") {
      (sort as () => void).call(v);
      return true;
    }
    const req = v.requestSort;
    if (typeof req === "function") {
      (req as () => void).call(v);
      return true;
    }
    return false;
  } catch (e) {
    // A fail-CLOSED risk, not a cosmetic one: a failed re-sort leaves the
    // previous FILTER on screen, not just the previous order. Switch from a
    // three-row space to a wider one and the pane keeps showing three rows —
    // LESS than the current space should, the one direction never acceptable.
    // Swallowed rather than propagated (a broken re-sort must not break the
    // tree), but logged once — this can be called on every commit.
    if (!requestResortWarned) {
      requestResortWarned = true;
      console.error("Spaces: forced re-sort failed; the previous filter may be stale", e);
    }
    return false;
  }
}

/**
 * Obsidian's own sort mode for this explorer view.
 *
 * PRIVATE. `sortOrder` is absent from `obsidian.d.ts`, which is why this lives
 * in the quarantine with the rest of the seam. Measured against 1.13.7:
 * `"alphabetical"`, and `setSortOrder` sits beside it on the prototype.
 *
 * Null for anything unexpected, which here means "no gesture" — spaces must
 * never override a space because a private property moved.
 */
export function readSortOrder(view: unknown): string | null {
  if (!view || typeof view !== "object") return null;
  const v = (view as SortableExplorerView).sortOrder;
  return typeof v === "string" ? v : null;
}
