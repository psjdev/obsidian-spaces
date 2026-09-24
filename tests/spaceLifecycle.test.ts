import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPACE_COLOR,
  PALETTE,
  createSpace,
  deleteSpace,
  nextPaletteColor,
  renameSpace,
  setSpaceIcon,
  setSpaceRoot,
  startingSpaceColor,
} from "../src/actions/spaceLifecycle";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { SCHEMA_VERSION } from "../src/types";

function store(): DefinitionStore {
  let stored: unknown = {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: true, revealVisitors: true },
    spaces: [],
  };
  return new DefinitionStore({
    read: async () => stored,
    write: async (d) => { stored = d; },
  });
}

describe("PALETTE", () => {
  it("is exported, because the create panel's color row needs it", () => {
    // Tasks 4 and 5 read it directly. Duplicating the values in a second file
    // would drift the moment either changed.
    expect(PALETTE.length).toBeGreaterThan(0);
    expect(PALETTE.every((c) => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
  });
});

describe("nextPaletteColor", () => {
  // PALETTE[0] is the neutral swatch — Obsidian's own icon grey, offered so a
  // user can opt OUT of a color. Auto-assignment must never hand it out: the
  // rotation exists so consecutive spaces are told apart at a glance, and one
  // turn in six silently arriving grey defeats that. It rotates the vivid
  // colors only, keeping their order and starting point — though not a fixed
  // sequence across palette edits, since the palette's length is what the
  // rotation is taken modulo.
  it("never assigns the neutral swatch", () => {
    for (let i = 0; i < PALETTE.length * 3; i++) {
      expect(nextPaletteColor(i)).not.toBe(PALETTE[0]);
    }
  });

  it("starts at the first vivid color", () => {
    expect(nextPaletteColor(0)).toBe(PALETTE[1]);
  });

  it("cycles every vivid color before repeating", () => {
    const vivid = PALETTE.slice(1);
    const seen = vivid.map((_, i) => nextPaletteColor(i));
    expect(seen).toEqual(vivid);
  });

  it("wraps after the last vivid color", () => {
    const vivid = PALETTE.slice(1);
    expect(nextPaletteColor(vivid.length)).toBe(vivid[0]);
    expect(nextPaletteColor(vivid.length + 1)).toBe(vivid[1]);
  });

  it("matches createSpace's default color rotation across sequential creates", async () => {
    const s = store();
    await s.load();

    // Create first space with no options (uses default color).
    const id1 = await createSpace(s, "First");
    const space1 = s.get().spaces.find((x) => x.id === id1)!;

    // Its color should match nextPaletteColor(0) — the first space, index 0.
    expect(space1.color).toBe(nextPaletteColor(0));

    // Create second space with no options.
    const id2 = await createSpace(s, "Second");
    const space2 = s.get().spaces.find((x) => x.id === id2)!;

    // Its color should match nextPaletteColor(1) — the second space, index 1.
    expect(space2.color).toBe(nextPaletteColor(1));

    // And they should differ (assuming PALETTE.length > 1).
    expect(space1.color).not.toBe(space2.color);
  });
});

describe("createSpace", () => {
  it("still works with no options, keeping today's defaults", async () => {
    const s = store();
    await s.load();
    const id = await createSpace(s, "Research");
    const sp = s.get().spaces.find((x) => x.id === id)!;
    expect(sp.name).toBe("Research");
    expect(sp.icon).toBe("box");
    expect(sp.members).toEqual([]);
    expect(sp.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("takes an icon and a color", async () => {
    const s = store();
    await s.load();
    const id = await createSpace(s, "Research", { icon: "microscope", color: "#4ecdc4" });
    const sp = s.get().spaces.find((x) => x.id === id)!;
    expect(sp.icon).toBe("microscope");
    expect(sp.color).toBe("#4ecdc4");
  });

  it("seeds members, which is the whole point (C8)", async () => {
    const s = store();
    await s.load();
    const id = await createSpace(s, "Research", {
      members: [
        { path: "Papers", kind: "folder" },
        { path: "Notes/Ideas.md", kind: "file" },
      ],
    });
    const sp = s.get().spaces.find((x) => x.id === id)!;
    expect(sp.members).toEqual([
      { path: "Papers", kind: "folder" },
      { path: "Notes/Ideas.md", kind: "file" },
    ]);
  });

  it("normalizes a member path with a leading slash", async () => {
    const s = store();
    await s.load();
    const id = await createSpace(s, "Research", {
      members: [{ path: "/Projects/Console 2030", kind: "folder" }],
    });
    const sp = s.get().spaces.find((x) => x.id === id)!;
    expect(sp.members).toEqual([{ path: "Projects/Console 2030", kind: "folder" }]);
  });

  it("normalizes a member path with a doubled separator", async () => {
    const s = store();
    await s.load();
    const id = await createSpace(s, "Research", {
      members: [{ path: "Projects//Console 2030", kind: "folder" }],
    });
    const sp = s.get().spaces.find((x) => x.id === id)!;
    expect(sp.members).toEqual([{ path: "Projects/Console 2030", kind: "folder" }]);
  });

  it("passes an already-canonical member path through byte-identical", async () => {
    const s = store();
    await s.load();
    const id = await createSpace(s, "Research", {
      members: [{ path: "Projects/Console 2030", kind: "folder" }],
    });
    const sp = s.get().spaces.find((x) => x.id === id)!;
    expect(sp.members).toEqual([{ path: "Projects/Console 2030", kind: "folder" }]);
  });

  it("still de-duplicates ids when two spaces share a name", async () => {
    const s = store();
    await s.load();
    const a = await createSpace(s, "Research");
    const b = await createSpace(s, "Research", { icon: "box" });
    expect(a).toBe("research");
    expect(b).toBe("research-2");
  });

  it("does not share the caller's member array with the stored space", async () => {
    // WHAT THIS TEST PINS: a stored space's members never alias the caller's
    // objects at entry level. Caller mutations (push, property changes) do not
    // alter the stored space. This is real and worth asserting.
    //
    // WHAT THIS TEST DOES NOT PIN: whether createSpace's .map() is the source
    // of this guarantee. A shallow copy `[...(opts?.members ?? [])]` passes this
    // test unchanged.
    //
    // WHY: validateMembers() in src/definitions/schema.ts:37 rebuilds every
    // entry with `out.push({ path, kind })` on every defs.mutate(). This
    // reconstruction guarantees the property independently of what createSpace
    // passed in.
    //
    // CONSEQUENCE: if validation is ever changed to pass entries through
    // instead of rebuilding them, this protection vanishes with no test going
    // red.
    const s = store();
    await s.load();
    const mine = [{ path: "Papers", kind: "folder" as const }];
    const id = await createSpace(s, "Research", { members: mine });
    // Mutate the outer array (proves outer array is copied, not adopted).
    mine.push({ path: "Sneaky", kind: "folder" });
    // Mutate an existing entry (proves entries don't alias caller's objects).
    mine[0].path = "Sneaky";
    const stored = s.get().spaces.find((x) => x.id === id)!.members;
    expect(stored).toHaveLength(1);
    expect(stored[0].path).toBe("Papers");
  });
});

describe("deleteSpace clears that space's order map", () => {
  function storeWithOrders(): DefinitionStore {
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        globalIgnore: [],
        restoreLayouts: true,
        revealVisitors: true,
        allowReordering: true,
      },
      spaces: [
        { id: "keep", name: "Keep", icon: "box", color: "#5b5bff", members: [] },
        { id: "drop", name: "Drop", icon: "box", color: "#4ecdc4", members: [] },
      ],
      orders: {
        all: { Papers: ["Papers/a.md"] },
        bySpaceId: {
          keep: { Papers: ["Papers/a.md"] },
          drop: { Papers: ["Papers/b.md"] },
        },
      },
    };
    return new DefinitionStore({
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    });
  }

  it("removes the deleted space's map and leaves the others", async () => {
    // This is the price of keeping `orders` top-level rather than nested in
    // SpaceDefinition: nothing else clears it, and createSpace can mint the
    // same id again, which would silently re-attach a stale order.
    const defs = storeWithOrders();
    await defs.load();
    await deleteSpace(defs, "drop");
    const d = defs.get();
    expect(d.orders?.bySpaceId?.drop).toBeUndefined();
    expect(d.orders?.bySpaceId?.keep).toEqual({ Papers: ["Papers/a.md"] });
    expect(d.orders?.all).toEqual({ Papers: ["Papers/a.md"] });
  });

  it("drops the whole orders key when nothing is left in it", async () => {
    const defs = storeWithOrders();
    await defs.load();
    await defs.mutate((d) => {
      delete d.orders?.all;
      if (d.orders?.bySpaceId) delete d.orders.bySpaceId.keep;
    });
    await deleteSpace(defs, "drop");
    expect(defs.get().orders).toBeUndefined();
  });

  it("is a no-op for a space that has no order map", async () => {
    const defs = storeWithOrders();
    await defs.load();
    await deleteSpace(defs, "keep");
    expect(defs.get().orders?.bySpaceId?.drop).toEqual({ Papers: ["Papers/b.md"] });
  });
});

describe("setSpaceIcon (spec 9.7)", () => {
  async function twoSpaces(): Promise<DefinitionStore> {
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        globalIgnore: [],
        restoreLayouts: true,
        revealVisitors: true,
        allowReordering: true,
      },
      spaces: [
        { id: "a", name: "A", icon: "box", color: "#5b5bff", members: [] },
        { id: "b", name: "B", icon: "book", color: "#4ecdc4", members: [] },
      ],
    };
    const defs = new DefinitionStore({
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    });
    await defs.load();
    return defs;
  }

  it("changes only the named space", async () => {
    const defs = await twoSpaces();
    await setSpaceIcon(defs, "a", "microscope");
    const spaces = defs.get().spaces;
    expect(spaces.find((s) => s.id === "a")?.icon).toBe("microscope");
    expect(spaces.find((s) => s.id === "b")?.icon).toBe("book");
  });

  it("accepts any well-formed id, not just the presets", async () => {
    // The picker searches every icon Obsidian ships (~1500), so a whitelist
    // would have to BE that list and would go stale the moment Obsidian added
    // one. Shape is what this guards.
    const defs = await twoSpaces();
    await setSpaceIcon(defs, "a", "flask-conical");
    expect(defs.get().spaces.find((s) => s.id === "a")?.icon).toBe("flask-conical");
  });

  it("rejects a malformed id rather than writing it", async () => {
    // `validateSpace` accepts any string up to 64 chars, so without this a
    // stray value persists happily.
    const defs = await twoSpaces();
    for (const bad of ["Not An Icon", "UPPER", "has space", "trailing-", "x".repeat(70)]) {
      await expect(setSpaceIcon(defs, "a", bad)).rejects.toThrow();
    }
    expect(defs.get().spaces.find((s) => s.id === "a")?.icon).toBe("box");
  });

  it("is a no-op for an unknown space id", async () => {
    const defs = await twoSpaces();
    await setSpaceIcon(defs, "nope", "microscope");
    expect(defs.get().spaces.map((s) => s.icon)).toEqual(["box", "book"]);
  });

  it("leaves every other field of the space alone", async () => {
    const defs = await twoSpaces();
    await setSpaceIcon(defs, "b", "target");
    const b = defs.get().spaces.find((s) => s.id === "b");
    expect(b).toMatchObject({ id: "b", name: "B", color: "#4ecdc4", icon: "target" });
  });
});

describe("renameSpace (9.9)", () => {
  async function withSpace(): Promise<{ defs: DefinitionStore; id: string }> {
    const defs = store();
    await defs.load();
    const id = await createSpace(defs, "Work");
    return { defs, id };
  }

  const nameOf = (defs: DefinitionStore, id: string): string =>
    defs.get().spaces.find((s) => s.id === id)?.name ?? "";

  it("renames, trimming what the field gave it", async () => {
    const { defs, id } = await withSpace();
    await renameSpace(defs, id, "  Deep Work  ");
    expect(nameOf(defs, id)).toBe("Deep Work");
  });

  it("keeps the old name when the field is emptied — a cancel, not an error", async () => {
    // Commits happen on blur as well as Enter, so a click elsewhere with an
    // empty field must not be able to destroy a name.
    const { defs, id } = await withSpace();
    await renameSpace(defs, id, "   ");
    expect(nameOf(defs, id)).toBe("Work");
  });

  it("refuses an over-length name and leaves the space untouched", async () => {
    // Pinned at this layer on purpose. `mutate` clones, applies, validates and
    // assigns only on success, so the rejection costs nothing — that atomicity
    // is the whole protection, and `renameSpace` deliberately adds no guard of
    // its own behind it (9.9). Weaken `mutate` to assign before validating and
    // this test goes red.
    const { defs, id } = await withSpace();
    await expect(renameSpace(defs, id, "x".repeat(101))).rejects.toThrow();
    expect(nameOf(defs, id)).toBe("Work");
  });

  it("accepts a name exactly at the limit", async () => {
    const { defs, id } = await withSpace();
    const at = "x".repeat(100);
    await renameSpace(defs, id, at);
    expect(nameOf(defs, id)).toBe(at);
  });

  it("leaves other spaces alone", async () => {
    const { defs, id } = await withSpace();
    const other = await createSpace(defs, "Lab");
    await renameSpace(defs, id, "Deep Work");
    expect(nameOf(defs, other)).toBe("Lab");
  });

  it("is a no-op for an id that does not exist", async () => {
    const { defs, id } = await withSpace();
    await renameSpace(defs, "ghost", "Whatever");
    expect(nameOf(defs, id)).toBe("Work");
  });
});

describe("setSpaceRoot — the 'Change folder…' write path", () => {
  async function threeSpaces(): Promise<DefinitionStore> {
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: true, revealVisitors: true },
      spaces: [
        { id: "a", name: "A", icon: "briefcase", color: "#5b5bff", root: "Projects/Gone", members: [] },
        { id: "b", name: "B", icon: "briefcase", color: "#ff5b5b", root: "Projects/Work", members: [] },
        {
          id: "c",
          name: "C",
          icon: "folder",
          color: "#4ecdc4",
          members: [{ path: "Papers", kind: "folder" as const }],
        },
      ],
    };
    const defs = new DefinitionStore({
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    });
    await defs.load();
    return defs;
  }

  it("changes only the named space's root", async () => {
    const defs = await threeSpaces();
    await setSpaceRoot(defs, "a", "Projects/New Home");
    const spaces = defs.get().spaces;
    expect(spaces.find((s) => s.id === "a")?.root).toBe("Projects/New Home");
    expect(spaces.find((s) => s.id === "b")?.root).toBe("Projects/Work");
  });

  it("normalizes the path exactly like createSpace does for opts.root", async () => {
    const defs = await threeSpaces();
    await setSpaceRoot(defs, "a", "/Projects//New  Home/");
    // Same normalization as member paths: collapsed separators, trimmed
    // leading/trailing slashes. (Internal whitespace is untouched — that is
    // not part of what normalizeMemberPath does, only separators are.)
    expect(defs.get().spaces.find((s) => s.id === "a")?.root).toBe("Projects/New  Home");
  });

  it('an empty string is STORED, not deleted — the space stays a folder space', () => {
    return (async () => {
      const defs = await threeSpaces();
      await setSpaceRoot(defs, "a", "");
      const a = defs.get().spaces.find((s) => s.id === "a");
      expect(a).toBeDefined();
      expect(a?.root).toBe("");
      // Not merely `undefined` by coincidence — the field itself must still
      // be present, or this space silently reads as curated (isFolderSpace
      // keys off the field's PRESENCE, not its value).
      expect(Object.prototype.hasOwnProperty.call(a, "root")).toBe(true);
    })();
  });

  it("is a no-op for an unknown space id", async () => {
    const defs = await threeSpaces();
    await setSpaceRoot(defs, "nope", "Projects/New Home");
    expect(defs.get().spaces.map((s) => s.root)).toEqual([
      "Projects/Gone",
      "Projects/Work",
      undefined,
    ]);
  });

  it("is a no-op for a curated space — it has no root key to change", async () => {
    const defs = await threeSpaces();
    await setSpaceRoot(defs, "c", "Projects/New Home");
    const c = defs.get().spaces.find((s) => s.id === "c");
    expect(c?.root).toBeUndefined();
    expect(c?.members).toEqual([{ path: "Papers", kind: "folder" }]);
  });

  it("leaves every other field of the space alone", async () => {
    const defs = await threeSpaces();
    await setSpaceRoot(defs, "b", "Projects/Console 2030");
    const b = defs.get().spaces.find((s) => s.id === "b");
    expect(b).toMatchObject({
      id: "b",
      name: "B",
      icon: "briefcase",
      color: "#ff5b5b",
      root: "Projects/Console 2030",
    });
  });
});

