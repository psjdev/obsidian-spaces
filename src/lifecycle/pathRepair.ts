import type {
  MemberEntry,
  OrderMap,
  SpaceDefinition,
  SpaceOrders,
  SpacesDefinitions,
} from "../types";
import { canonicalPath } from "../visibility/glob";


function rewritePrefix(path: string, oldBase: string, newBase: string): string {
  if (path === oldBase) return newBase;
  if (path.startsWith(oldBase + "/")) {
    return newBase + path.slice(oldBase.length);
  }
  return path;
}

function dedupe(members: MemberEntry[]): MemberEntry[] {
  const seen = new Set<string>();
  const out: MemberEntry[] = [];
  for (const m of members) {
    const key = m.kind === "tag" ? "t:" + m.tag : "p:" + m.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}


/**
 * A space's exclusions, followed through a rename.
 *
 * `exclude` holds LITERAL vault paths, so it is rewritten by the same
 * `rewritePrefix` the member paths use — which is also what makes a renamed
 * folder carry its excluded descendants with it. Left unrewritten, the
 * excluded note reappears in the space the moment it moves, the dead entry
 * accumulates under the contents dialog's "Left out" list, and whatever
 * later occupies the old path is excluded in its place.
 *
 * De-duplicated on the CANONICAL path, matching how the engine and
 * `resolveMembers` compare exclusions: a rename can make two entries name one
 * note (`A/x.md` and `B/x.md`, renaming `A` to `B`), which would draw two
 * identical rows only one of which "Put back" could clear. The member
 * `dedupe` above needs no such care, because `validateMembers` cannot let a
 * duplicate in; a rename is the one thing that can MANUFACTURE one here.
 *
 * Absent rather than empty, matching the schema: a space that leaves nothing
 * out carries no `exclude` key at all.
 */
function repairExclude(
  exclude: readonly string[] | undefined,
  oldPath: string,
  newPath: string
): string[] | undefined {
  if (exclude === undefined) return undefined;
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const p of exclude) {
    const next = rewritePrefix(p, oldPath, newPath);
    const folded = canonicalPath(next);
    if (seen.has(folded)) continue;
    seen.add(folded);
    kept.push(next);
  }
  return kept.length > 0 ? kept : undefined;
}

/** "" for a root-level path, matching the order map's root key. */
function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Order lists are keyed BY FOLDER PATH, so a folder rename has to rewrite
 * the keys as well as the entries inside them — `rewritePrefix` handles both,
 * exactly as it already does for member paths.
 *
 * The one case that is not a rewrite: a MOVE, where the parent folder changed.
 * The entry is dropped from the source list and becomes unlisted in the
 * target, falling to the bottom. Synthesising a position in the
 * target would be inventing intent the user never expressed — they performed
 * the drag in one space, and only that space learns a position for it.
 */
function repairOrderMap(map: OrderMap, oldPath: string, newPath: string): OrderMap {
  // Null-prototype, like `schema.ts`: a folder named `__proto__` would
  // otherwise set the prototype rather than store an entry, losing the order.
  const out: OrderMap = Object.create(null) as OrderMap;
  const rewritten = new Set<string>();
  for (const [key, list] of Object.entries(map)) {
    const newKey = key === "" ? "" : rewritePrefix(key, oldPath, newPath);
    const changed = newKey !== key;
    // A collision needs a STALE key to collide with, and orders are left in
    // place on delete — so `Journals` can still hold an order after
    // that folder is gone, and renaming `Papers` -> `Journals` then lands on
    // it. Without this, whichever key came first in `Object.entries` won, so a
    // coin flip decided whose arrangement survived. The rewritten one wins,
    // because it belongs to the folder that actually exists now.
    if (!changed && rewritten.has(newKey)) continue;
    out[newKey] = list.map((entry) => rewritePrefix(entry, oldPath, newPath));
    if (changed) rewritten.add(newKey);
  }
  const from = dirnameOf(oldPath);
  if (from !== dirnameOf(newPath)) {
    const source = out[from];
    if (source) {
      const kept = source.filter((entry) => entry !== newPath);
      if (kept.length > 0) out[from] = kept;
      else delete out[from];
    }
  }
  return out;
}

