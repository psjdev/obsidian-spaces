import type { SpaceDefinition } from "../types";

export type RestoreProblem =
  | { kind: "member"; path: string; memberKind: "file" | "folder" }
  | { kind: "root"; path: string };

/**
 * What no longer resolves in a space about to be restored.
 *
 * Only path-bearing members can go missing. Tag and property members never
 * appear: counting them needs a TagIndex or PropertyIndex, and a cold
 * metadata cache answers "unavailable" rather than zero, which would make a
 * restore depend on cache readiness. `exclude` is not membership and never
 * gates a restore.
 *
 * A folder space's `root` is checked too, since it usually has no members at
 * all, and a moved folder is drift that never self-corrects (folders carry no
 * stat for the move correlator). `""` and `"/"` both mean no folder chosen
 * (see `SpaceDefinition.root`), so neither is a problem.
 */
export function restoreProblems(
  space: SpaceDefinition,
  exists: (path: string) => boolean
): RestoreProblem[] {
  const problems: RestoreProblem[] = [];
  for (const m of space.members) {
    if ((m.kind === "file" || m.kind === "folder") && !exists(m.path)) {
      problems.push({ kind: "member", path: m.path, memberKind: m.kind });
    }
  }
  const root = space.root;
  if (typeof root === "string" && root !== "" && root !== "/" && !exists(root)) {
    problems.push({ kind: "root", path: root });
  }
  return problems;
}
