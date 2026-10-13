import { describe, expect, it } from "vitest";
import {
  memberRows,
  memberSummary,
  propertyMemberCount,
  withoutPropertyMember,
  type PropertyMemberRow,
} from "../src/ui/memberList";
import { memberIdentity } from "../src/definitions/schema";
import { compileIgnore } from "../src/visibility/glob";
import { createPropertyIndex, type PropertyIndex } from "../src/visibility/PropertyIndex";
import type { MemberEntry, SpaceDefinition } from "../src/types";

type PropertyMember = Extract<MemberEntry, { kind: "property" }>;

const notes = [
  { path: "Work/a.md", frontmatter: { status: "active", due: "2026-01-01" } },
  { path: "Work/b.md", frontmatter: { status: "active" } },
  { path: "Work/c.md", frontmatter: { status: "active" } },
  { path: "Other/d.md", frontmatter: { status: "done" } },
];
const ready: PropertyIndex = createPropertyIndex(notes, 1);

function rowFor(
  member: PropertyMember,
  opts: {
    exclude?: string[];
    members?: MemberEntry[];
    ignore?: string[];
    properties?: PropertyIndex | null;
  } = {}
): PropertyMemberRow {
  const space: SpaceDefinition = {
    id: "s",
    name: "S",
    icon: "box",
    color: "#808080",
    members: [member, ...(opts.members ?? [])],
    ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }),
  };
  const index = opts.properties === undefined ? ready : opts.properties;
  const ignore = compileIgnore(opts.ignore ?? []);
  const rows = memberRows(
    space,
    () => true,
    undefined,
    (m) => propertyMemberCount(m, index, space.exclude ?? [], ignore)
  );
  const row = rows[0];
  if (row.kind !== "property") throw new Error("expected a property row first");
  return row;
}

describe("a property member's row", () => {
  it("reads as the key for the existence shape", () => {
    expect(rowFor({ kind: "property", key: "due" }).label).toBe("due");
  });

  it("reads as key: value in the spelling the user picked", () => {
    expect(rowFor({ kind: "property", key: "status", value: "Active" }).label).toBe(
      "status: Active"
    );
  });

  it("is never missing, because it names no path", () => {
    expect("missing" in rowFor({ kind: "property", key: "due" })).toBe(false);
    expect(rowFor({ kind: "property", key: "due" }).status).not.toBe("missing");
  });

  it("counts after this space's exclusions", () => {
    // Excluded from the property member but visible through an exact file
    // member. The tree shows it; this count does not.
    const row = rowFor(
      { kind: "property", key: "status", value: "active" },
      { exclude: ["Work/a.md"], members: [{ kind: "file", path: "Work/a.md" }] }
    );
    expect(row.matchCount).toBe(2);
  });

  it("counts a note another member also brings in", () => {
    const row = rowFor(
      { kind: "property", key: "status", value: "active" },
      { members: [{ kind: "file", path: "Work/b.md" }] }
    );
    expect(row.matchCount).toBe(3);
  });

  it("counts after the global ignore", () => {
    const row = rowFor(
      { kind: "property", key: "status", value: "active" },
      { ignore: ["Work/c.md"] }
    );
    expect(row.matchCount).toBe(2);
  });

  it("reports an unavailable count distinctly from zero", () => {
    const cold = rowFor({ kind: "property", key: "due" }, { properties: null });
    expect(cold.matchCount).toBeNull();
    expect(cold.status).toBe("present");
    const none = rowFor({ kind: "property", key: "nothing" });
    expect(none.matchCount).toBe(0);
    expect(none.status).toBe("matches-nothing");
  });

  it("is a row with no count at all when the caller does not count", () => {
    const space: SpaceDefinition = {
      id: "s",
      name: "S",
      icon: "box",
      color: "#808080",
      members: [{ kind: "property", key: "due" }],
    };
    const rows = memberRows(space, () => true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "property", matchCount: null, status: "present" });
    expect(memberSummary(rows)).toBe("1 member");
  });

  it("removes by identity, not by spelling", () => {
    const members = [
      { kind: "property", key: "a", value: "b" },
      { kind: "property", key: "a=b" },
    ] as MemberEntry[];
    const left = withoutPropertyMember(members, memberIdentity(members[0]));
    expect(left).toEqual([{ kind: "property", key: "a=b" }]);
  });

  it("leaves file, folder and tag members alone when removing", () => {
    const members: MemberEntry[] = [
      { kind: "file", path: "a" },
      { kind: "folder", path: "a" },
      { kind: "tag", tag: "a" },
      { kind: "property", key: "a" },
    ];
    expect(withoutPropertyMember(members, memberIdentity(members[3]))).toEqual(
      members.slice(0, 3)
    );
  });
});
