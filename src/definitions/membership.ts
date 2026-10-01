/**
 * Membership predicates over a `SpaceDefinition`, or over the member list
 * behind one — the ownership-vs-membership model itself, asked as a question
 * rather than rendered.
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

import type { MemberEntry, PathMember, SpaceDefinition } from "../types";
import { canonicalPath } from "../visibility/glob";
import { ancestorsOf } from "../visibility/VaultIndex";
import { hasRoot } from "../visibility/folderSpace";
import { normalizeTag } from "../visibility/tagMatch";

/**
 * The innermost ancestor folder that is itself an exact member -- the folder
 * responsible for `path` being covered by inheritance. Returns null if none
 * is found (shouldn't happen when the caller already knows the path is
 * inherited, but this stays defensive).
 *
 * Takes a bare member list rather than a space, because the create panel asks
 * this question of `CreateFormState.items` — a selection that is not a space
 * yet and may never become one. A second copy of the walk for that caller
 * would be a second place for the case folding below to be forgotten, and the
 * disagreement would only surface on a vault that spells a folder two ways.
 */
export function coveringFolder(
  members: readonly MemberEntry[],
  path: string
): string | null {
  return coveringFolderIn(memberFolderSet(members), path);
}

/**
 * The folder members, canonicalised, ready for `coveringFolderIn`.
 *
 * Split out so a caller asking about a whole list of paths builds this once
 * instead of once per path. The create panel draws up to two hundred rows per
 * keystroke and was rebuilding it for every one of them.
 */
export function memberFolderSet(members: readonly MemberEntry[]): Set<string> {
  // Folded, so a folder stored as `Inbox` still covers a live
  // `inbox/today.md`. Without this the row is visible — the snapshot resolves
  // the stored path — but every caller that asks WHY it is visible gets "not
  // inherited", so the disabled menu entry loses the folder name it exists to
  // report.
  //
  // Merged by the arbiter: x5 moved this function here while x4
  // canonicalised it in its old home. Both were wanted; this is the union.
  return new Set(
    members.filter((m) => m.kind === "folder").map((m) => canonicalPath(m.path))
  );
}

/**
 * `coveringFolder` against an already-built folder set.
 *
 * The LIVE ancestor is returned, not the stored spelling, because that is
 * what the caller is labelling.
 */
export function coveringFolderIn(
  folders: ReadonlySet<string>,
  path: string
): string | null {
  const ancestors = ancestorsOf(path);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (folders.has(canonicalPath(ancestors[i]))) return ancestors[i];
  }
  return null;
}

/**
 * `coveringFolder`, asked of a stored space. The spelling every caller that
 * holds a `SpaceDefinition` uses, kept so none of them reaches into
 * `space.members` to ask one question about it.
 */
export function inheritedFromFolder(space: SpaceDefinition, path: string): string | null {
  return coveringFolder(space.members, path);
}

/**
 * The tag members, normalized, ready for `coveringTagIn`.
 *
 * The tag half of `memberFolderSet`, and split from its lookup for the same
 * reason: the tag picker draws a row per tag and would otherwise rebuild this
 * for every one of them.
 *
 * `normalizeTag` rather than `canonicalPath` is the whole difference between
 * the two sides. A tag is stored bare and lowercased and is written with a
 * leading `#` everywhere a user can see one, so folding here drops the sigil
 * as well as the case; a path has no sigil to drop and is folded for case
 * alone.
 */
export function memberTagSet(members: readonly MemberEntry[]): Set<string> {
  return new Set(
    members.flatMap((m) => (m.kind === "tag" ? [normalizeTag(m.tag)] : []))
  );
}

/**
 * The outermost selected tag that covers `tag`, or null when none does.
 *
 * `tagMatches` says a member covers its nested tags, so a space holding
 * `project` already holds everything tagged `project/alpha`. A tag's ancestors
 * are its `/`-separated prefixes, exactly as a path's are, so `ancestorsOf`
 * answers for both and this is `coveringFolderIn` with a different fold.
 *
 * The OUTERMOST is returned, not the innermost. The folder side walks inwards
 * because the nearest folder member is the one a user would recognise as the
 * container on screen; here the ancestors are themselves rows in the same
 * tree, and the outermost is the one whose coverage is not itself covered —
 * deselect that and every row under it is free in one gesture, where naming an
 * inner one would send the user back for the outer one straight after.
 */
export function coveringTagIn(
  tags: ReadonlySet<string>,
  tag: string
): string | null {
  for (const ancestor of ancestorsOf(normalizeTag(tag))) {
    if (tags.has(ancestor)) return ancestor;
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

/**
 * Whether this space's contents depend on what is inside a note.
 *
 * The gate on the metadata listener. A space of files and folders cannot
 * change because someone typed in a note, so the common case costs one scan
 * of a short array instead of a snapshot rebuild per keystroke-triggered
 * save.
 *
 * False for a folder space even when it stores tag members. A space
 * declaring a root renders from that root and its member list is never
 * consulted, so watching metadata for it would be work with no possible
 * effect.
 */
export function watchesMetadata(space: SpaceDefinition | null): boolean {
  if (space === null) return false;
  if (hasRoot(space)) return false;
  return space.members.some((m) => m.kind === "tag");
}
