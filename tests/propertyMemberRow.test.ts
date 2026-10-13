import { describe, expect, it } from "vitest";
import {
  memberRows,
  memberSummary,
  propertyMemberCount,
  withoutPropertyMember,
  type PropertyMemberRow,
} from "../src/ui/memberList";
import { memberIdentity } from "../src/definitions/schema";
import { addPropertyMember, isPickableKey, readPropertyAdd } from "../src/ui/propertyRows";
import { resolveMembers } from "../src/controller/resolveMembers";
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
  const rows = memberRows(
    space,
    () => true,
    undefined,
    (m) => propertyMemberCount(m, index, space)
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

  it("counts a note another member also brings in, whichever member comes first", () => {
    // Dedupe is first-wins, so the order is what could hide the note from the
    // property member's count. Both orders must give the same number.
    const property: PropertyMember = { kind: "property", key: "status", value: "active" };
    const file: MemberEntry = { kind: "file", path: "Work/b.md" };
    for (const members of [[property, file], [file, property]]) {
      const space: SpaceDefinition = {
        id: "s",
        name: "S",
        icon: "box",
        color: "#808080",
        members,
      };
      const row = memberRows(space, () => true, undefined, (m) =>
        propertyMemberCount(m, ready, space)
      ).find((r) => r.kind === "property");
      expect(row).toMatchObject({ kind: "property", matchCount: 3 });
    }
  });

  it("returns the same notes the resolver does for a space holding only that member", () => {
    // Pins the sharing: the count is the resolver's answer, exclusions
    // included, so the two cannot decide one question two ways. The global
    // ignore is not exercised here because neither side can see it (it lives in
    // includedPaths, which a property match bypasses as a seed).
    for (const member of [
      { kind: "property", key: "status", value: "active" },
      { kind: "property", key: "status" },
      { kind: "property", key: "due" },
      { kind: "property", key: "nothing" },
    ] as PropertyMember[]) {
      for (const exclude of [[], ["Work/a.md"], ["WORK/B.MD", "Work/c.md"]]) {
        const space: SpaceDefinition = {
          id: "s",
          name: "S",
          icon: "box",
          color: "#808080",
          members: [member],
          exclude,
        };
        const noTags = { pathsMatching: () => [] };
        expect(propertyMemberCount(member, ready, space)).toBe(
          resolveMembers(space, noTags, ready).length
        );
      }
    }
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

describe("adding a property member to a space that already exists", () => {
  const before: SpaceDefinition = {
    id: "s",
    name: "Active",
    icon: "star",
    color: "#aa0000",
    members: [
      { kind: "folder", path: "Work" },
      { kind: "file", path: "a.md" },
      { kind: "tag", tag: "project" },
    ],
    exclude: ["b.md"],
  };

  function addTyped(space: SpaceDefinition, key: string, value = ""): SpaceDefinition {
    const read = readPropertyAdd(space.members, key, value);
    if (read.outcome !== "add") throw new Error(`expected an add, got ${read.outcome}`);
    return addPropertyMember(space, read.member);
  }

  it("adds one member at the end and changes nothing else about the space", () => {
    const snapshot = structuredClone(before);
    const after = addTyped(before, "status", "active");

    expect(after.members).toEqual([
      ...snapshot.members,
      { kind: "property", key: "status", value: "active" },
    ]);
    expect(after.id).toBe("s");
    expect(after.name).toBe("Active");
    expect(after.icon).toBe("star");
    expect(after.color).toBe("#aa0000");
    expect(after.exclude).toEqual(["b.md"]);
    // Every field the space has, so one this test did not think to name cannot
    // be dropped or added unnoticed.
    expect(Object.keys(after).sort()).toEqual(Object.keys(snapshot).sort());
    // The input is not edited in place.
    expect(before).toEqual(snapshot);
  });

  it("leaves an absent exclude absent", () => {
    const { exclude: _dropped, ...noExclude } = before;
    expect("exclude" in addTyped(noExclude, "status")).toBe(false);
  });

  it("reaches both shapes: has the property, and equals a value", () => {
    expect(readPropertyAdd(before.members, "due", "")).toEqual({
      outcome: "add",
      member: { kind: "property", key: "due" },
    });
    expect(readPropertyAdd(before.members, "status", "active")).toEqual({
      outcome: "add",
      member: { kind: "property", key: "status", value: "active" },
    });
  });

  it("holds both shapes of one key side by side, since they are different members", () => {
    const both = addTyped(addTyped(before, "status"), "status", "active");
    expect(both.members.filter((m) => m.kind === "property")).toHaveLength(2);
  });

  it("trims what was typed, because keys match exactly and a stray blank matches nothing", () => {
    expect(readPropertyAdd([], "  status ", " active ")).toEqual({
      outcome: "add",
      member: { kind: "property", key: "status", value: "active" },
    });
  });

  it("adding something already held is a no-op that says so, by memberIdentity", () => {
    const once = addTyped(before, "status", "active");
    // `normalizeValue` folds case and blanks, so this is the same member.
    const again = readPropertyAdd(once.members, "status", " Active ");
    expect(again).toEqual({ outcome: "held", label: "status: Active" });
    expect(readPropertyAdd(once.members, "status", "active").outcome).toBe("held");

    // And the pure adder itself refuses a second identical row, for a caller
    // that raced the check.
    const raced = addPropertyMember(once, { kind: "property", key: "status", value: "ACTIVE" });
    expect(raced).toBe(once);
    expect(raced.members).toHaveLength(once.members.length);
  });

  it("does not treat a path or tag spelled like the key as holding it", () => {
    const lookalikes: SpaceDefinition = {
      ...before,
      members: [
        { kind: "file", path: "status" },
        { kind: "tag", tag: "status" },
      ],
    };
    expect(readPropertyAdd(lookalikes.members, "status", "").outcome).toBe("add");
  });

  it("never offers a key the schema rejects or the picker hides", () => {
    expect(readPropertyAdd([], "", "x").outcome).toBe("blank");
    expect(readPropertyAdd([], "   ", "").outcome).toBe("blank");
    for (const key of ["tags", "tag", "Tags", "TAG", " tags "]) {
      expect(readPropertyAdd([], key, "").outcome).toBe("tags");
      expect(readPropertyAdd([], key, "x").outcome).toBe("tags");
    }
  });

  it("agrees with the picker's rule for every key, because it is the same rule", () => {
    for (const key of ["status", "tagline", "tags", "Tag", "", " ", "due date", "TAGS"]) {
      const adds = readPropertyAdd([], key, "").outcome === "add";
      expect(adds).toBe(isPickableKey(key.trim()));
    }
  });

  it("shows the new member as a row, with the count the index gives it", () => {
    const after = addTyped(before, "status", "active");
    const rows = memberRows(
      after,
      () => true,
      undefined,
      (m) => propertyMemberCount(m, ready, after)
    );
    const row = rows.find((r) => r.kind === "property");
    expect(row).toMatchObject({ kind: "property", label: "status: active" });
  });
});
