/**
 * Issue #41: whether the vault's global ignore applies to a space's members
 * depends on HOW the member names its notes.
 *
 * A note or folder the person pointed at keeps bypassing the ignore — that
 * gesture is the most explicit instruction the plugin ever receives. A tag
 * member and a property member name a RULE, and the ignore is a rule too, so
 * the narrower of the two wins and a hidden note is not collected.
 *
 * Every case here drives the REAL chain a recompute drives —
 * `resolveMembers` into `buildVisibilitySnapshot`, with one compiled ignore
 * handed to both, exactly as `SpaceController.recompute` does. A test that
 * called `expandMembers` alone could not see the scaffold rows, which is
 * where half the user-visible answer lives.
 */
import { describe, expect, it } from "vitest";
import { buildVisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { createTreeVaultIndex } from "../src/visibility/VaultIndex";
import { canonicalPath, compileIgnore, type IgnoreMatcher } from "../src/visibility/glob";
import { MEMBER_NAMING, resolveMembers } from "../src/controller/resolveMembers";
import { propertyMemberCount, tagMemberCount } from "../src/ui/memberList";
import { buildPreview } from "../src/ui/previewSeam";
import { spaceAddTargets } from "../src/actions/spaceAddTargets";
import { createPropertyIndex } from "../src/visibility/PropertyIndex";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import type { MemberEntry, MemberKind, SpaceDefinition } from "../src/types";

const vault = createTreeVaultIndex(
  new Map<string, MemberKind>([
    ["Archive", "folder"],
    ["Archive/old.md", "file"],
    ["Archive/Deep", "folder"],
    ["Archive/Deep/x.md", "file"],
    ["Work", "folder"],
    ["Work/a.md", "file"],
  ])
);

/** Every note below carries `project` and `status: active`, hidden or not. */
const tags = createMapTagIndex(
  new Map([["project", ["Archive/old.md", "Archive/Deep/x.md", "Work/a.md"]]])
);

const properties = createPropertyIndex(
  [
    { path: "Archive/old.md", frontmatter: { status: "active" } },
    { path: "Archive/Deep/x.md", frontmatter: { status: "active" } },
    { path: "Work/a.md", frontmatter: { status: "active" } },
  ],
  1
);

/**
 * `Archive/**` and not `Archive`: the grammar makes `a/**` require a
 * following segment, so the folder itself is NOT ignored and can still be
 * drawn as a scaffold row. That is the shape that makes the scaffold cases
 * below say something — with the folder ignored too, "not drawn" would have
 * two possible explanations.
 */
const IGNORE: IgnoreMatcher = compileIgnore(["Archive/**"]);

const TAG_MEMBER: MemberEntry = { kind: "tag", tag: "project" };
const PROPERTY_MEMBER: MemberEntry = { kind: "property", key: "status", value: "active" };

function space(members: MemberEntry[], exclude?: string[]): SpaceDefinition {
  return {
    id: "s",
    name: "S",
    icon: "box",
    color: "#808080",
    members,
    ...(exclude === undefined ? {} : { exclude }),
  };
}

/** The recompute, start to finish: one ignore, both halves. */
function snapshotOf(s: SpaceDefinition, ignore: IgnoreMatcher = IGNORE) {
  return buildVisibilitySnapshot(
    vault,
    { ...s, members: [...resolveMembers(s, tags, properties, ignore)] },
    new Set<string>(),
    ignore,
    new Set((s.exclude ?? []).map(canonicalPath))
  );
}

const visible = (s: SpaceDefinition, ignore?: IgnoreMatcher): Set<string> =>
  snapshotOf(s, ignore).visiblePaths();

describe("a member that names a rule honors the global ignore", () => {
  it("does not collect a tagged note the ignore hides", () => {
    const v = visible(space([TAG_MEMBER]));
    expect(v.has("Work/a.md")).toBe(true);
    expect(v.has("Archive/old.md")).toBe(false);
    expect(v.has("Archive/Deep/x.md")).toBe(false);
  });

  it("does not collect a property-matched note the ignore hides", () => {
    const v = visible(space([PROPERTY_MEMBER]));
    expect(v.has("Work/a.md")).toBe(true);
    expect(v.has("Archive/old.md")).toBe(false);
    expect(v.has("Archive/Deep/x.md")).toBe(false);
  });

  it("collects every match again once the ignore is emptied", () => {
    // The other half of the first case: the notes are reachable, and it is
    // the ignore and nothing else that is keeping them out above.
    const v = visible(space([TAG_MEMBER]), compileIgnore([]));
    expect(v.has("Archive/old.md")).toBe(true);
    expect(v.has("Archive/Deep/x.md")).toBe(true);
  });

  it("draws no folder row for a folder whose only notes were hidden", () => {
    // The ancestor closure is "regardless of ignore rules", and `Archive`
    // itself is NOT matched by `Archive/**`. It stays out anyway, because
    // nothing inside it is in the space any more — so a space built from a
    // tag no longer grows an empty branch down to notes it cannot show.
    const v = visible(space([TAG_MEMBER]));
    expect(v.has("Archive")).toBe(false);
    expect(v.has("Archive/Deep")).toBe(false);
  });

  it("reports the hidden note as hidden BY THE IGNORE, not as a non-member", () => {
    // The reason is what the explorer's own vocabulary reads; "hidden-nonmember"
    // would be a lie about why the row is gone.
    const d = snapshotOf(space([TAG_MEMBER])).decisionFor("Archive/old.md");
    expect(d.visible).toBe(false);
    expect(d.reason).toBe("hidden-ignore");
  });
});

describe("a note or folder added by hand still bypasses the global ignore", () => {
  it("keeps a hand-added note that lives inside an ignored folder", () => {
    const v = visible(space([{ kind: "file", path: "Archive/old.md" }]));
    expect(v.has("Archive/old.md")).toBe(true);
  });

  it("scaffolds the ignored folder above it, so the note is reachable", () => {
    const snap = snapshotOf(space([{ kind: "file", path: "Archive/Deep/x.md" }]));
    expect(snap.visiblePaths().has("Archive")).toBe(true);
    expect(snap.decisionFor("Archive").reason).toBe("scaffold");
    expect(snap.decisionFor("Archive/Deep").reason).toBe("scaffold");
  });

  it("says the note overrides the ignore", () => {
    const d = snapshotOf(space([{ kind: "file", path: "Archive/old.md" }])).decisionFor(
      "Archive/old.md"
    );
    expect(d.visible).toBe(true);
    expect(d.reason).toBe("exact-member");
    expect(d.overridesIgnore).toBe(true);
  });

  it("keeps an ignored folder added by hand", () => {
    const v = visible(space([{ kind: "folder", path: "Archive/Deep" }]));
    expect(v.has("Archive/Deep")).toBe(true);
  });
});

describe("a hand-added member beats a rule member on the same note", () => {
  // The two filters live in one `take`, and a filtered path is not marked
  // seen, so the answer cannot depend on which member happens to be listed
  // first. Both orders are asserted because member order is user-controlled.
  const byHand: MemberEntry = { kind: "file", path: "Archive/old.md" };

  it("when the rule is listed first", () => {
    expect(visible(space([TAG_MEMBER, byHand])).has("Archive/old.md")).toBe(true);
  });

  it("when the hand-added member is listed first", () => {
    expect(visible(space([byHand, TAG_MEMBER])).has("Archive/old.md")).toBe(true);
  });

  it("and the other matches the rule brought in are unaffected", () => {
    const v = visible(space([TAG_MEMBER, byHand]));
    expect(v.has("Work/a.md")).toBe(true);
    expect(v.has("Archive/Deep/x.md")).toBe(false);
  });
});

describe("the global ignore and a space's own exclude stay separate things", () => {
  it("still keeps a hand-added note the space excludes", () => {
    const s = space([{ kind: "file", path: "Work/a.md" }], ["Work/a.md"]);
    expect(visible(s).has("Work/a.md")).toBe(true);
  });

  it("still drops a tagged note the space excludes, with nothing ignored", () => {
    const s = space([TAG_MEMBER], ["Work/a.md"]);
    expect(visible(s, compileIgnore([])).has("Work/a.md")).toBe(false);
  });
});

describe("MEMBER_NAMING", () => {
  it("says which side each member kind falls on", () => {
    expect(MEMBER_NAMING).toEqual({
      file: "picked",
      folder: "picked",
      tag: "rule",
      property: "rule",
    });
  });

  it("has an answer for every kind, and no answer for a kind that does not exist", () => {
    // The real guarantee is the type: `Record<MemberEntry["kind"], ...>` is a
    // compile error the moment a kind is added without a key. This asserts
    // the runtime side of the same fact, so a key quietly deleted and the
    // record widened to an index signature would still be caught.
    expect(Object.keys(MEMBER_NAMING).sort()).toEqual(["file", "folder", "property", "tag"]);
  });
});

describe("the member counts in Contents… agree with the tree", () => {
  it("a property member's count leaves out a note the ignore hides", () => {
    const s = space([PROPERTY_MEMBER]);
    expect(propertyMemberCount(PROPERTY_MEMBER, properties, s, IGNORE)).toBe(1);
    expect(propertyMemberCount(PROPERTY_MEMBER, properties, s, compileIgnore([]))).toBe(3);
  });

  it("a tag member's count leaves out a note the ignore hides", () => {
    expect(tagMemberCount("project", tags, IGNORE)).toBe(1);
    expect(tagMemberCount("project", tags, compileIgnore([]))).toBe(3);
  });

  it("the counts match the notes the space actually shows", () => {
    const s = space([TAG_MEMBER]);
    const notes = [...visible(s)].filter((p) => vault.kindOf(p) === "file").length;
    expect(tagMemberCount("project", tags, IGNORE)).toBe(notes);
  });
});

describe("the create panel's preview", () => {
  it("promises only the notes the space will actually hold", () => {
    // The number under the picker is what the user judges the space by
    // before it exists, so it runs the same expansion and must land on the
    // same answer as the tree.
    const preview = buildPreview(vault, IGNORE, tags, () => properties);
    const s = space([TAG_MEMBER]);
    const notes = [...visible(s)].filter((p) => vault.kindOf(p) === "file").length;
    expect(preview([TAG_MEMBER]).notes).toBe(notes);
    expect(preview([TAG_MEMBER]).paths.has("Archive/old.md")).toBe(false);
  });
});

describe("adding the note by hand is still the way back in", () => {
  it("offers a tag-matched note the ignore hides, rather than calling it already added", () => {
    // The space does not show the note any more, so "Add to space" has to
    // offer it. Writing an exact member is the one gesture that brings a
    // hidden note back, because a hand-added member is a seed.
    const s = space([TAG_MEMBER]);
    const [t] = spaceAddTargets([s], ["Archive/old.md"], tags, properties, IGNORE);
    expect(t).toMatchObject({ disabled: false, addablePaths: ["Archive/old.md"] });
  });

  it("still calls a tag-matched note nothing hides already added", () => {
    const s = space([TAG_MEMBER]);
    const [t] = spaceAddTargets([s], ["Work/a.md"], tags, properties, IGNORE);
    expect(t).toMatchObject({ disabled: true, addablePaths: [] });
  });
});
