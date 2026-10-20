import { describe, expect, it } from "vitest";
import { activeSpaces, archivedSpaces, isArchived } from "../src/definitions/archived";
import type { SpaceDefinition } from "../src/types";

function space(id: string, archived?: true): SpaceDefinition {
  return {
    id,
    name: id,
    icon: "folder",
    color: "#4ecdc4",
    ...(archived ? { archived } : {}),
    members: [],
  };
}

describe("archived selectors", () => {
  it("treats a space with no archived field as active", () => {
    expect(isArchived(space("a"))).toBe(false);
  });

  it("treats archived: true as archived", () => {
    expect(isArchived(space("a", true))).toBe(true);
  });

  it("splits a list, preserving order within each half", () => {
    const list = [space("a"), space("b", true), space("c"), space("d", true), space("e")];
    expect(activeSpaces(list).map((s) => s.id)).toEqual(["a", "c", "e"]);
    expect(archivedSpaces(list).map((s) => s.id)).toEqual(["b", "d"]);
  });
});
