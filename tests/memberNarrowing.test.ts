/**
 * The narrowing that TypeScript cannot check.
 *
 * `pathMembers` and `resolveMembers` both narrowed with `m.kind !== "tag"`, a
 * user-supplied type predicate whose body the compiler takes on trust. A third
 * member kind therefore arrives as a `PathMember` with no `path`, and the ten
 * callers that read `m.path` get `undefined`. `renameTouchesDefs` is the worst
 * of them: it runs on every rename over every space, so one property member in
 * one space breaks member repair for the whole vault.
 */
import { describe, expect, it } from "vitest";
import { pathMembers } from "../src/definitions/membership";
import { renameTouchesDefs } from "../src/main";
import type { SpaceDefinition, SpacesDefinitions } from "../src/types";

const space = (members: SpaceDefinition["members"]): SpaceDefinition => ({
  id: "s",
  name: "S",
  icon: "box",
  color: "#808080",
  members,
});

describe("path member narrowing", () => {
  it("keeps file and folder members and drops every other kind", () => {
    const s = space([
      { kind: "file", path: "a.md" },
      { kind: "folder", path: "Work" },
      { kind: "tag", tag: "project" },
      { kind: "property", key: "status", value: "active" },
    ]);
    expect(pathMembers(s)).toEqual([
      { kind: "file", path: "a.md" },
      { kind: "folder", path: "Work" },
    ]);
  });

  it("never yields a member without a path", () => {
    const s = space([{ kind: "property", key: "status" }]);
    for (const m of pathMembers(s)) expect(typeof m.path).toBe("string");
  });

  it("survives a rename when a space holds a property member", () => {
    // The real failure: `hit(m.path)` calls `undefined.startsWith` and throws
    // out of a vault event handler.
    const defs = {
      spaces: [space([{ kind: "property", key: "status" }, { kind: "file", path: "Work/a.md" }])],
    } as unknown as SpacesDefinitions;
    expect(() => renameTouchesDefs(defs, "Work/a.md", "Work/b.md")).not.toThrow();
    expect(renameTouchesDefs(defs, "Work/a.md", "Work/b.md")).toBe(true);
  });
});
