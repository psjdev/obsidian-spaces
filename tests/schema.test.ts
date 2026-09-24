import { describe, expect, it } from "vitest";
import { validateDefinitions } from "../src/definitions/schema";
import { DEFAULT_DEFINITIONS, SCHEMA_VERSION } from "../src/types";

const valid = {
  schemaVersion: SCHEMA_VERSION,
  settings: { globalIgnore: ["Templates/**"], restoreLayouts: false },
  spaces: [
    {
      id: "research",
      name: "Research",
      icon: "microscope",
      color: "#4ecdc4",
      home: "Papers",
      members: [{ path: "Papers", kind: "folder" }],
    },
  ],
};

describe("validateDefinitions", () => {
  it("accepts a well-formed document", () => {
    const r = validateDefinitions(valid);
    expect(r.ok).toBe(true);
  });

  it("rejects a schemaVersion above the supported maximum without loading it", () => {
    const r = validateDefinitions({ ...valid, schemaVersion: SCHEMA_VERSION + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.futureSchema).toBe(true);
  });

  it("rejects absolute paths and traversal", () => {
    for (const bad of ["/etc/passwd", "../outside.md", "C:\\win.md"]) {
      const r = validateDefinitions({
        ...valid,
        spaces: [{ ...valid.spaces[0], members: [{ path: bad, kind: "file" }] }],
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects duplicate space ids", () => {
    const r = validateDefinitions({
      ...valid,
      spaces: [valid.spaces[0], valid.spaces[0]],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed color", () => {
    const r = validateDefinitions({
      ...valid,
      spaces: [{ ...valid.spaces[0], color: "red; background: url(x)" }],
    });
    expect(r.ok).toBe(false);
  });

  it("deduplicates member entries", () => {
    const r = validateDefinitions({
      ...valid,
      spaces: [
        {
          ...valid.spaces[0],
          members: [
            { path: "Papers", kind: "folder" },
            { path: "Papers", kind: "folder" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.spaces[0].members).toHaveLength(1);
  });

  it("rejects a non-object", () => {
    expect(validateDefinitions(null).ok).toBe(false);
    expect(validateDefinitions("nope").ok).toBe(false);
  });

  it("ships with restoreLayouts off, and the loader agrees", () => {
    // Two independent sites decide this: DEFAULT_DEFINITIONS for a fresh
    // install, and the loader's coercion for a document where the key is
    // absent. If they disagree, a fresh install and a hand-trimmed data.json
    // behave differently, which is invisible until someone hits it.
    expect(DEFAULT_DEFINITIONS.settings.restoreLayouts).toBe(false);
    const { restoreLayouts: _omit, ...noFlag } = valid.settings;
    const loaded = validateDefinitions({ ...valid, settings: noFlag });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.settings.restoreLayouts).toBe(
        DEFAULT_DEFINITIONS.settings.restoreLayouts
      );
    }
  });

  it("defaults restoreLayouts to false when the key is missing", () => {
    // Restoring tabs rearranges the workspace on every switch, so it is opted
    // into. A document with the key absent must not inherit it.
    const { restoreLayouts: _drop, ...settingsWithoutFlag } = valid.settings;
    const r = validateDefinitions({ ...valid, settings: settingsWithoutFlag });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.settings.restoreLayouts).toBe(false);
  });

  it("keeps an explicit false", () => {
    const r = validateDefinitions(valid); // valid.settings.restoreLayouts is false
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.settings.restoreLayouts).toBe(false);
  });

  it("keeps an explicit true, which a missing key no longer implies", () => {
    const r = validateDefinitions({
      ...valid,
      settings: { ...valid.settings, restoreLayouts: true },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.settings.restoreLayouts).toBe(true);
  });

  it("defaults revealVisitors to true when the key is missing", () => {
    const out = validateDefinitions({ schemaVersion: 1, settings: {}, spaces: [] });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.settings.revealVisitors).toBe(true);
  });

  it("keeps an explicit revealVisitors false", () => {
    const out = validateDefinitions({
      schemaVersion: 1,
      settings: { revealVisitors: false },
      spaces: [],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.settings.revealVisitors).toBe(false);
  });

  it("keeps an explicit revealVisitors true", () => {
    const out = validateDefinitions({
      schemaVersion: 1,
      settings: { revealVisitors: true },
      spaces: [],
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.settings.revealVisitors).toBe(true);
  });

  it("coerces a non-boolean revealVisitors to the default rather than trusting it", () => {
    // A hand-edited data.json can carry anything. 0 and "no" both read as
    // "off" to a human, so neither may resolve to true.
    for (const bad of [0, "no", null, [], {}]) {
      const out = validateDefinitions({
        schemaVersion: 1,
        settings: { revealVisitors: bad },
        spaces: [],
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.value.settings.revealVisitors).toBe(false);
    }
  });
});

describe("validateOrders (spec 20.3)", () => {
  function ordersOf(raw: unknown) {
    const r = validateDefinitions({ ...valid, orders: raw });
    if (!r.ok) throw new Error("expected the document to remain valid: " + r.error);
    return r.value.orders;
  }

  it("never refuses a document over a bad order — it drops it", () => {
    // An unusable order must not cost the user their spaces. This is the whole
    // reason validateOrders returns undefined instead of a ValidationResult.
    for (const bad of [null, 42, "nope", [], true]) {
      expect(ordersOf(bad)).toBeUndefined();
    }
  });

  it("keeps a well-formed map for All and per space", () => {
    expect(
      ordersOf({ all: { Papers: ["Papers/b.md", "Papers/a.md"] }, bySpaceId: { research: { "": ["Papers"] } } })
    ).toEqual({ all: { Papers: ["Papers/b.md", "Papers/a.md"] }, bySpaceId: { research: { "": ["Papers"] } } });
  });

  it("accepts the empty-string root key, which isSafeVaultPath rejects", () => {
    // Storage uses "" for the vault root because Obsidian's own root path is
    // "/", which the path guard also rejects. If this regresses, root-level
    // ordering silently stops persisting.
    expect(ordersOf({ all: { "": ["Inbox.md"] } })).toEqual({ all: { "": ["Inbox.md"] } });
  });

  it("drops a non-array value instead of trusting it", () => {
    expect(ordersOf({ all: { Papers: "not-an-array" } })).toBeUndefined();
  });

  it("filters non-string and unsafe entries out of a list", () => {
    expect(ordersOf({ all: { Papers: ["Papers/a.md", 7, null, "../escape", "/abs"] } })).toEqual({
      all: { Papers: ["Papers/a.md"] },
    });
  });

  it("de-duplicates within a list, first occurrence winning", () => {
    // A path listed twice would make applyOrder emit the row twice.
    expect(ordersOf({ all: { Papers: ["b.md", "a.md", "b.md"] } })).toEqual({
      all: { Papers: ["b.md", "a.md"] },
    });
  });

  it("drops empty lists so dead keys cannot accumulate", () => {
    expect(ordersOf({ all: { Papers: [], Other: ["a.md"] } })).toEqual({
      all: { Other: ["a.md"] },
    });
  });

  it("drops an unsafe folder key", () => {
    expect(ordersOf({ all: { "../evil": ["a.md"] } })).toBeUndefined();
  });

  it("omits the key entirely when nothing survives, rather than storing an empty shell", () => {
    const r = validateDefinitions({ ...valid, orders: { all: {} } });
    if (!r.ok) throw new Error(r.error);
    expect("orders" in r.value).toBe(false);
  });
});

describe("allowReordering (spec 20.7)", () => {
  function settingsOf(raw: Record<string, unknown>) {
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, ...raw } });
    if (!r.ok) throw new Error(r.error);
    return r.value.settings;
  }

  it("defaults to true when absent", () => {
    expect(settingsOf({}).allowReordering).toBe(true);
  });

  it("is kept when explicitly false", () => {
    expect(settingsOf({ allowReordering: false }).allowReordering).toBe(false);
  });

  it("does not trust a present non-boolean", () => {
    // Strict, matching revealVisitors directly above it in the guard:
    // `allowReordering: 0` must not read as true.
    expect(settingsOf({ allowReordering: 0 }).allowReordering).toBe(false);
    expect(settingsOf({ allowReordering: "yes" }).allowReordering).toBe(false);
  });
});

describe("showSpaceHeader (spec 21.5)", () => {
  // Local, matching the neighbouring block: `valid.settings` is the baseline
  // and each case overrides one key on it.
  function settingsOf(raw: Record<string, unknown>) {
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, ...raw } });
    if (!r.ok) throw new Error(r.error);
    return r.value.settings;
  }

  it("defaults to true for a document written before it existed", () => {
    // On by default: the header is the orientation cue, and a feature
    // defaulted off is a feature nobody finds.
    expect(settingsOf({}).showSpaceHeader).toBe(true);
  });

  it("keeps an explicit false", () => {
    expect(settingsOf({ showSpaceHeader: false }).showSpaceHeader).toBe(false);
  });

  it("does not trust a present non-boolean", () => {
    // Strict, like `revealVisitors` and `allowReordering`: `showSpaceHeader: 0`
    // must not read as true the way a `!== false` check would make it.
    expect(settingsOf({ showSpaceHeader: 0 }).showSpaceHeader).toBe(false);
    expect(settingsOf({ showSpaceHeader: "yes" }).showSpaceHeader).toBe(false);
  });
});

describe("pinAllSpace (spec 9.10)", () => {
  function settingsOf(raw: Record<string, unknown>) {
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, ...raw } });
    if (!r.ok) throw new Error(r.error);
    return r.value.settings;
  }

  it("defaults to FALSE for a document written before it existed", () => {
    // Unlike its neighbours. This one changes the look of the strip, and a
    // setting that rearranges the UI of every existing install on update reads
    // as a bug rather than a feature. Opt-in.
    expect(settingsOf({}).pinAllSpace).toBe(false);
  });

  it("keeps an explicit true", () => {
    expect(settingsOf({ pinAllSpace: true }).pinAllSpace).toBe(true);
  });

  it("does not trust a present non-boolean", () => {
    expect(settingsOf({ pinAllSpace: 1 }).pinAllSpace).toBe(false);
    expect(settingsOf({ pinAllSpace: "yes" }).pinAllSpace).toBe(false);
  });
});

describe("allowReorderingAll (spec 20.7)", () => {
  function settingsOf(raw: Record<string, unknown>) {
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, ...raw } });
    if (!r.ok) throw new Error(r.error);
    return r.value.settings;
  }

  it("defaults to true for a document written before it existed", () => {
    // On by default, so All behaves like a space until told otherwise.
    expect(settingsOf({}).allowReorderingAll).toBe(true);
  });

  it("keeps an explicit false", () => {
    expect(settingsOf({ allowReorderingAll: false }).allowReorderingAll).toBe(false);
  });

  it("does not trust a present non-boolean", () => {
    expect(settingsOf({ allowReorderingAll: 0 }).allowReorderingAll).toBe(false);
    expect(settingsOf({ allowReorderingAll: "yes" }).allowReorderingAll).toBe(false);
  });

  it("is independent of the global allowReordering", () => {
    // The two are stored separately; the narrowing happens at read time in
    // `orderingEnabledFor`, not by one key rewriting the other.
    const s = settingsOf({ allowReordering: false, allowReorderingAll: true });
    expect(s).toMatchObject({ allowReordering: false, allowReorderingAll: true });
  });
});

