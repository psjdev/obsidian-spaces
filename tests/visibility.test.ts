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

/**
 * Step 4, the ancestor closure, on its own.
 *
 * It is 73 to 81 % of every visibility snapshot measured on a 10,000 note
 * vault, in every space shape, so it is the one step most likely to be
 * rewritten for speed. These tests pin the SET it produces rather than the
 * time it takes, because the only acceptable rewrite is one whose output is
 * identical: `scaffold` decides which folder rows the explorer draws, and a
 * chain broken anywhere above a member makes that member unreachable.
 *
 * `scaffoldOf` reads the answer back through `decisionFor`, which is the only
 * way a caller ever sees it, and asserts the whole set rather than a membership
 * probe, so an implementation that scaffolds too MUCH fails too.
 */
describe("the ancestor closure (step 4)", () => {
  const deep = buildFakeVault({
    A: "folder",
    "A/B": "folder",
    "A/B/C": "folder",
    "A/B/C/D": "folder",
    "A/B/C/D/Deep.md": "file",
    "A/B/C/D/Also.md": "file",
    "A/B/Other": "folder",
    "A/B/Other/Sib.md": "file",
    Top: "folder",
    "Top/One.md": "file",
    "Top/Two.md": "file",
    "Root.md": "file",
  });

  const scaffoldOf = (s: ReturnType<typeof buildVisibilitySnapshot>): string[] =>
    deep
      .allPaths()
      .filter((p) => s.decisionFor(p).reason === "scaffold")
      .sort();

  const snapshot = (...members: SpaceDefinition["members"]) =>
    buildVisibilitySnapshot(deep, space({ members }), new Set(), noIgnore, new Set());

  it("climbs every level above a deeply nested member", () => {
    const s = snapshot({ path: "A/B/C/D/Deep.md", kind: "file" });
    expect(scaffoldOf(s)).toEqual(["A", "A/B", "A/B/C", "A/B/C/D"]);
    expect([...s.visiblePaths()].sort()).toEqual([
      "A",
      "A/B",
      "A/B/C",
      "A/B/C/D",
      "A/B/C/D/Deep.md",
    ]);
  });

  // The case a memoised climb is most likely to get wrong. Walking `Deep.md`
  // first marks A/B/C/D, A/B/C, A/B and A as handled; walking `Sib.md` next
  // must still record `A/B/Other` BEFORE it stops at the already-handled
  // `A/B`. An early-out placed one line too high loses that folder, and
  // `Sib.md` becomes a row with no parent to draw it under.
  it("records each branch's own folders while sharing the ancestors above them", () => {
    const s = snapshot(
      { path: "A/B/C/D/Deep.md", kind: "file" },
      { path: "A/B/C/D/Also.md", kind: "file" },
      { path: "A/B/Other/Sib.md", kind: "file" }
    );
    expect(scaffoldOf(s)).toEqual(["A", "A/B", "A/B/C", "A/B/C/D", "A/B/Other"]);
    expect(s.visiblePaths().size).toBe(8);
  });

  it("gives a root-level member no ancestors at all", () => {
    const s = snapshot({ path: "Root.md", kind: "file" });
    expect(scaffoldOf(s)).toEqual([]);
    expect([...s.visiblePaths()]).toEqual(["Root.md"]);
  });

  it("leaves an included folder out of the scaffold", () => {
    // `A/B/C` is a member and `A/B/C/D` is inherited from it, so neither is
    // scaffolding for anything: only the two folders ABOVE the member are.
    //
    // Checked by mutation: dropping the closure's `!included.has(d)` guard
    // does NOT fail this, and cannot fail anything, because `visible` is the
    // union of the two sets and `reasonFor` tests exact, inherited and visitor
    // before scaffold — every included path therefore answers on an earlier
    // branch whatever `scaffold` holds. The guard stays because it keeps the
    // set meaning what its name says and keeps `reasonFor` from depending on
    // its own branch order, not because a test can see it. What this test does
    // pin is the labelling and the two folders above the member, both of which
    // a truncated or over-eager climb gets wrong.
    const s = snapshot({ path: "A/B/C", kind: "folder" });
    expect(scaffoldOf(s)).toEqual(["A", "A/B"]);
    expect(s.decisionFor("A/B/C").reason).toBe("exact-member");
    expect(s.decisionFor("A/B/C/D").reason).toBe("inherited-member");
  });

  it("produces no scaffold when every ancestor is already included", () => {
    // A top-level folder member: its children's only ancestor is the member
    // itself, and the member has none. The scaffold must come out empty
    // rather than holding the folder a second time under another reason.
    const s = snapshot({ path: "Top", kind: "folder" });
    expect(scaffoldOf(s)).toEqual([]);
    expect([...s.visiblePaths()].sort()).toEqual(["Top", "Top/One.md", "Top/Two.md"]);
  });
});
