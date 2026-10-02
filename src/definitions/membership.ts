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
import { ancestorsOf, type VaultIndex } from "../visibility/VaultIndex";
import { resolveLivePath } from "../visibility/resolveLivePath";
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
 * The folder members, with the rule `coveringFolderIn` must use on them.
 *
 * The mode travels WITH the set rather than being remembered elsewhere or
 * passed separately to the lookup. A copy, a filter or a cache of `folders`
 * would otherwise lose it and silently fall back to folding, which is the
 * defect this exists to prevent; carried in the value, a copy keeps it, and a
 * bare `Set` handed to `coveringFolderIn` is a compile error.
 */
export interface FolderSet {
  readonly folders: ReadonlySet<string>;
  /**
   * True when `folders` holds LIVE paths and the lookup must compare exactly.
   * False when it holds folded spellings and the lookup folds each ancestor.
   */
  readonly exact: boolean;
}

/**
 * The folder members, ready for `coveringFolderIn`.
 *
 * Split out so a caller asking about a whole list of paths builds this once
 * instead of once per path. The create panel draws up to two hundred rows per
 * keystroke and builds this once per draw, never once per row.
 *
 * With a `vault`, each stored spelling is resolved to the LIVE path it names
 * and the set holds those, and `coveringFolderIn` then compares exactly. A
 * folder stored as `Inbox` still covers a live `inbox/today.md` (the path
 * resolves to `inbox`), but `Docs` no longer covers `docs/b.md` when both
 * folders exist: they are two folders, the engine treats them as two, and a
 * panel that folded both sides disabled a row and named a folder that is not a
 * member. A member whose folder no longer exists contributes nothing.
 *
 * Without a `vault` the set holds the folded spelling and
 * `coveringFolderIn` folds each ancestor to match, as this has always done,
 * so a caller holding only a stored document still gets an answer. That mode
 * cannot tell `Docs` from `docs`.
 */
export function memberFolderSet(
  members: readonly MemberEntry[],
  vault?: Pick<VaultIndex, "exists" | "childrenOf">
): FolderSet {
  const folders = new Set<string>();
  for (const m of members) {
    if (m.kind !== "folder") continue;
    if (vault === undefined) {
      folders.add(canonicalPath(m.path));
      continue;
    }
    const live = resolveLivePath(vault, m.path);
    if (live !== null) folders.add(live);
  }
  return { folders, exact: vault !== undefined };
}

/**
 * `coveringFolder` against an already-built folder set.
 *
 * The LIVE ancestor is returned, not the stored spelling, because that is
 * what the caller is labelling. An exact set is compared exactly; a folded one
 * holds folded spellings, so each ancestor is folded to match it.
 */
export function coveringFolderIn(set: FolderSet, path: string): string | null {
  const ancestors = ancestorsOf(path);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const key = set.exact ? ancestors[i] : canonicalPath(ancestors[i]);
    if (set.folders.has(key)) return ancestors[i];
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
 * In a list written through `toggleItem`, which keeps it minimal, at most one
 * ancestor can be a member, so there is only ever one answer to give.
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
