/**
 * The write boundary for definitions.
 *
 * `actions/` was supposed to be that boundary and is not — of the 23
 * `defs.mutate` call sites in the codebase, 10 live in `src/ui/`. The sharp
 * cost is not the count but a genuine duplicate: `actions/membership.ts`'s
 * `removeAll` and `SettingsTab.ts`'s per-row Remove button both remove members
 * from a space, with different code that agrees today by coincidence rather
 * than by construction. Add a rule to one — the obvious candidate being
 * "removing a member must also drop its entry from that space's `orders` map",
 * which `deleteSpace` already does for `orders.bySpaceId` — and the other keeps
 * the old behaviour with the suite green.
 *
 * The functions here are the one place each of those writes is expressed. They
 * are deliberately NOT where the user is told about a failure: `mutate` throws,
 * and keeps throwing for the rest of the session while `data.json` is
 * unreadable, and the two callers say different things about it — the menu
 * names the space, Settings names the row and then re-renders itself.
 * Swallowing the throw here is what produced two `SettingsTab.ts` toggles
 * found with no `.catch` at all, repainting as saved.
 *
 * Pure: no DOM, no `"obsidian"` import, so it tests in plain node.
 */

import { canonicalPath } from "../visibility/glob";
import type { DefinitionStore } from "../definitions/DefinitionStore";

/**
 * Takes `paths` out of `spaceId`, one way or the other: a path a stored
 * member names is removed as a member; a path no stored member names (it is
 * in the space because a tag member matched it, or because a member folder
 * covers it) becomes an entry in that space's `exclude` list instead.
 *
 * Exact paths only, in the member case. The inheritance means a folder
 * member confers membership on everything under it WITHOUT storing an entry
 * per descendant, so there is nothing under a removed folder to sweep — and
 * a prefix sweep would delete exact members the user added separately, which
 * is the mistake `repairOnDelete` was removed for (see
 * `lifecycle/pathRepair.ts`).
 *
 * A space id that does not resolve is a no-op rather than an error: the two
 * callers both read the id from state that a concurrent `data.json` change can
 * invalidate between the click and the queued write.
 */
export async function removeMembers(
  defs: DefinitionStore,
  spaceId: string,
  paths: readonly string[]
): Promise<void> {
  // Exact-preference, decided PER REQUESTED PATH: if the space holds
  // the exact spelling asked for, only that entry goes; the folded fallback
  // applies only when it does not. Removing both casings would delete an entry
  // the user did not name in a vault that genuinely holds two — which is rare,
  // but silent deletion of curation is the one outcome this must prevent.
  //
  // Mirrors the short-circuit `buildVisibilitySnapshot` uses, so the row you
  // can see and the row you can remove are decided the same way.
  await defs.mutate((d) => {
    const target = d.spaces.find((s) => s.id === spaceId);
    if (!target) return;
    const drop = new Set<string>();
    const exclude = new Set(target.exclude ?? []);
    for (const wanted of paths) {
      const exact = target.members.find(
        (m) => m.kind !== "tag" && m.path === wanted
      );
      if (exact && exact.kind !== "tag") {
        drop.add(exact.path);
        continue;
      }
      const folded = canonicalPath(wanted);
      let matched = false;
      for (const m of target.members) {
        if (m.kind === "tag") continue;
        if (canonicalPath(m.path) === folded) {
          drop.add(m.path);
          matched = true;
        }
      }
      // Nothing stored names this path, so it is in the space because a rule
      // put it there, or because a member folder covers it. Either way the
      // only way to take it out is to say so.
      if (!matched) {
        const already = [...exclude].some((e) => canonicalPath(e) === folded);
        if (!already) exclude.add(wanted);
      }
    }
    target.members = target.members.filter(
      (m) => m.kind === "tag" || !drop.has(m.path)
    );
    // Absent rather than empty, matching what the schema stores.
    if (exclude.size > 0) target.exclude = [...exclude];
  });
}
