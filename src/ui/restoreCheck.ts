import { pathMembers } from "../definitions/membership";
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
 * Which members those are is `pathMembers`' answer, not a second `file` or
 * `folder` test written here: its switch is `never`-checked, so a member kind
 * added to `MemberEntry` is a compile error there rather than a kind this
 * gate silently never reports.
 *
 * A folder space's `root` is checked too, since it usually has no members at
 * all. A folder moved while Obsidian is RUNNING is often repaired without
 * this: `correlateFolder` derives the move from a correlated descendant and
 * the rename that follows reaches archived spaces through `repairOnRename`.
 * What does not self-correct is a move made with Obsidian closed, or a move
 * of a folder with no stat-matchable descendant (a folder carries no stat of
 * its own for the move correlator), which is the state a space that sat
 * archived for months is most likely to come back in. `""` and `"/"` both
 * mean no folder chosen (see `SpaceDefinition.root`), so neither is a
 * problem.
 *
 * **Asked by KIND, not by existence.** A member says what it expects to find,
 * and a path occupied by the other kind is as broken for the restored space
 * as an empty one: a folder space pointed at a note draws nothing and then
 * gets a `"<root>" no longer exists` Notice afterwards, which is the restore
 * this gate exists to prevent, arriving by a different door. `pointProblem`
 * already refuses a typed path of the wrong kind, so without this the gate
 * enforced on INPUT a rule it never applied to the data. Reaching it takes a
 * filesystem act rather than an in-app one, since Obsidian's notes carry
 * `.md`.
 */
export function restoreProblems(
  space: SpaceDefinition,
  kindAt: (path: string) => "file" | "folder" | null
): RestoreProblem[] {
  const problems: RestoreProblem[] = [];
  for (const m of pathMembers(space)) {
    if (kindAt(m.path) !== m.kind) {
      problems.push({ kind: "member", path: m.path, memberKind: m.kind });
    }
  }
  const root = space.root;
  if (typeof root === "string" && root !== "" && root !== "/" && kindAt(root) !== "folder") {
    problems.push({ kind: "root", path: root });
  }
  return problems;
}
