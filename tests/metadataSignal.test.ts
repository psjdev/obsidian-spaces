import { describe, expect, it } from "vitest";
import { watchesMetadata } from "../src/definitions/membership";
import type { SpaceDefinition } from "../src/types";

function space(members: SpaceDefinition["members"]): SpaceDefinition {
  return { id: "s", name: "S", icon: "box", color: "#808080", members };
}

describe("watchesMetadata", () => {
  it("is true for a space holding a tag member", () => {
    expect(watchesMetadata(space([{ kind: "tag", tag: "project" }]))).toBe(true);
  });

  it("is false for a space of files and folders", () => {
    expect(
      watchesMetadata(
        space([
          { kind: "file", path: "a.md" },
          { kind: "folder", path: "b" },
        ])
      )
    ).toBe(false);
  });

  it("is false for a space with no members", () => {
    expect(watchesMetadata(space([]))).toBe(false);
  });

  // All is active. Nothing is filtered, so a note's contents change nothing.
  it("is false when no space is active", () => {
    expect(watchesMetadata(null)).toBe(false);
  });

  it("is false for a folder space, which renders from its root", () => {
    const s = space([{ kind: "tag", tag: "project" }]);
    expect(watchesMetadata({ ...s, root: "Work" })).toBe(false);
  });
});
