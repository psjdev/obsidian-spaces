import { describe, expect, it } from "vitest";
import type { MemberKind, VisibilityDecision, VisibilityReason } from "../src/types";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildFakeVault } from "./helpers/fakeVault";
import { MANIFEST_FILENAME } from "../src/export/spaceManifest";
import {
  type ExportPlan,
  type ExportPlanInput,
  buildExportPlan,
} from "../src/export/exportPlan";

/**
 * Per-test fixtures, never one shared one. The one-hop, collision and
 * folder-space cases need different vaults, and a single fixture broad
 * enough for all of them makes every `toEqual` unreadable.
 */
function snapshotOf(reasons: Record<string, VisibilityReason>): VisibilitySnapshot {
  const visible = new Set(
    Object.entries(reasons)
      .filter(([, r]) => !r.startsWith("hidden-"))
      .map(([p]) => p)
  );
  return {
    visiblePaths: () => new Set(visible),
    decisionFor: (path): VisibilityDecision => ({
      visible: visible.has(path),
      reason: reasons[path] ?? "hidden-nonmember",
      canRemoveMembership: reasons[path] === "exact-member",
      overridesIgnore: false,
    }),
  };
}

function input(over: Partial<ExportPlanInput> & {
  reasons: Record<string, VisibilityReason>;
  tree: Record<string, MemberKind>;
}): ExportPlanInput {
  const { reasons, tree, ...rest } = over;
  return {
    snapshot: snapshotOf(reasons),
    vault: buildFakeVault(tree),
    links: {},
    isIgnored: () => false,
    isExcluded: () => false,
    ...rest,
  };
}

const paths = (p: ExportPlan): string[] => p.entries.map((e) => e.destRelativePath);
const entryFor = (p: ExportPlan, s: string) => p.entries.find((e) => e.sourcePath === s);

describe("buildExportPlan: the set", () => {
  const base = {
    reasons: {
      "Reading": "scaffold",
      "Reading/book.md": "exact-member",
      "Projects": "scaffold",
      "Projects/Kitchen": "exact-member",
      "Projects/Kitchen/plan.md": "inherited-member",
      "Inbox/open-right-now.md": "visitor",
      "Secret/hidden.md": "hidden-ignore",
      "Other/nope.md": "hidden-nonmember",
    } as Record<string, VisibilityReason>,
    tree: {
      Reading: "folder",
      "Reading/book.md": "file",
      Projects: "folder",
      "Projects/Kitchen": "folder",
      "Projects/Kitchen/plan.md": "file",
      "Inbox/open-right-now.md": "file",
      "Secret/hidden.md": "file",
      "Other/nope.md": "file",
    } as Record<string, MemberKind>,
  };

  it("exports exact and inherited members, mirroring their vault paths", () => {
    expect(paths(buildExportPlan(input(base)))).toEqual([
      "Projects/Kitchen/plan.md",
      "Reading/book.md",
    ]);
  });

  it("leaves a visitor out", () => {
    // Showing because a file is open, not because it belongs.
    expect(paths(buildExportPlan(input(base)))).not.toContain("Inbox/open-right-now.md");
  });

  it("leaves hidden paths out", () => {
    const p = paths(buildExportPlan(input(base)));
    expect(p).not.toContain("Secret/hidden.md");
    expect(p).not.toContain("Other/nope.md");
  });

  it("copies no folders as files, and the check is not vacuous", () => {
    const plan = buildExportPlan(input(base));
    expect(plan.entries.length).toBeGreaterThan(0);
    const vault = buildFakeVault(base.tree);
    for (const e of plan.entries) expect(vault.kindOf(e.sourcePath)).toBe("file");
  });

  it("emits a member folder that holds no files", () => {
    // Only files are copied, so an empty member folder would otherwise
    // vanish from the export.
    const plan = buildExportPlan(
      input({
        reasons: { "Projects/Empty": "exact-member" },
        tree: { "Projects/Empty": "folder" },
      })
    );
    expect(plan.folders).toEqual(["Projects/Empty"]);
    expect(plan.entries).toEqual([]);
  });

  it("exports a folder space at its full vault path, root not stripped", () => {
    // Owner decision O6. The pane hoists a folder space's children and hides
    // the root; the export must not, or layout would depend on the kind of
    // space rather than on the vault.
    const plan = buildExportPlan(
      input({
        reasons: {
          "Projects/Kitchen": "exact-member",
          "Projects/Kitchen/plan.md": "inherited-member",
        },
        tree: {
          Projects: "folder",
          "Projects/Kitchen": "folder",
          "Projects/Kitchen/plan.md": "file",
        },
      })
    );
    expect(paths(plan)).toEqual(["Projects/Kitchen/plan.md"]);
  });
});

