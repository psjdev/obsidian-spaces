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
  ctx = {
    defs,
    // `addToSpace` asks what the space SHOWS, so it needs a tag index. These
    // spaces hold no tag member, so an empty one answers every question here.
    controller: { tagIndex: () => ({ pathsMatching: () => [] }) } as unknown as SpaceController,
  };
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


/**
 * What the space SHOWS, not what it stores.
 *
 * A drop reaches rows the *All* menu never offered: that menu filters its
 * selection through `heldBy` before it ever calls this, so for a long time
 * nothing exercised the question here and the add deduped against
 * `pathMembers` alone. Dropping a row the space already displayed through a
 * tag or a member folder then wrote an EXPLICIT member for it. Nothing visibly
 * changed, the notice said it had been added, and -- because `resolveMembers`
 * never drops a hand-picked member -- that member outlived the tag or folder
 * that had justified it: untag the note and it stays in the space, with
 * nothing on screen to say why.
 */
describe("addToSpace dedupes against what the space shows", () => {
  /** A space holding the folder `Projects` and the tag `#project`. */
  async function covering(tagged: string[]): Promise<{
    ctx: { defs: DefinitionStore; controller: SpaceController };
    defs: DefinitionStore;
  }> {
    const d = new DefinitionStore({ read: async () => undefined, write: async () => undefined });
    await d.mutate((x) => {
      x.spaces = [
        {
          id: "research",
          name: "Research",
          icon: "microscope",
          color: "#4ecdc4",
          members: [
            { path: "Projects", kind: "folder" },
            { kind: "tag", tag: "project" },
          ],
        },
      ];
    });
    return {
      defs: d,
      ctx: {
        defs: d,
        controller: {
          tagIndex: () => ({ pathsMatching: () => tagged }),
        } as unknown as SpaceController,
      },
    };
  }

  function members(d: DefinitionStore): string[] {
    return d.get().spaces[0].members.flatMap((m) => (m.kind === "tag" ? [] : [m.path]));
  }

  it("writes nothing for a note the space holds through a member folder", async () => {
    const { ctx: c, defs: d } = await covering([]);
    const before = notices().length;
    await addToSpace(c, "research", [file("Projects/plan.md")]);
    expect(notices().slice(before)).toEqual(["plan.md is already in Research"]);
    expect(members(d)).toEqual(["Projects"]);
  });

  it("writes nothing for a note the space holds through a tag", async () => {
    const { ctx: c, defs: d } = await covering(["Notes/Tagged.md"]);
    const before = notices().length;
    await addToSpace(c, "research", [file("Notes/Tagged.md")]);
    expect(notices().slice(before)).toEqual(["Tagged.md is already in Research"]);
    expect(members(d)).toEqual(["Projects"]);
  });

  it("still adds a note the space does not show, and only that one", async () => {
    const { ctx: c, defs: d } = await covering(["Notes/Tagged.md"]);
    const before = notices().length;
    await addToSpace(c, "research", [
      file("Projects/plan.md"),
      file("Notes/Tagged.md"),
      file("Notes/Loose.md"),
    ]);
    expect(notices().slice(before)).toEqual(["Added Loose.md to Research"]);
    expect(members(d)).toEqual(["Projects", "Notes/Loose.md"]);
  });

  // The one case where a covered path IS addable, and deliberately so: an
  // exclusion beats folder coverage, so the space is not showing this row and
  // adding it is the way back. `heldBy` draws that line, and the add follows it
  // rather than drawing a second one.
  it("adds a path the space covers by folder but excludes", async () => {
    const { ctx: c, defs: d } = await covering([]);
    await d.mutate((x) => {
      x.spaces[0].exclude = ["Projects/plan.md"];
    });
    const before = notices().length;
    await addToSpace(c, "research", [file("Projects/plan.md")]);
    expect(notices().slice(before)).toEqual(["Added plan.md to Research"]);
    expect(members(d)).toEqual(["Projects", "Projects/plan.md"]);
  });
});
