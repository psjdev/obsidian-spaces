/**
 * Membership predicates over a `SpaceDefinition` — the ownership-vs-membership
 * model itself, asked as a question rather than rendered.
 *
 * `inheritedFromFolder` used to live in `actions/membershipMenu.ts`,
 * which made it a menu-rendering module's export that four unrelated modules
 * imported — one of them `spaceAddTargets.ts`, which `membershipMenu.ts`
 * imports back. That was the only runtime import cycle in `src/`, and it held
 * together only because both exports were hoisted `function` declarations;
 * converting either to a `const` arrow would have put one module in the
 * other's temporal dead zone at load, with no warning from `tsc` or esbuild.
 *
 * It lives in `definitions/` because that is the layer that owns what a space
 * IS — the same layer as `schema.ts`'s `isSafeVaultPath`. Pure: no DOM, no
 * `"obsidian"` import.
 */

import type { PathMember, SpaceDefinition } from "../types";
import { canonicalPath } from "../visibility/glob";
import { ancestorsOf } from "../visibility/VaultIndex";

/**
 * The innermost ancestor folder that is itself an exact member -- the folder
 * responsible for `path` being visible via inheritance. Returns null if none
 * is found (shouldn't happen when the caller already knows the path is
 * inherited, but this stays defensive).
 */
export function inheritedFromFolder(space: SpaceDefinition, path: string): string | null {
  // Folded on both sides, so a folder stored as `Inbox` still covers a
  // live `inbox/today.md`. Without this the row is visible — the
  // snapshot resolves the stored path — but every caller that asks WHY it is
  // visible gets "not inherited", so the disabled menu entry loses the folder
  // name it exists to report. The LIVE ancestor is returned, not the stored
  // spelling, because that is what the caller is labelling.
  //
  // Merged by the arbiter: x5 moved this function here while x4
  // canonicalised it in its old home. Both were wanted; this is the union.
  const memberFolders = new Set(
    space.members.filter((m) => m.kind === "folder").map((m) => canonicalPath(m.path))
  );
  const ancestors = ancestorsOf(path);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (memberFolders.has(canonicalPath(ancestors[i]))) return ancestors[i];
  }
  return null;
}

/**
 * The members that name a vault path.
 *
 * Most callers ask "is this path a member" or "which paths did the user
 * pick", and neither question has an answer for a tag. Narrowing here keeps
 * that narrowing in one place instead of a `m.kind !== "tag"` guard at each
 * of the eighteen call sites.
 */
export function pathMembers(space: SpaceDefinition): PathMember[] {
  return space.members.filter((m): m is PathMember => m.kind !== "tag");
}
