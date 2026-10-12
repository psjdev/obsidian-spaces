// @vitest-environment jsdom
/**
 * While the property snapshot is unavailable, a space holding a property
 * member cannot say which notes it already shows, so nothing may be written to
 * it: an exact member added for a note the property member already covers
 * outlives that property member.
 */
import { describe, expect, it } from "vitest";
import type { TAbstractFile } from "obsidian";
import { addToSpace } from "../src/actions/membership";
import { spaceAddTargets } from "../src/actions/spaceAddTargets";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import type { SpaceController } from "../src/controller/SpaceController";
import { createPropertyIndex } from "../src/visibility/PropertyIndex";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import type { SpaceDefinition } from "../src/types";

const noTags = createMapTagIndex(new Map());
const propertySpace: SpaceDefinition = {
  id: "p",
  name: "Active",
  icon: "box",
  color: "#808080",
  members: [{ kind: "property", key: "status", value: "active" }],
};
const index = createPropertyIndex([{ path: "Work/a.md", frontmatter: { status: "active" } }], 1);

describe("spaceAddTargets while the property snapshot is unavailable", () => {
  it("does not offer a space whose property member it cannot adjudicate", () => {
    const [t] = spaceAddTargets([propertySpace], ["Work/a.md"], noTags, null);
    expect(t.disabled).toBe(true);
    expect(t.addablePaths).toEqual([]);
  });

  it("still offers a space with no property member", () => {
    const plain: SpaceDefinition = { ...propertySpace, id: "q", members: [] };
    const [t] = spaceAddTargets([plain], ["Work/a.md"], noTags, null);
    expect(t.disabled).toBe(false);
    expect(t.addablePaths).toEqual(["Work/a.md"]);
  });

  it("reports a note a property member holds as already added once the index is ready", () => {
    const [t] = spaceAddTargets([propertySpace], ["Work/a.md"], noTags, index);
    expect(t).toMatchObject({ disabled: true, label: "Active (already added)" });
  });
});

describe("addToSpace while the property snapshot is unavailable", () => {
  it("writes nothing to a space holding a property member", async () => {
    const defs = new DefinitionStore({ read: async () => undefined, write: async () => undefined });
    await defs.mutate((d) => {
      d.spaces = [propertySpace];
    });
    const ctx = {
      defs,
      controller: {
        tagIndex: () => noTags,
        propertyIndex: () => null,
      } as unknown as SpaceController,
    };
    const file = { path: "Work/a.md", name: "a.md" } as unknown as TAbstractFile;
    await addToSpace(ctx, "p", [file]);
    expect(defs.get().spaces[0].members).toEqual([{ kind: "property", key: "status", value: "active" }]);
  });
});
