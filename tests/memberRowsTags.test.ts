import { describe, expect, it } from "vitest";
import { memberRows } from "../src/ui/memberList";
import type { SpaceDefinition } from "../src/types";

function space(members: SpaceDefinition["members"]): SpaceDefinition {
  return { id: "s", name: "S", icon: "box", color: "#808080", members };
}

const exists = (p: string): boolean => p === "a.md";

describe("memberRows with tag members", () => {
  it("returns a row for a tag member", () => {
    const rows = memberRows(space([{ kind: "tag", tag: "project" }]), exists, () => 2);
    expect(rows).toEqual([
      { kind: "tag", tag: "project", status: "present", matchCount: 2 },
    ]);
  });

  // A tag matching nothing is worth showing, and is not the same as a file
  // that has gone missing.
  it("marks a tag that currently matches nothing", () => {
    const rows = memberRows(space([{ kind: "tag", tag: "ghost" }]), exists, () => 0);
    expect(rows[0]).toMatchObject({ kind: "tag", status: "matches-nothing" });
  });

  // The settings tab stopped counting: building a tag index to draw the
  // number cost a full vault metadata walk inside `onload()`, which Obsidian
  // awaits, for a page nobody had opened. A caller that cannot count says so
  // by passing nothing, and gets a row reporting no number rather than a
  // wrong one.
  it("returns a tag row with no count when the caller cannot count", () => {
    const rows = memberRows(space([{ kind: "tag", tag: "project" }]), exists);
    expect(rows).toEqual([
      { kind: "tag", tag: "project", status: "present", matchCount: null },
    ]);
  });

  it("does not accuse an uncounted tag of matching nothing", () => {
    // "No matches" and "not counted" are different answers. Reporting the
    // second as the first would put a permanent "needs attention" on every
    // space holding a tag.
    const rows = memberRows(space([{ kind: "tag", tag: "ghost" }]), exists);
    expect(rows[0].status).toBe("present");
  });

  it("keeps path rows in definition order beside tag rows", () => {
    const rows = memberRows(
      space([
        { kind: "file", path: "a.md" },
        { kind: "tag", tag: "project" },
        { kind: "file", path: "gone.md" },
      ]),
      exists,
      () => 1
    );
    expect(rows.map((r) => r.status)).toEqual(["present", "present", "missing"]);
  });
});