describe("prototype-polluting ids and keys", () => {
  it("rejects a space id that names a prototype slot", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      const r = validateDefinitions({ ...valid, spaces: [{ ...valid.spaces[0], id }] });
      expect(r.ok).toBe(false);
    }
  });

  it("still accepts ordinary ids that merely contain those words", () => {
    for (const id of ["my__proto__space", "constructors", "prototype-2"]) {
      const r = validateDefinitions({ ...valid, spaces: [{ ...valid.spaces[0], id }] });
      expect(r.ok).toBe(true);
    }
  });

  it("builds bySpaceId and each order map with a null prototype", () => {
    const r = validateDefinitions({
      ...valid,
      orders: { all: { "": ["a.md"] }, bySpaceId: { research: { Papers: ["Papers/x.md"] } } },
    });
    if (!r.ok) throw new Error(r.error);
    const orders = r.value.orders;
    expect(Object.getPrototypeOf(orders?.bySpaceId)).toBeNull();
    expect(Object.getPrototypeOf(orders?.all)).toBeNull();
    expect(Object.getPrototypeOf(orders?.bySpaceId?.["research"])).toBeNull();
  });

  it("keeps a hostile id from an older document as an OWN property, not a prototype write", () => {
    // JSON.parse, not an object literal: `{ __proto__: x }` in source sets the
    // prototype, whereas a parsed document carries it as an OWN property —
    // which is exactly the shape an older data.json arrives in.
    const orders = JSON.parse('{"bySpaceId":{"__proto__":{"Notes":["Notes/x.md"]}}}');
    const r = validateDefinitions({ ...valid, orders });
    if (!r.ok) throw new Error(r.error);
    // Nothing leaked onto the shared prototype, and the entry survives as a
    // real own property rather than silently becoming bySpaceId's prototype.
    expect(({} as Record<string, unknown>)["Notes"]).toBeUndefined();
    const by = r.value.orders?.bySpaceId ?? {};
    expect(Object.prototype.hasOwnProperty.call(by, "__proto__")).toBe(true);
    delete (Object.prototype as unknown as Record<string, unknown>)["Notes"];
  });
});