function repairOrders(
  orders: SpaceOrders | undefined,
  oldPath: string,
  newPath: string
): SpaceOrders | undefined {
  if (!orders) return undefined;
  const all = orders.all ? repairOrderMap(orders.all, oldPath, newPath) : undefined;
  let bySpaceId: Record<string, OrderMap> | undefined;
  if (orders.bySpaceId) {
    bySpaceId = Object.create(null) as Record<string, OrderMap>;
    for (const [id, map] of Object.entries(orders.bySpaceId)) {
      bySpaceId[id] = repairOrderMap(map, oldPath, newPath);
    }
  }
  return { ...(all ? { all } : {}), ...(bySpaceId ? { bySpaceId } : {}) };
}

export function repairOnRename(
  defs: SpacesDefinitions,
  oldPath: string,
  newPath: string
): SpacesDefinitions {
  const orders = repairOrders(defs.orders, oldPath, newPath);
  return {
    ...defs,
    ...(orders ? { orders } : {}),
    spaces: defs.spaces.map((s) => {
      const exclude = repairExclude(s.exclude, oldPath, newPath);
      const repaired: SpaceDefinition = {
        ...s,
        ...(s.root === undefined
          ? {}
          : { root: rewritePrefix(s.root, oldPath, newPath) }),
        members: dedupe(
          s.members.map((m) =>
            m.kind === "tag" ? m : { ...m, path: rewritePrefix(m.path, oldPath, newPath) }
          )
        ),
      };
      // Assigned or deleted rather than spread conditionally: `...s` above
      // has already copied the old `exclude` across, so an omitted key here
      // would leave the STALE list in place.
      if (exclude) repaired.exclude = exclude;
      else delete repaired.exclude;
      return repaired;
    }),
  };
}

/**
 * **There is deliberately no `repairOnDelete`.**
 *
 * A sweep that removed every member at or under a deleted path would make an
 * EXTERNAL move silently destroy membership: Obsidian does not report an
 * external move as a rename — measured: it fires `create` at the new path
 * then `delete` at the old one, roughly a second apart, with no `rename`
 * between them. A sweep on that delete would drop the note from the space
 * for good.
 *
 * This also matches how `root` is already handled on delete: kept rather
 * than cleared, so the space isn't left with no record of the destination.
 * A dangling member is harmless — measured: it resolves to
 * `hidden-nonmember`, the tree renders normally, nothing errors, and moving
 * the file back restores membership.
 *
 * The delete handler in `main.ts` therefore only refreshes the vault index.
 */

/**
 * Apply a rename repair to a mutation DRAFT, in place.
 *
 * Callers must NOT do this instead:
 *
 * ```ts
 * const current = this.defs.get();                       // outside the queue
 * const repaired = repairOnRename(current, old, next);
 * await this.defs.mutate((d) => Object.assign(d, repaired));
 * ```
 *
 * `mutate` serialises, and clones the CURRENT definitions into `draft` when
 * the queued callback finally runs — so assigning a whole document computed
 * before the queue was entered overwrites everything that landed in between.
 * Two overlapping renames would repair the same stale document and the later
 * write would undo the earlier one, leaving a membership pointing at a path
 * with no file; a membership add or a settings change caught in the same
 * window would vanish outright.
 *
 * This exists so the correct shape is the easy one. It takes the draft, so
 * there is no snapshot to go stale, and `repairOnRename` above stays pure for
 * everything that wants a value rather than a mutation.
 */
export function repairRenameIn(
  draft: SpacesDefinitions,
  oldPath: string,
  newPath: string
): void {
  const repaired = repairOnRename(draft, oldPath, newPath);
  // `repairOnRename` returns a fresh object built from the draft it was just
  // handed, so assigning it back cannot reintroduce anything stale. `orders`
  // is deleted first because the repair OMITS the key when nothing is ordered,
  // and Object.assign would otherwise leave the draft's copy in place.
  if (!repaired.orders) delete draft.orders;
  Object.assign(draft, repaired);
}
