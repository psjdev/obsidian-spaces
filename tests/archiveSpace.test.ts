import { describe, expect, it } from "vitest";
import { archiveSpace, restoreSpace } from "../src/actions/archiveSpace";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { SCHEMA_VERSION, type SpacesDefinitions } from "../src/types";

function space(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, icon: "box", color: "#aabbcc", members: [], ...extra };
}

function store(): DefinitionStore {
  const stored: unknown = {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: true, revealVisitors: true },
    spaces: [
      space("a"),
      space("b", {
        members: [{ kind: "folder", path: "Projects" }, { kind: "tag", tag: "work" }],
        // STRING paths, which is what `exclude` is. An array of objects is
        // what this fixture used to hold, and `validateSpace` keeps only
        // entries passing `isSafeVaultPath`, which rejects a non-string: the
        // key was dropped at load and the assertion below compared
        // `undefined` to `undefined`, passing against any implementation,
        // including one that deletes the exclusion list outright. In the one
        // file whose whole point is that archiving preserves things.
        exclude: ["Projects/Old/skip.md", "Projects/Old/Deep/also.md"],
        root: "Projects",
      }),
      space("c"),
    ],
    orders: { bySpaceId: { b: { "": ["z", "y"] } } },
  };
  return new DefinitionStore({ read: async () => stored, write: async () => {} });
}

async function loaded(): Promise<DefinitionStore> {
  const s = store();
  await s.load();
  return s;
}

describe("archiveSpace", () => {
  it("marks the space archived and leaves it in the spaces array at the same index", async () => {
    const s = await loaded();
    await archiveSpace(s, "b");
    const spaces = s.get().spaces;
    expect(spaces.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(spaces[1].archived).toBe(true);
    expect(spaces[0].archived).toBeUndefined();
    expect(spaces[2].archived).toBeUndefined();
  });

  it("keeps orders.bySpaceId for the archived space", async () => {
    const s = await loaded();
    expect(s.get().orders?.bySpaceId?.b).toEqual({ "": ["z", "y"] });
    await archiveSpace(s, "b");
    expect(s.get().orders?.bySpaceId?.b).toEqual({ "": ["z", "y"] });
  });

  it("keeps the members, the exclude list and the root", async () => {
    const s = await loaded();
    const before = s.get().spaces[1];
    await archiveSpace(s, "b");
    const after = s.get().spaces[1];
    expect(after.members).toEqual(before.members);
    expect(after.exclude).toEqual(before.exclude);
    // Spelled out rather than compared to `before` alone: `toEqual` on two
    // `undefined`s is what made this assertion vacuous.
    expect(after.exclude).toEqual(["Projects/Old/skip.md", "Projects/Old/Deep/also.md"]);
    expect(after.root).toBe("Projects");
    expect(after.members.length).toBe(2);
  });

  it("archiving a space that is already archived changes nothing", async () => {
    // What this pins is the second CLICK, not the `!isArchived(s)` guard.
    // Setting the flag twice writes the same document with the guard or
    // without it, so the guard itself is not observable and no test can
    // reach it. The test is kept because the shape a second Archive could
    // plausibly take is a toggle, and against that it fails: Archive on a
    // row that is already archived (a stale render, a double click) must
    // never put the space back on the strip.
    const s = await loaded();
    await archiveSpace(s, "b");
    const once = JSON.stringify(s.get());
    await archiveSpace(s, "b");
    expect(JSON.stringify(s.get())).toBe(once);
    expect(s.get().spaces[1].archived).toBe(true);
  });

  it("archiving an id that does not exist changes nothing", async () => {
    const s = await loaded();
    const before = JSON.stringify(s.get());
    await archiveSpace(s, "nope");
    expect(JSON.stringify(s.get())).toBe(before);
  });
});

describe("restoreSpace", () => {
  it("clears the flag and the space is at the same index", async () => {
    const s = await loaded();
    const before = JSON.stringify(s.get());
    await archiveSpace(s, "b");
    await restoreSpace(s, "b");
    expect(s.get().spaces.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect("archived" in s.get().spaces[1]).toBe(false);
    expect(JSON.stringify(s.get())).toBe(before);
  });

  it("deletes the property from the draft rather than setting it to false", async () => {
    // The store's validator normalizes `archived: false` away on the way
    // through, so the end state cannot tell the two apart. The draft can.
    let draft: SpacesDefinitions | undefined;
    const real = await loaded();
    await archiveSpace(real, "b");
    const spy = {
      mutate: async (fn: (d: SpacesDefinitions) => void) => {
        draft = JSON.parse(JSON.stringify(real.get())) as SpacesDefinitions;
        fn(draft);
      },
    } as unknown as DefinitionStore;
    await restoreSpace(spy, "b");
    expect(draft?.spaces[1]).toBeDefined();
    expect("archived" in (draft as SpacesDefinitions).spaces[1]).toBe(false);
  });
});
