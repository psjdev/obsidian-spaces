import type { VaultIndex } from "../visibility/VaultIndex";
import type { VisibilitySnapshot } from "../visibility/VisibilityEngine";
import { MANIFEST_FILENAME } from "./spaceManifest";

/** One file to copy, and why it is in the export. */
export interface ExportEntry {
  sourcePath: string;
  /** The vault path, mirrored. Equal to `sourcePath` by design. */
  destRelativePath: string;
  why: "member" | "referenced";
}

export interface ExportPlan {
  entries: ExportEntry[];
  /**
   * Member folders, emitted so a folder the user added but has not filled
   * still appears in the export. Only files are copied, so without this an
   * empty member folder would vanish.
   */
  folders: string[];
  /**
   * Groups of destination paths that are one path on a case-insensitive
   * filesystem, plus any path that collides with the manifest.
   *
   * Reported rather than resolved: by the time the sink notices, the first
   * file has already been overwritten and the export looks complete.
   */
  collisions: string[][];
}

export interface ExportPlanInput {
  snapshot: VisibilitySnapshot;
  vault: VaultIndex;
  /** `app.metadataCache.resolvedLinks`, source path to target paths. */
  links: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * Whether `globalIgnore` hides this LIVE vault path.
   *
   * Applied to one-hop referenced files only, never to members: a member is
   * a path a person pointed at, and `includedPaths.ts` lets it bypass the
   * ignore on purpose. The caller owns any folding its matcher needs.
   */
  isIgnored: (path: string) => boolean;
  /** Whether the space excludes this LIVE vault path. Same contract. */
  isExcluded: (path: string) => boolean;
}

/** Reasons that mean "this is the space", as opposed to merely on screen. */
const MEMBER_REASONS = new Set(["exact-member", "inherited-member"]);

export function buildExportPlan(input: ExportPlanInput): ExportPlan {
  const { snapshot, vault, links, isIgnored, isExcluded } = input;

  const memberFiles: string[] = [];
  const folders: string[] = [];
  for (const path of snapshot.visiblePaths()) {
    if (!MEMBER_REASONS.has(snapshot.decisionFor(path).reason)) continue;
    if (vault.kindOf(path) === "folder") folders.push(path);
    else if (vault.kindOf(path) === "file") memberFiles.push(path);
  }
  memberFiles.sort();
  folders.sort();

  const seen = new Set(memberFiles);
  const entries: ExportEntry[] = memberFiles.map((p) => ({
    sourcePath: p,
    destRelativePath: p,
    why: "member",
  }));

  // One hop, from the MEMBER files only. Iterating the list captured above
  // rather than `entries` is what keeps a referenced file from contributing
  // links of its own.
  const referenced: string[] = [];
  for (const source of memberFiles) {
    for (const target of Object.keys(links[source] ?? {})) {
      if (seen.has(target)) continue;
      if (vault.kindOf(target) !== "file") continue;
      if (isIgnored(target) || isExcluded(target)) continue;
      seen.add(target);
      referenced.push(target);
    }
  }
  referenced.sort();
  for (const p of referenced) {
    entries.push({ sourcePath: p, destRelativePath: p, why: "referenced" });
  }

  return { entries, folders, collisions: collisionsIn(entries) };
}

function collisionsIn(entries: readonly ExportEntry[]): string[][] {
  const byFold = new Map<string, string[]>();
  for (const e of entries) {
    const key = e.destRelativePath.toLowerCase();
    const group = byFold.get(key);
    if (group) group.push(e.destRelativePath);
    else byFold.set(key, [e.destRelativePath]);
  }
  const out: string[][] = [];
  for (const [key, group] of byFold) {
    // A single path is still a conflict when it is the manifest's own name:
    // the manifest would overwrite the note, or the note the manifest.
    if (group.length > 1 || key === MANIFEST_FILENAME.toLowerCase()) {
      out.push([...group].sort());
    }
  }
  return out;
}
