import { describe, expect, it } from "vitest";
import { buildFakeVault } from "./helpers/fakeVault";
import { compileIgnore } from "../src/visibility/glob";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import type { SpaceDefinition } from "../src/types";

const vault = buildFakeVault({
  Papers: "folder",
  "Papers/Attention.md": "file",
  "Papers/Drafts": "folder",
  "Papers/Drafts/Intro.md": "file",
  "Papers/attachments": "folder",
  "Papers/attachments/img.png": "file",
  "Papers-old": "folder",
  "Papers-old/Legacy.md": "file",
  Reference: "folder",
  "Reference/API Docs.md": "file",
  "Reference/Style.md": "file",
  Archive: "folder",
  "Archive/Old": "folder",
  "Archive/Old/Note.md": "file",
  Empty: "folder",
  "Recipes.md": "file",
});

function space(over: Partial<SpaceDefinition> = {}): SpaceDefinition {
  return {
    id: "research",
    name: "Research",
    icon: "microscope",
    color: "#4ecdc4",
    members: [],
    ...over,
  };
}

const noIgnore = compileIgnore([]);

describe("buildVisibilitySnapshot", () => {
  it("shows an exact file member and its ancestors as scaffold", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Reference/API Docs.md", kind: "file" }] }),
      new Set(),
      noIgnore,
      new Set()
    );
    expect(s.decisionFor("Reference/API Docs.md").reason).toBe("exact-member");
    expect(s.decisionFor("Reference").reason).toBe("scaffold");
    expect(s.decisionFor("Reference/Style.md").visible).toBe(false);
  });

  it("expands a folder member to its descendants", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(),
      noIgnore,
      new Set()
    );
    expect(s.decisionFor("Papers").reason).toBe("exact-member");
    expect(s.decisionFor("Papers/Drafts/Intro.md").reason).toBe("inherited-member");
  });

  it("does not let a folder member match a sibling by string prefix", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(),
      noIgnore,
      new Set()
    );
    expect(s.decisionFor("Papers-old/Legacy.md").visible).toBe(false);
  });

  // The v0.1 structural defect: an ancestor must never be hidden by an
  // ignore rule when a descendant is visible.
  it("keeps ancestors visible even when they match an ignore rule", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Archive/Old/Note.md", kind: "file" }] }),
      new Set(),
      compileIgnore(["Archive/**"]),
      new Set()
    );
    expect(s.decisionFor("Archive/Old/Note.md").visible).toBe(true);
    expect(s.decisionFor("Archive/Old").visible).toBe(true);
    expect(s.decisionFor("Archive/Old").reason).toBe("scaffold");
    expect(s.decisionFor("Archive").visible).toBe(true);
  });

  it("marks an exact member that overrides an ignore rule", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Archive/Old/Note.md", kind: "file" }] }),
      new Set(),
      compileIgnore(["Archive/**"]),
      new Set()
    );
    expect(s.decisionFor("Archive/Old/Note.md").overridesIgnore).toBe(true);
  });

  it("applies ignore rules to inherited descendants", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(),
      compileIgnore(["**/attachments/**"]),
      new Set()
    );
    expect(s.decisionFor("Papers/attachments/img.png").visible).toBe(false);
    expect(s.decisionFor("Papers/Attention.md").visible).toBe(true);
  });

  // Section 5.2 step 3b.
  it("prunes a folder emptied by ignore rules", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(),
      compileIgnore(["**/attachments/**"]),
      new Set()
    );
    expect(s.decisionFor("Papers/attachments").visible).toBe(false);
  });

  it("reports a hidden reason for a pruned folder, not inherited-member", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(),
      compileIgnore(["**/attachments/**"]),
      new Set()
    );
    const d = s.decisionFor("Papers/attachments");
    expect(d.visible).toBe(false);
    expect(d.reason).not.toBe("inherited-member");
  });

  it("spares a folder the user left genuinely empty", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Empty", kind: "folder" }] }),
      new Set(),
      compileIgnore(["**/attachments/**"]),
      new Set()
    );
    expect(s.decisionFor("Empty").visible).toBe(true);
  });

  it("reveals a visitor and keeps it visible despite ignore rules", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [] }),
      new Set(["Archive/Old/Note.md"]),
      compileIgnore(["Archive/**"]),
      new Set()
    );
    expect(s.decisionFor("Archive/Old/Note.md").reason).toBe("visitor");
    expect(s.decisionFor("Archive/Old").visible).toBe(true);
  });

  it("applies reason precedence: exact beats inherited beats visitor", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({
        members: [
          { path: "Papers", kind: "folder" },
          { path: "Papers/Attention.md", kind: "file" },
        ],
      }),
      new Set(["Papers/Attention.md"]),
      noIgnore,
      new Set()
    );
    const d = s.decisionFor("Papers/Attention.md");
    expect(d.reason).toBe("exact-member");
    expect(d.canRemoveMembership).toBe(true);
  });

  // The precedence test above uses "Papers/Attention.md", which is
  // simultaneously an exact member, an inherited member (via the "Papers"
  // folder member) AND a visitor — it proves exact beats the other two but
  // never isolates inherited-beats-visitor on a path that is inherited only.
  // "Papers/Drafts/Intro.md" is never an exact member (only "Papers" is),
  // so this pins the next rung of the precedence directly. It fails red
  // if that order were reversed to check visitors before inherited-member.
  it("applies reason precedence: inherited beats visitor, isolated from exact", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(["Papers/Drafts/Intro.md"]),
      noIgnore,
      new Set()
    );
    const d = s.decisionFor("Papers/Drafts/Intro.md");
    expect(d.reason).toBe("inherited-member");
    expect(d.canRemoveMembership).toBe(false);
  });

  it("hides a non-member with reason hidden-nonmember", () => {
    const s = buildVisibilitySnapshot(vault, space(), new Set(), noIgnore,
      new Set());
    const d = s.decisionFor("Recipes.md");
    expect(d.visible).toBe(false);
    expect(d.reason).toBe("hidden-nonmember");
    expect(d.canRemoveMembership).toBe(false);
  });

  it("ignores members whose paths no longer exist", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Gone/Missing.md", kind: "file" }] }),
      new Set(),
      noIgnore,
      new Set()
    );
    expect(s.decisionFor("Gone/Missing.md").visible).toBe(false);
  });
});

