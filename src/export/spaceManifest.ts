import type { MemberEntry, OrderMap, SpaceDefinition } from "../types";

/**
 * The export's definition file.
 *
 * A leading dot and a plugin-specific name, because this sits at the export
 * root beside mirrored vault paths: a vault holding `space.json` at its root
 * would collide with an obvious name. `buildExportPlan` treats a vault path
 * that collides with this one as a conflict rather than overwriting it.
 *
 * Deliberately NOT prefixed `spaces-`: `stylesCoupling.test.ts` scans `src`
 * for that prefix and treats every hit as a CSS class the stylesheet must
 * style. This is a filename, not a class, and allowlisting it as one would
 * put a false entry in `UNSTYLED_CLASSES`.
 */
export const MANIFEST_FILENAME = ".space-export.json";

/**
 * What the space WAS, recorded so an export is an archive rather than a pile
 * of notes and folders.
 *
 * Deliberately NOT what the export contains: the two differ, because a note's
 * embedded image is in the export without ever having been a member. The
 * `contents` block keeps that distinction explicit so a future importer does
 * not have to guess which files the user actually chose.
 *
 * Reading one of these back in is a separate feature. This only means the
 * information is not thrown away.
 */
export interface SpaceManifest {
  formatVersion: 1;
  exportedAt: string;
  space: {
    id: string;
    name: string;
    icon: string;
    color: string;
    /** A folder space's root. Present instead of `members`, never beside it. */
    root?: string;
    /**
     * Optional, because a folder space has no member list and writing `[]`
     * would record the space as empty. That is the one misreading this file
     * exists to prevent.
     */
    members?: MemberEntry[];
    order?: OrderMap;
  };
  contents: {
    members: string[];
    referenced: string[];
  };
}

export interface ManifestInput {
  space: SpaceDefinition;
  /**
   * The space's stored order, which lives at
   * `SpacesDefinitions.orders.bySpaceId` rather than on the definition, so it
   * has to be handed in.
   */
  order: OrderMap | undefined;
  /**
   * Structural rather than `ExportEntry`, so this module never imports the
   * selector. The selector imports `MANIFEST_FILENAME` from here, and an
   * import running both ways would be a cycle.
   */
  entries: readonly { sourcePath: string; why: "member" | "referenced" }[];
  now: Date;
}

/**
 * The space id recorded in an existing export, or null when the text is
 * absent, unparsable, or not one of ours.
 *
 * This is what makes "replace" safe. Space NAMES are not unique and
 * `safeFolderName` is lossy, so two spaces can share a destination folder:
 * `Work/2026` and `Work-2026` both sanitise to `Work-2026`. Without reading
 * the id back, replacing the second would recursively delete the first's
 * export behind a prompt claiming the folder was already this space's.
 */
export interface ExistingExport {
  spaceId: string;
  /** What the space was CALLED when it was exported. May differ from now. */
  spaceName: string | null;
  /** ISO timestamp as written, or null when absent or not a string. */
  exportedAt: string | null;
}

/**
 * What an existing export says about itself, or null when the text is
 * absent, unparsable, or not one of ours.
 *
 * The id alone cannot prove ownership, which is why the name and the date
 * come back too. Space ids are slugs of the name (`spaceLifecycle.ts`) and
 * `deleteSpace` frees them, so deleting a space and creating another with
 * the same name RECYCLES the id: a stale export of the old space then
 * matches the new one exactly. The id is still the right gate for refusing
 * an obviously different space, but what the folder actually holds has to
 * be put in front of the user rather than asserted away.
 */
export function readExistingExport(text: string | null): ExistingExport | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const space: unknown = (parsed as { space?: unknown }).space;
    if (typeof space !== "object" || space === null) return null;
    const id: unknown = (space as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") return null;
    const name: unknown = (space as { name?: unknown }).name;
    const at: unknown = (parsed as { exportedAt?: unknown }).exportedAt;
    return {
      spaceId: id,
      spaceName: typeof name === "string" && name !== "" ? name : null,
      exportedAt: typeof at === "string" && at !== "" ? at : null,
    };
  } catch {
    return null;
  }
}

export function buildSpaceManifest(input: ManifestInput): SpaceManifest {
  const { space, order, entries, now } = input;
  const isFolderSpace = typeof space.root === "string" && space.root !== "";

  const space_: SpaceManifest["space"] = {
    id: space.id,
    name: space.name,
    icon: space.icon,
    color: space.color,
  };
  // Assigned rather than spread with `undefined`, so the JSON has no holes.
  if (isFolderSpace) space_.root = space.root;
  else space_.members = space.members;
  // Filtered to what the export holds. The stored order is compacted
  // against a folder's VAULT children, so it can still name notes the user
  // later excluded, or visitors, and this file is made to be handed to
  // someone else. Dropping `exclude` for privacy and then leaking the same
  // paths through `order` would be no privacy at all.
  if (order !== undefined) {
    const inExport = new Set(entries.map((e) => e.sourcePath));
    const kept: OrderMap = {};
    for (const [folder, children] of Object.entries(order)) {
      const keep = children.filter((c) => inExport.has(c));
      if (keep.length > 0) kept[folder] = keep;
    }
    if (Object.keys(kept).length > 0) space_.order = kept;
  }

  // `exclude` and `archived` are deliberately absent. `exclude` lists paths
  // the user chose to hide, and this file is made to be handed to someone
  // else; `archived` describes the space's place in a vault the export has
  // left behind.
  return {
    formatVersion: 1,
    exportedAt: now.toISOString(),
    space: space_,
    contents: {
      members: entries.filter((e) => e.why === "member").map((e) => e.sourcePath),
      referenced: entries.filter((e) => e.why === "referenced").map((e) => e.sourcePath),
    },
  };
}
