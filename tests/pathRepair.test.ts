import { describe, expect, it } from "vitest";
import { repairOnRename, repairRenameIn } from "../src/lifecycle/pathRepair";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { SCHEMA_VERSION, type SpacesDefinitions } from "../src/types";

function defs(): SpacesDefinitions {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: false, revealVisitors: true, allowReordering: true, allowReorderingAll: true, showSpaceHeader: true, pinAllSpace: false, autoAssignColor: true, showPinnedFolder: false, customColors: [], stripPlacement: "bottom", activeSpaceStyle: "box" },
    spaces: [
      {
        id: "research",
        name: "Research",
        icon: "microscope",
        color: "#4ecdc4",
        root: "Papers",
        members: [
          { path: "Papers", kind: "folder" },
          { path: "Papers/Attention.md", kind: "file" },
          { path: "Papers-old/Legacy.md", kind: "file" },
        ],
      },
    ],
  };
}

describe("repairOnRename", () => {
  it("rewrites an exact match", () => {
    const out = repairOnRename(defs(), "Papers/Attention.md", "Papers/Focus.md");
    const paths = out.spaces[0].members.map((m) => m.path);
    expect(paths).toContain("Papers/Focus.md");
    expect(paths).not.toContain("Papers/Attention.md");
  });

  it("rewrites descendant prefixes when a folder moves", () => {
    const out = repairOnRename(defs(), "Papers", "Research Papers");
    const paths = out.spaces[0].members.map((m) => m.path);
    expect(paths).toContain("Research Papers");
    expect(paths).toContain("Research Papers/Attention.md");
  });

  it("does not rewrite a sibling that shares a string prefix", () => {
    const out = repairOnRename(defs(), "Papers", "Research Papers");
    const paths = out.spaces[0].members.map((m) => m.path);
    expect(paths).toContain("Papers-old/Legacy.md");
  });

  it("rewrites root", () => {
    const out = repairOnRename(defs(), "Papers", "Research Papers");
    expect(out.spaces[0].root).toBe("Research Papers");
  });

  it("deduplicates if a rename collides with an existing member", () => {
    const d = defs();
    d.spaces[0].members.push({ path: "Papers/Focus.md", kind: "file" });
    const out = repairOnRename(d, "Papers/Attention.md", "Papers/Focus.md");
    const focus = out.spaces[0].members.filter((m) => m.path === "Papers/Focus.md");
    expect(focus).toHaveLength(1);
  });

  it("follows a renamed folder-space root", () => {
    // The whole of a folder space's persisted state is this one string, so a
    // rename that does not reach it silently empties the space.
    const before = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [] },
      spaces: [
        { id: "work", name: "Work", icon: "briefcase", color: "#5b5bff",
          root: "Projects/Work", members: [] },
      ],
    } as unknown as SpacesDefinitions;

    const after = repairOnRename(before, "Projects/Work", "Projects/Client Work");

    expect(after.spaces[0].root).toBe("Projects/Client Work");
  });

  it("follows a root when an ancestor folder is renamed", () => {
    const before = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [] },
      spaces: [
        { id: "work", name: "Work", icon: "briefcase", color: "#5b5bff",
          root: "Projects/Work", members: [] },
      ],
    } as unknown as SpacesDefinitions;

    const after = repairOnRename(before, "Projects", "Archive/Projects");

    expect(after.spaces[0].root).toBe("Archive/Projects/Work");
  });
});