describe("folder spaces — the root field", () => {
  const base = { id: "work", name: "Work", icon: "briefcase", color: "#5b5bff" };

  it("accepts a space with a root and no members", () => {
    const d = validateDefinitions({
      schemaVersion: SCHEMA_VERSION,
      settings: {},
      spaces: [{ ...base, root: "Projects/Work", members: [] }],
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.value.spaces[0].root).toBe("Projects/Work");
  });

  it("keeps both root and members when a document populates both", () => {
    // Validation never deletes a user's space. A folder space
    // with populated `members` is incoherent, but which field the RUNTIME
    // prefers is `rootOf()`'s call in a later task, not this loader's — and
    // dropping the space over it would erase the name, icon, color and
    // members from data.json on the very next write. Store both; nothing is
    // lost, and clearing `root` later brings the members straight back.
    const d = validateDefinitions({
      schemaVersion: SCHEMA_VERSION,
      settings: {},
      spaces: [{ ...base, root: "Projects/Work", members: [{ path: "Other.md", kind: "file" }] }],
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.value.spaces).toHaveLength(1);
    expect(d.ok && d.value.spaces[0].root).toBe("Projects/Work");
    expect(d.ok && d.value.spaces[0].members).toEqual([{ path: "Other.md", kind: "file" }]);
  });

  it("stores a root that is the vault root, in either spelling, as given", () => {
    // The vault root is never HONOURED as a folder-space root, and a chosen
    // root that later disappears is still kept on disk. Both are runtime
    // questions for `rootOf()` to answer — rewriting or dropping the value
    // here would destroy information this loader has no authority to judge
    // as unusable-forever.
    for (const root of ["", "/"]) {
      const d = validateDefinitions({
        schemaVersion: SCHEMA_VERSION,
        settings: {},
        spaces: [{ ...base, root, members: [] }],
      });
      expect(d.ok, `root ${JSON.stringify(root)}`).toBe(true);
      expect(d.ok && d.value.spaces, `root ${JSON.stringify(root)}`).toHaveLength(1);
      expect(d.ok && d.value.spaces[0].root, `root ${JSON.stringify(root)}`).toBe(root);
    }
  });

  it("drops a root that escapes the vault, but keeps the space", () => {
    // Unlike "" or "/", this is not a spelling of the vault root — it is a
    // shape `isSafeVaultPath` refuses outright (traversal). Refusing to
    // honour it costs only the one field, never the space around it.
    const d = validateDefinitions({
      schemaVersion: SCHEMA_VERSION,
      settings: {},
      spaces: [{ ...base, root: "../outside", members: [] }],
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.value.spaces).toHaveLength(1);
    expect(d.ok && d.value.spaces[0].root).toBeUndefined();
  });

  it("drops a non-string root, but keeps the space and its members", () => {
    // `root: null` used to cost an otherwise-valid curated space outright.
    // A malformed shape is exactly the "unusable, not incoherent" case: drop
    // the field, keep everything else — including whatever members the
    // document already had.
    const d = validateDefinitions({
      schemaVersion: SCHEMA_VERSION,
      settings: {},
      spaces: [{ ...base, root: null, members: [{ path: "Papers", kind: "folder" }] }],
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.value.spaces).toHaveLength(1);
    expect(d.ok && d.value.spaces[0].root).toBeUndefined();
    expect(d.ok && d.value.spaces[0].members).toEqual([{ path: "Papers", kind: "folder" }]);
  });

  it("leaves a curated space with no root untouched", () => {
    const d = validateDefinitions({
      schemaVersion: SCHEMA_VERSION,
      settings: {},
      spaces: [{ ...base, members: [{ path: "Papers", kind: "folder" }] }],
    });
    expect(d.ok && d.value.spaces[0].root).toBeUndefined();
    expect(d.ok && d.value.spaces[0].members).toHaveLength(1);
  });
});

describe("autoAssignColor", () => {
  function settingsOf(raw: Record<string, unknown>) {
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, ...raw } });
    if (!r.ok) throw new Error(r.error);
    return r.value.settings;
  }

  it("defaults to TRUE for a document written before it existed", () => {
    // On by default, like its Appearance neighbours: the rotation is what the
    // palette is for — consecutive spaces told apart at a glance — and an
    // install that quietly stopped coloring new spaces would read as the
    // feature breaking rather than as a default being applied.
    expect(settingsOf({}).autoAssignColor).toBe(true);
  });

  it("keeps an explicit false", () => {
    // Someone who turned color off wants it off. Silently re-enabling it on
    // the next load would undo a choice they made on purpose.
    expect(settingsOf({ autoAssignColor: false }).autoAssignColor).toBe(false);
  });

  it("does not trust a present non-boolean", () => {
    // Strict like `showSpaceHeader` and `revealVisitors`: `0` must not read as
    // true the way a `!== false` check would make it.
    expect(settingsOf({ autoAssignColor: 0 }).autoAssignColor).toBe(false);
    expect(settingsOf({ autoAssignColor: "yes" }).autoAssignColor).toBe(false);
  });
});

describe("useThemeIconColor", () => {
  function settingsOf(raw: Record<string, unknown>) {
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, ...raw } });
    if (!r.ok) throw new Error(r.error);
    return r.value.settings;
  }

  it("defaults to FALSE for a document written before it existed", () => {
    // Off, like every other setting that changes what an existing install
    // already looks like. Turning up after an update with every space icon
    // the same color reads as the colors having been lost.
    expect(settingsOf({}).useThemeIconColor).toBe(false);
  });

  it("keeps an explicit true", () => {
    expect(settingsOf({ useThemeIconColor: true }).useThemeIconColor).toBe(true);
  });

  it("does not trust a present non-boolean", () => {
    // Strict like `pinAllSpace` and `showPinnedFolder`: `1` must not read as
    // true.
    expect(settingsOf({ useThemeIconColor: 1 }).useThemeIconColor).toBe(false);
    expect(settingsOf({ useThemeIconColor: "yes" }).useThemeIconColor).toBe(false);
  });

  it("leaves every stored space color untouched", () => {
    // The promise the setting makes. It governs drawing only, so a document
    // loaded with the toggle on must still carry the colors out the other
    // side, ready for the day it goes off again.
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, useThemeIconColor: true } });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.spaces.map((s) => s.color)).toEqual(valid.spaces.map((s: { color: string }) => s.color));
  });
});

describe("showPinnedFolder", () => {
  function settingsOf(raw: Record<string, unknown>) {
    const r = validateDefinitions({ ...valid, settings: { ...valid.settings, ...raw } });
    if (!r.ok) throw new Error(r.error);
    return r.value.settings;
  }

  it("defaults to FALSE for a document written before it existed", () => {
    // Like `pinAllSpace` and unlike the other Appearance keys: this adds a
    // mark to a row every existing install already reads, and doing that
    // unasked on an update reads as a bug rather than a feature.
    expect(settingsOf({}).showPinnedFolder).toBe(false);
  });

  it("keeps an explicit true", () => {
    expect(settingsOf({ showPinnedFolder: true }).showPinnedFolder).toBe(true);
  });

  it("does not trust a present non-boolean", () => {
    expect(settingsOf({ showPinnedFolder: 1 }).showPinnedFolder).toBe(false);
    expect(settingsOf({ showPinnedFolder: "yes" }).showPinnedFolder).toBe(false);
  });
});
