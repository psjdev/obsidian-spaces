import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";
import { pathMembers } from "../src/definitions/membership";
import type { SpaceDefinition } from "../src/types";

function doc(members: unknown): unknown {
  return {
    schemaVersion: 1,
    settings: {},
    spaces: [{ id: "s", name: "S", icon: "box", color: "#808080", members }],
  };
}

describe("tag members in the schema", () => {
  it("keeps a tag member", () => {
    const r = validateDefinitions(doc([{ kind: "tag", tag: "project" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].members).toEqual([{ kind: "tag", tag: "project" }]);
  });

  it("stores a tag without its leading hash", () => {
    const r = validateDefinitions(doc([{ kind: "tag", tag: "#Project" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].members).toEqual([{ kind: "tag", tag: "project" }]);
  });

  it("keeps file and folder members exactly as before", () => {
    const r = validateDefinitions(
      doc([
        { kind: "file", path: "a/b.md" },
        { kind: "folder", path: "a" },
      ])
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].members).toEqual([
      { kind: "file", path: "a/b.md" },
      { kind: "folder", path: "a" },
    ]);
  });

  it("de-duplicates two members naming the same tag", () => {
    const r = validateDefinitions(
      doc([
        { kind: "tag", tag: "project" },
        { kind: "tag", tag: "#Project" },
      ])
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.spaces[0].members).toHaveLength(1);
  });

  it("rejects an empty tag", () => {
    const r = validateDefinitions(doc([{ kind: "tag", tag: "  " }]));
    expect(r.ok).toBe(false);
  });

  it("rejects a non-string tag", () => {
    const r = validateDefinitions(doc([{ kind: "tag", tag: 3 }]));
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown member kind", () => {
    const r = validateDefinitions(doc([{ kind: "property", key: "x" }]));
    expect(r.ok).toBe(false);
  });
});

describe("pathMembers", () => {
  it("returns only the members that name a path", () => {
    const space = {
      id: "s",
      name: "S",
      icon: "box",
      color: "#808080",
      members: [
        { kind: "file", path: "a/b.md" },
        { kind: "tag", tag: "project" },
        { kind: "folder", path: "a" },
      ],
    } as SpaceDefinition;
    expect(pathMembers(space).map((m) => m.path)).toEqual(["a/b.md", "a"]);
  });
});