describe("orders survive path changes (spec 20.6)", () => {
  function withOrders(): SpacesDefinitions {
    return {
      ...defs(),
      orders: {
        all: {
          "": ["Papers", "Inbox.md"],
          Papers: ["Papers/b.md", "Papers/a.md", "Papers/c.md"],
        },
        bySpaceId: {
          research: { Papers: ["Papers/b.md", "Papers/a.md"] },
        },
      },
    };
  }

  it("rewrites a same-folder rename in place, keeping its position", () => {
    const out = repairOnRename(withOrders(), "Papers/b.md", "Papers/z.md");
    expect(out.orders?.all?.Papers).toEqual(["Papers/z.md", "Papers/a.md", "Papers/c.md"]);
    // and in every space's map, not just All
    expect(out.orders?.bySpaceId?.research?.Papers).toEqual(["Papers/z.md", "Papers/a.md"]);
  });

  it("DROPS the entry on a cross-folder move instead of rewriting it", () => {
    // The space where the drag happened gets a position; every other
    // space drops it and it becomes unlisted in the target, falling to the
    // bottom Synthesising a position in a space the user was not
    // looking at would be inventing intent.
    const out = repairOnRename(withOrders(), "Papers/b.md", "Archive/b.md");
    expect(out.orders?.all?.Papers).toEqual(["Papers/a.md", "Papers/c.md"]);
    expect(out.orders?.all?.Papers).not.toContain("Archive/b.md");
    expect(out.orders?.bySpaceId?.research?.Papers).toEqual(["Papers/a.md"]);
  });

  it("rewrites order map KEYS when a folder is renamed, not just the entries", () => {
    // The map is keyed BY FOLDER PATH, so a folder rename that left the keys
    // alone would orphan every order under it — the folder would silently
    // revert to native sort. This case is why `rewritePrefix` is applied to
    // keys as well as entries.
    const out = repairOnRename(withOrders(), "Papers", "Journals");
    expect(out.orders?.all?.Journals).toEqual([
      "Journals/b.md",
      "Journals/a.md",
      "Journals/c.md",
    ]);
    expect(out.orders?.all?.Papers).toBeUndefined();
    // the folder's own entry in its parent's list is a same-parent rename
    expect(out.orders?.all?.[""]).toEqual(["Journals", "Inbox.md"]);
  });

  it("on a folder MOVE, rewrites keys and drops the folder from its parent's list", () => {
    const out = repairOnRename(withOrders(), "Papers", "Archive/Papers");
    expect(out.orders?.all?.["Archive/Papers"]).toEqual([
      "Archive/Papers/b.md",
      "Archive/Papers/a.md",
      "Archive/Papers/c.md",
    ]);
    expect(out.orders?.all?.[""]).toEqual(["Inbox.md"]);
  });

  it("removes the root key entirely if the move empties it", () => {
    const d: SpacesDefinitions = { ...defs(), orders: { all: { "": ["Papers"] } } };
    const out = repairOnRename(d, "Papers", "Archive/Papers");
    expect(out.orders?.all?.[""]).toBeUndefined();
  });

  it("does nothing when there are no orders at all", () => {
    const out = repairOnRename(defs(), "Papers/b.md", "Papers/z.md");
    expect(out.orders).toBeUndefined();
  });

  it("does not mutate the input definitions", () => {
    const d = withOrders();
    repairOnRename(d, "Papers", "Journals");
    expect(d.orders?.all?.Papers).toEqual(["Papers/b.md", "Papers/a.md", "Papers/c.md"]);
  });
});

describe("prototype-shaped keys survive a rename", () => {
  // `schema.ts` builds every order map with a null prototype and explains at
  // length why: a folder literally named `__proto__` would otherwise set the
  // object's prototype instead of storing an entry, and the order would vanish.
  // The rename repair rebuilt those maps with `{}` and lost the hardening.
  it("keeps an order stored under a __proto__ folder name", () => {
    const d: SpacesDefinitions = {
      ...defs(),
      // A COMPUTED key. `{ __proto__: ... }` in an object literal is special
      // syntax that sets the prototype instead of creating the property, which
      // is the same trap the production code had to avoid.
      orders: { all: { ["__proto__"]: ["a.md", "b.md"] } as unknown as Record<string, string[]> },
    };
    const out = repairOnRename(d, "a.md", "c.md");
    const all = out.orders?.all as Record<string, string[]> | undefined;
    expect(Object.getPrototypeOf(all)).toBeNull();
    expect(Object.keys(all ?? {})).toContain("__proto__");
  });
});