describe("startingSpaceColor", () => {
  /**
   * The whole of the preference's behaviour, in one pure function.
   *
   * It lives here rather than in the toggle because `SettingsTab.display()`
   * cannot be driven under the stub, so the rule is testable and the
   * untestable part is reduced to reading a boolean and passing it on.
   */
  it("hands out the rotation when auto-assignment is on", () => {
    // Identical to what the rotation would have given on its own, so turning
    // the setting on is exactly "the behaviour as it was", not a second
    // sequence that merely resembles it.
    for (let n = 0; n < PALETTE.length * 3; n++) {
      expect(startingSpaceColor(true, n)).toBe(nextPaletteColor(n));
    }
  });

  it("hands out the neutral swatch when it is off", () => {
    for (let n = 0; n < PALETTE.length * 3; n++) {
      expect(startingSpaceColor(false, n)).toBe(DEFAULT_SPACE_COLOR);
    }
  });

  it("never returns a rotation color when off", () => {
    // The two modes must not overlap: "off" means the popover opens on the
    // first swatch, which only holds if nothing else can be handed out.
    const vivid = PALETTE.slice(1);
    for (let n = 0; n < 20; n++) expect(vivid).not.toContain(startingSpaceColor(false, n));
  });

  it("ignores the space count when off", () => {
    // No hidden dependence on how many spaces exist — the neutral default must
    // not drift as the vault fills up.
    expect(startingSpaceColor(false, 0)).toBe(startingSpaceColor(false, 999));
  });
});
