// @vitest-environment jsdom
/**
 * `addToSpace`, the add by space id that a drop on a space icon calls, reports
 * what it changed rather than what it was asked to do.
 *
 * Driven directly, not through `decorate`: it is exported for exactly that
 * caller, and the menu cannot reach it with an already-held row. The string
 * shapes are pinned in `addOutcomeMessage.test.ts`; what is pinned HERE is that
 * the write splits the batch correctly before it reports.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { TAbstractFile } from "obsidian";
import { addToSpace } from "../src/actions/membership";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import type { SpaceController } from "../src/controller/SpaceController";

function file(path: string): TAbstractFile {
  // `entryFor` asks `instanceof TFolder`, which a plain object is not.
  return { path, name: path.split("/").pop() } as unknown as TAbstractFile;
}

function notices(): string[] {
  return Array.from(document.querySelectorAll(".notice-message")).map((n) => n.textContent ?? "");
}

let defs: DefinitionStore;
let ctx: { defs: DefinitionStore; controller: SpaceController };

beforeEach(async () => {
  defs = new DefinitionStore({ read: async () => undefined, write: async () => undefined });
  await defs.mutate((d) => {
    d.spaces = [
      {
        id: "research",
        name: "Research",
        icon: "microscope",
        color: "#4ecdc4",
        members: [{ path: "Notes/Held.md", kind: "file" }],
      },
    ];
  });
  ctx = { defs, controller: {} as unknown as SpaceController };
});

/** The notice this one call produced, not the ones earlier tests left in the DOM. */
async function noticeFrom(files: TAbstractFile[]): Promise<string[]> {
  const before = notices().length;
  await addToSpace(ctx, "research", files);
  return notices().slice(before);
}

function stored(): string[] {
  return defs.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]));
}

describe("addToSpace reports what it changed", () => {
  it("says an already-held path is already there, not that it was added", async () => {
    expect(await noticeFrom([file("Notes/Held.md")])).toEqual(["Held.md is already in Research"]);
    expect(stored()).toEqual(["Notes/Held.md"]);
  });

  it("matches the held path case-insensitively, as samePath does", async () => {
    expect(await noticeFrom([file("notes/held.md")])).toEqual(["held.md is already in Research"]);
    expect(stored()).toEqual(["Notes/Held.md"]);
  });

  it("counts only the new one in a mixed batch", async () => {
    expect(await noticeFrom([file("Notes/Held.md"), file("Notes/New.md")])).toEqual([
      "Added New.md to Research",
    ]);
    expect(stored()).toEqual(["Notes/Held.md", "Notes/New.md"]);
  });

  it("counts a path given twice once", async () => {
    expect(await noticeFrom([file("Notes/New.md"), file("Notes/New.md")])).toEqual([
      "Added New.md to Research",
    ]);
    expect(stored()).toEqual(["Notes/Held.md", "Notes/New.md"]);
  });

  it("counts two paths that differ only in case once", async () => {
    expect(await noticeFrom([file("Notes/New.md"), file("notes/new.md")])).toEqual([
      "Added New.md to Research",
    ]);
    expect(stored()).toEqual(["Notes/Held.md", "Notes/New.md"]);
  });

  it("counts a held path given twice once", async () => {
    expect(await noticeFrom([file("Notes/Held.md"), file("notes/held.md")])).toEqual([
      "Held.md is already in Research",
    ]);
  });
});