describe("buildExportPlan: one hop", () => {
  const tree: Record<string, MemberKind> = {
    "Reading/book.md": "file",
    "Attachments/diagram.png": "file",
    "Attachments/second-hop.png": "file",
    "Private/diagram.png": "file",
    "Projects/Kitchen/budget.md": "file",
  };
  const reasons: Record<string, VisibilityReason> = { "Reading/book.md": "exact-member" };
  const links = {
    "Reading/book.md": {
      "Attachments/diagram.png": 1,
      "Private/diagram.png": 1,
      "Projects/Kitchen/budget.md": 1,
    },
    // A referenced file's OWN links. Following these would be two hops.
    "Attachments/diagram.png": { "Attachments/second-hop.png": 1 },
  };

  it("follows resolvedLinks one hop and marks the result referenced", () => {
    const plan = buildExportPlan(input({ reasons, tree, links }));
    expect(entryFor(plan, "Attachments/diagram.png")).toEqual({
      sourcePath: "Attachments/diagram.png",
      destRelativePath: "Attachments/diagram.png",
      why: "referenced",
    });
  });

  it("does not follow links out of a referenced file", () => {
    const plan = buildExportPlan(input({ reasons, tree, links }));
    // The control: the first hop IS reachable, so the absence below means
    // the boundary held rather than the fixture being empty.
    expect(paths(plan)).toContain("Attachments/diagram.png");
    expect(paths(plan)).not.toContain("Attachments/second-hop.png");
  });

  it("never exports a referenced file that globalIgnore hides", () => {
    const shown = buildExportPlan(input({ reasons, tree, links }));
    const hidden = buildExportPlan(
      input({ reasons, tree, links, isIgnored: (p) => p.startsWith("Private/") })
    );
    // Positive control first: without the predicate the fixture reaches it.
    expect(paths(shown)).toContain("Private/diagram.png");
    expect(paths(hidden)).not.toContain("Private/diagram.png");
  });

  it("never exports a referenced file the space excludes", () => {
    const shown = buildExportPlan(input({ reasons, tree, links }));
    const hidden = buildExportPlan(
      input({ reasons, tree, links, isExcluded: (p) => p === "Projects/Kitchen/budget.md" })
    );
    expect(paths(shown)).toContain("Projects/Kitchen/budget.md");
    expect(paths(hidden)).not.toContain("Projects/Kitchen/budget.md");
  });

  it("still exports a MEMBER that globalIgnore hides", () => {
    // `includedPaths.ts` lets a hand-added member bypass globalIgnore on
    // purpose, and its comment says hiding such a note is the one thing the
    // bypass exists to prevent. A builder who applies isIgnored to members
    // as well as one-hop files passes every other test in this file.
    const plan = buildExportPlan(
      input({ reasons, tree, links, isIgnored: (p) => p === "Reading/book.md" })
    );
    expect(paths(plan)).toContain("Reading/book.md");
  });

  it("skips a link target that does not exist", () => {
    // resolvedLinks never contains one in practice, measured: a missing
    // target lands in unresolvedLinks instead. This guards a bad caller.
    const plan = buildExportPlan(
      input({ reasons, tree, links: { "Reading/book.md": { "Attachments/gone.png": 1 } } })
    );
    expect(paths(plan)).toEqual(["Reading/book.md"]);
  });

  it("skips a link target that is a folder", () => {
    const plan = buildExportPlan(
      input({
        reasons,
        tree: { ...tree, Attachments: "folder" },
        links: { "Reading/book.md": { Attachments: 1 } },
      })
    );
    expect(paths(plan)).toEqual(["Reading/book.md"]);
  });

  it("keeps why=member when a member is also a link target", () => {
    // The one distinction the manifest exists to make: an attachment must
    // never be filed as something the user chose.
    const plan = buildExportPlan(
      input({
        reasons: { "Reading/book.md": "exact-member", "Reading/other.md": "exact-member" },
        tree: { "Reading/book.md": "file", "Reading/other.md": "file" },
        links: { "Reading/other.md": { "Reading/book.md": 1 } },
      })
    );
    expect(entryFor(plan, "Reading/book.md")?.why).toBe("member");
    expect(paths(plan).filter((p) => p === "Reading/book.md")).toHaveLength(1);
  });
});

describe("buildExportPlan: collisions", () => {
  it("reports paths that differ only in case", () => {
    // One path on Windows and macOS. The second write would silently
    // overwrite the first and the export would still look complete.
    const plan = buildExportPlan(
      input({
        reasons: { "Notes/README.md": "exact-member", "Notes/readme.md": "exact-member" },
        tree: { "Notes/README.md": "file", "Notes/readme.md": "file" },
      })
    );
    expect(plan.collisions).toEqual([["Notes/README.md", "Notes/readme.md"]]);
  });

  it("reports nothing when every path is distinct", () => {
    const plan = buildExportPlan(
      input({
        reasons: { "a.md": "exact-member", "b.md": "exact-member" },
        tree: { "a.md": "file", "b.md": "file" },
      })
    );
    expect(plan.collisions).toEqual([]);
  });

  it("reports a vault file that collides with the manifest", () => {
    const plan = buildExportPlan(
      input({
        reasons: { [MANIFEST_FILENAME]: "exact-member" },
        tree: { [MANIFEST_FILENAME]: "file" },
      })
    );
    expect(plan.collisions).toEqual([[MANIFEST_FILENAME]]);
  });
});