/**
 * The path-comparison policy is case-insensitive, matching this vault's
 * filesystem, and the case-only-rename row defers to it. The ignore
 * matcher already obeyed it; membership did not, so the two answered the same
 * question ("does this live path correspond to that stored path?") with
 * different rules. These tests pin the policy on the membership side.
 */
describe("path comparison is case-insensitive", () => {
  const caseVault = buildFakeVault({
    Notes: "folder",
    "Notes/ARCHIVE": "folder",
    "Notes/ARCHIVE/secret.md": "file",
    "Notes/Inbox.md": "file",
  });

  it("resolves a stored member whose casing differs from the live path", () => {
    // The cross-device scenario: `data.json` was written on a case-insensitive
    // filesystem (Windows/macOS) as `Notes/Archive` and syncs to a vault whose
    // real path is `Notes/ARCHIVE` (Linux/Android).
    const s = buildVisibilitySnapshot(
      caseVault,
      space({ members: [{ path: "Notes/Archive", kind: "folder" }] }),
      new Set(),
      noIgnore,
      new Set()
    );
    const d = s.decisionFor("Notes/ARCHIVE");
    expect(d.visible).toBe(true);
    expect(d.reason).toBe("exact-member");
    expect(d.canRemoveMembership).toBe(true);
  });

  it("lets a case-differing member override an ignore rule that matches it", () => {
    // The sharp edge of the divergence: the trap (ignore) was case-insensitive
    // while the escape hatch (an explicit member — "an explicit member
    // overrides this") was case-sensitive, so the member lost to the rule.
    const s = buildVisibilitySnapshot(
      caseVault,
      space({ members: [{ path: "Notes/Archive", kind: "folder" }] }),
      new Set(),
      compileIgnore(["Notes/**"]),
      new Set()
    );
    const d = s.decisionFor("Notes/ARCHIVE");
    expect(d.visible).toBe(true);
    expect(d.reason).toBe("exact-member");
    expect(d.overridesIgnore).toBe(true);
  });

  it("resolves a case-differing visitor path", () => {
    const s = buildVisibilitySnapshot(
      caseVault,
      space(),
      new Set(["notes/inbox.MD"]),
      noIgnore,
      new Set()
    );
    expect(s.decisionFor("Notes/Inbox.md").reason).toBe("visitor");
  });

  it("prefers the exact path when a case variant also exists", () => {
    // On a genuinely case-sensitive filesystem both can be live. An exact hit
    // is never overruled by a fold, so the stored path still means itself.
    const bothVault = buildFakeVault({
      Notes: "folder",
      "Notes/note.md": "file",
      "Notes/Note.md": "file",
    });
    const s = buildVisibilitySnapshot(
      bothVault,
      space({ members: [{ path: "Notes/Note.md", kind: "file" }] }),
      new Set(),
      noIgnore,
      new Set()
    );
    expect(s.decisionFor("Notes/Note.md").reason).toBe("exact-member");
    expect(s.decisionFor("Notes/note.md").visible).toBe(false);
  });

  it("still ignores a member that matches nothing in any casing", () => {
    const s = buildVisibilitySnapshot(
      caseVault,
      space({ members: [{ path: "Notes/Nowhere.md", kind: "file" }] }),
      new Set(),
      noIgnore,
      new Set()
    );
    expect(s.decisionFor("Notes/Nowhere.md").visible).toBe(false);
  });
});

/**
 * A folder space has no member list of its own; the
 * controller (`SpaceController.membersForSnapshot`) presents it to this
 * engine as a space whose single member is its root folder, so that
 * `globalIgnore` and precedence apply exactly as they do for any other
 * folder member. This engine stays ignorant of `root` — these tests just
 * pin that the ALREADY-EXISTING folder-member behaviour above is enough for
 * that shim to lean on, by constructing the space the shim would produce.
 */
describe("a folder space's root, presented as its sole member (membersForSnapshot)", () => {
  it("keeps a globally ignored path under the root hidden", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(),
      compileIgnore(["Papers/attachments/**"]),
      new Set()
    );
    expect(s.decisionFor("Papers/attachments/img.png").visible).toBe(false);
  });

  it("shows a non-ignored path under the root", () => {
    const s = buildVisibilitySnapshot(
      vault,
      space({ members: [{ path: "Papers", kind: "folder" }] }),
      new Set(),
      compileIgnore(["Papers/attachments/**"]),
      new Set()
    );
    expect(s.decisionFor("Papers/Drafts/Intro.md").visible).toBe(true);
  });
});