describe("order map key collisions (whole-slice review, Important 1)", () => {
  it("lets the RENAMED folder's order win over a stale key of the same name", () => {
    // Orders are deliberately left in place on delete, so a key can
    // outlive its folder. Rename another folder onto that name and two keys
    // collide. Before the fix, whichever came first in `Object.entries` won —
    // a coin flip decided whose arrangement survived.
    const d: SpacesDefinitions = {
      ...defs(),
      orders: {
        all: {
          Journals: ["Journals/stale.md"],
          Papers: ["Papers/b.md", "Papers/a.md"],
        },
      },
    };
    const out = repairOnRename(d, "Papers", "Journals");
    expect(out.orders?.all?.Journals).toEqual(["Journals/b.md", "Journals/a.md"]);
  });

  it("wins the same way regardless of which key is declared first", () => {
    const d: SpacesDefinitions = {
      ...defs(),
      orders: {
        all: {
          Papers: ["Papers/b.md", "Papers/a.md"],
          Journals: ["Journals/stale.md"],
        },
      },
    };
    const out = repairOnRename(d, "Papers", "Journals");
    expect(out.orders?.all?.Journals).toEqual(["Journals/b.md", "Journals/a.md"]);
  });
});

describe("repairRenameIn — repairs computed from the DRAFT, not from a snapshot", () => {
  // R1, mainline review 2026-09-08. Both rename call sites used to read
  // `defs.get()` OUTSIDE `mutate`'s queue, compute a whole repaired document
  // from that snapshot, and `Object.assign` it over the draft inside. The
  // draft is cloned fresh when the queued callback runs, so anything that
  // landed in between — another rename's repair, a membership add, a settings
  // toggle — was overwritten by a document that predated it.
  //
  // These drive the REAL store, so they exercise what production calls rather
  // than restating the pattern in the test.

  function backing(initial: unknown) {
    let data = initial;
    return {
      read: async () => data,
      write: async (d: unknown) => {
        data = d;
      },
    };
  }

  const twoMembers = {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: false },
    spaces: [
      {
        id: "s",
        name: "S",
        icon: "box",
        color: "#112233",
        members: [
          { path: "a.md", kind: "file" as const },
          { path: "b.md", kind: "file" as const },
        ],
      },
    ],
  };

  const membersOf = (store: DefinitionStore) =>
    store.get().spaces[0].members.map((m) => m.path);

  it("keeps BOTH repairs when two renames overlap", async () => {
    // The exact case the review reproduced: repairing a.md and b.md at the
    // same time used to persist a.md and B.md, leaving the first membership
    // pointing at a path with no file.
    const store = new DefinitionStore(backing(twoMembers));
    await store.load();

    await Promise.all([
      store.mutate((d) => repairRenameIn(d, "a.md", "A.md")),
      store.mutate((d) => repairRenameIn(d, "b.md", "B.md")),
    ]);

    expect(membersOf(store).sort()).toEqual(["A.md", "B.md"]);
  });

  it("does not overwrite a membership added while the rename was queued", async () => {
    // The second regression the review asked for. A repair that carried a
    // whole stale document would drop `c.md` entirely.
    const store = new DefinitionStore(backing(twoMembers));
    await store.load();

    // The membership add is enqueued FIRST, so the repair runs second and
    // would overwrite it if the repair carried a whole document computed
    // before the queue. Ordered deliberately: with the repair first there is
    // nothing yet to clobber and the test cannot fail.
    await Promise.all([
      store.mutate((d) => {
        d.spaces[0].members.push({ path: "c.md", kind: "file" });
      }),
      store.mutate((d) => repairRenameIn(d, "a.md", "A.md")),
    ]);

    expect(membersOf(store).sort()).toEqual(["A.md", "b.md", "c.md"]);
  });

  it("does not overwrite a settings change made while the rename was queued", async () => {
    // Same hazard, different victim: `Object.assign` of a whole snapshot
    // replaces `settings` too, not only `spaces`.
    const store = new DefinitionStore(backing(twoMembers));
    await store.load();

    // Settings change first, repair second — the losing order, for the same
    // reason as the test above.
    await Promise.all([
      store.mutate((d) => {
        d.settings.globalIgnore.push("Archive/**");
      }),
      store.mutate((d) => repairRenameIn(d, "a.md", "A.md")),
    ]);

    expect(membersOf(store)).toContain("A.md");
    expect(store.get().settings.globalIgnore).toEqual(["Archive/**"]);
  });

  it("leaves the draft untouched when the rename touches nothing stored", async () => {
    const store = new DefinitionStore(backing(twoMembers));
    await store.load();
    await store.mutate((d) => repairRenameIn(d, "unrelated.md", "moved.md"));
    expect(membersOf(store)).toEqual(["a.md", "b.md"]);
  });
});
