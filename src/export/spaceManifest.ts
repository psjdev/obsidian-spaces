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
  if (order !== undefined) space_.order = order;

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
