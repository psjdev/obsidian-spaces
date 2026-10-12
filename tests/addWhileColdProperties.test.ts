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
import { SpaceController } from "../src/controller/SpaceController";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildFakeVault } from "./helpers/fakeVault";
import type { PropertySnapshot } from "../src/visibility/PropertyIndex";
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

function notices(): string[] {
  return Array.from(document.querySelectorAll(".notice-message")).map((n) => n.textContent ?? "");
}

/** A REAL controller, so the add path sees what the tree would be drawn from. */
async function realContext(initial: PropertySnapshot) {
  const defs = new DefinitionStore({ read: async () => undefined, write: async () => undefined });
  await defs.mutate((d) => {
    d.spaces = [propertySpace];
  });
  const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
  runtime.load();
  let answer = initial;
  const controller = new SpaceController(
    defs,
    runtime,
    buildFakeVault({ Work: "folder", "Work/a.md": "file" }),
    { apply: () => undefined, livePaths: () => new Set<string>() },
    noTags,
    () => answer
  );
  return { defs, controller, set: (s: PropertySnapshot) => void (answer = s) };
}
const aFile = { path: "Work/a.md", name: "a.md" } as unknown as TAbstractFile;

describe("a note a property member shows is still held after the snapshot goes cold", () => {
  it("answers from the last ready index: no notice about properties, no redundant member", async () => {
    const { defs, controller, set } = await realContext({ status: "ready", index });
    controller.drawnPropertyIndex();
    set({ status: "unavailable" });
    const before = notices().length;
    await addToSpace({ defs, controller }, "p", [aFile]);
    expect(notices().slice(before)).toEqual(["a.md is already in Active"]);
    expect(defs.get().spaces[0].members).toEqual([{ kind: "property", key: "status", value: "active" }]);
  });

  it("offers nothing to add for that note either", async () => {
    const { controller, set } = await realContext({ status: "ready", index });
    controller.drawnPropertyIndex();
    set({ status: "unavailable" });
    const [t] = spaceAddTargets([propertySpace], ["Work/a.md"], noTags, controller.drawnPropertyIndex());
    expect(t.label).toBe("Active (already added)");
  });

  it("still refuses when no index has ever been ready", async () => {
    const { defs, controller } = await realContext({ status: "unavailable" });
    const before = notices().length;
    await addToSpace({ defs, controller }, "p", [aFile]);
    expect(notices().slice(before)).toEqual([
      "Spaces has not read this vault's properties yet. Try again in a moment.",
    ]);
    expect(defs.get().spaces[0].members).toEqual([{ kind: "property", key: "status", value: "active" }]);
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
        drawnPropertyIndex: () => null,
      } as unknown as SpaceController,
    };
    const file = { path: "Work/a.md", name: "a.md" } as unknown as TAbstractFile;
    await addToSpace(ctx, "p", [file]);
    expect(defs.get().spaces[0].members).toEqual([{ kind: "property", key: "status", value: "active" }]);
  });
});
