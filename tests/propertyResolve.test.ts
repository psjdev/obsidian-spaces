import { describe, expect, it, vi } from "vitest";
import { resolveMembers } from "../src/controller/resolveMembers";
import { SpaceController } from "../src/controller/SpaceController";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { holdsPropertyMember, resolvedPaths, watchesMetadata } from "../src/definitions/membership";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildPreview } from "../src/ui/previewSeam";
import { compileIgnore } from "../src/visibility/glob";
import { createPropertyIndex, type PropertySnapshot } from "../src/visibility/PropertyIndex";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { buildFakeVault } from "./helpers/fakeVault";
import { SCHEMA_VERSION, type MemberEntry, type SpaceDefinition } from "../src/types";

const tags = createMapTagIndex(new Map([["t", ["Work/tagged.md"]]]));
const properties = createPropertyIndex(
  [
    { path: "Work/a.md", frontmatter: { status: "active" } },
    { path: "Work/tagged.md", frontmatter: { status: "active" } },
    { path: "Work/b.md", frontmatter: { status: "active" } },
  ],
  1
);
const space = (s: Partial<SpaceDefinition>): SpaceDefinition => ({
  id: "s", name: "S", icon: "box", color: "#808080", members: [], ...s,
});
const paths = (s: SpaceDefinition): string[] =>
  resolveMembers(s, tags, properties).map((m) => m.path).sort();

describe("precedence", () => {
  it("expands a property member", () => {
    expect(paths(space({ members: [{ kind: "property", key: "status", value: "active" }] })))
      .toEqual(["Work/a.md", "Work/b.md", "Work/tagged.md"]);
  });

  it("hides a property match that is excluded", () => {
    expect(paths(space({
      members: [{ kind: "property", key: "status", value: "active" }],
      exclude: ["Work/a.md"],
    }))).toEqual(["Work/b.md", "Work/tagged.md"]);
  });

  it("hides a note that is both a property and a tag match when excluded", () => {
    expect(paths(space({
      members: [{ kind: "property", key: "status", value: "active" }, { kind: "tag", tag: "t" }],
      exclude: ["Work/tagged.md"],
    }))).toEqual(["Work/a.md", "Work/b.md"]);
  });

  it("SHOWS an excluded note that is also an exact file member", () => {
    // The existing rule, preserved deliberately: removing a hand-named note
    // removes the member rather than writing an exclusion.
    expect(paths(space({
      members: [{ kind: "property", key: "status", value: "active" }, { kind: "file", path: "Work/a.md" }],
      exclude: ["Work/a.md"],
    }))).toEqual(["Work/a.md", "Work/b.md", "Work/tagged.md"]);
  });

  it("expands the has-the-key shape", () => {
    expect(paths(space({ members: [{ kind: "property", key: "status" }] })))
      .toEqual(["Work/a.md", "Work/b.md", "Work/tagged.md"]);
  });

  it("contributes nothing when no property index is available", () => {
    const s = space({ members: [{ kind: "property", key: "status" }] });
    expect(resolveMembers(s, tags, null)).toEqual([]);
  });

  it("never yields one note twice", () => {
    const s = space({
      members: [
        { kind: "property", key: "status" },
        { kind: "property", key: "status", value: "active" },
        { kind: "file", path: "Work/a.md" },
      ],
    });
    const out = resolveMembers(s, tags, properties).map((m) => m.path);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe("the helpers that read a property member", () => {
  const s = space({ members: [{ kind: "property", key: "status" }] });

  it("watches metadata, so a cold cache falls open and a change recomputes", () => {
    expect(watchesMetadata(s)).toBe(true);
    expect(watchesMetadata(space({ members: [{ kind: "file", path: "a.md" }] }))).toBe(false);
  });

  it("says whether a space holds one", () => {
    expect(holdsPropertyMember(s)).toBe(true);
    expect(holdsPropertyMember(space({ members: [{ kind: "tag", tag: "t" }] }))).toBe(false);
  });

  it("counts a property match as held, canonically", () => {
    expect(resolvedPaths(s, tags, properties)).toEqual(
      new Set(["work/a.md", "work/b.md", "work/tagged.md"])
    );
  });

  it("holds nothing through a property member while no index is available", () => {
    expect(resolvedPaths(s, tags, null).size).toBe(0);
  });
});

describe("the preview", () => {
  const vault = buildFakeVault({
    Work: "folder",
    "Work/a.md": "file",
    "Work/b.md": "file",
    "Work/tagged.md": "file",
  });
  const preview = (
    members: MemberEntry[],
    index: typeof properties | null,
    excluded: ReadonlySet<string> = new Set()
  ) => buildPreview(vault, compileIgnore([]), tags, () => index, excluded)(members);

  it("counts the notes a property member matches", () => {
    expect(preview([{ kind: "property", key: "status", value: "active" }], properties).notes).toBe(3);
  });

  it("drops an excluded property match", () => {
    const out = preview([{ kind: "property", key: "status" }], properties, new Set(["work/a.md"]));
    expect(out.notes).toBe(2);
  });

  it("counts nothing for a property member while no index is available", () => {
    expect(preview([{ kind: "property", key: "status" }], null).notes).toBe(0);
  });

  it("asks once for several property members when the answer is null", () => {
    // A null answer must be remembered. `index ??= properties()` re-asks for
    // every further property member, and while the cache is cold each ask is
    // a vault walk.
    const ask = vi.fn((): typeof properties | null => null);
    const out = buildPreview(vault, compileIgnore([]), tags, ask)([
      { kind: "property", key: "status" },
      { kind: "property", key: "status", value: "active" },
      { kind: "property", key: "other" },
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(out.notes).toBe(0);
  });

  it("does not ask for the index when no member is a property member", () => {
    const ask = vi.fn(() => properties);
    buildPreview(vault, compileIgnore([]), tags, ask)([{ kind: "tag", tag: "t" }]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks at most once for several property members", () => {
    const ask = vi.fn(() => properties);
    buildPreview(vault, compileIgnore([]), tags, ask)([
      { kind: "property", key: "status" },
      { kind: "property", key: "status", value: "active" },
    ]);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("SpaceController with a property space", () => {
  const files = buildFakeVault({
    Work: "folder",
    "Work/a.md": "file",
    "Work/b.md": "file",
    "Other.md": "file",
  });
  const ready: PropertySnapshot = {
    status: "ready",
    index: createPropertyIndex(
      [
        { path: "Work/a.md", frontmatter: { status: "active" } },
        { path: "Work/b.md", frontmatter: { status: "done" } },
      ],
      1
    ),
  };
  const unavailable: PropertySnapshot = { status: "unavailable" };

  async function build(members: MemberEntry[], exclude?: string[]) {
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: false },
      spaces: [{ id: "p", name: "P", icon: "box", color: "#808080", members, exclude }],
    };
    const store = new DefinitionStore({
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    });
    await store.load();
    const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
    runtime.load();
    let answer: PropertySnapshot = ready;
    const asks = vi.fn(() => answer);
    const controller = new SpaceController(
      store,
      runtime,
      files,
      { apply: vi.fn(), livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      asks
    );
    return {
      controller,
      store,
      asks,
      set: (s: PropertySnapshot) => {
        answer = s;
      },
    };
  }
  const visibleNotes = (c: SpaceController): string[] =>
    ["Work/a.md", "Work/b.md", "Other.md"].filter((p) => c.currentSnapshot()!.decisionFor(p).visible);
  const ACTIVE: MemberEntry[] = [{ kind: "property", key: "status", value: "active" }];

  it("shows the notes a property member matches", async () => {
    const { controller } = await build(ACTIVE);
    await controller.switchTo({ kind: "space", id: "p" });
    expect(visibleNotes(controller)).toEqual(["Work/a.md"]);
  });

  it("reads the snapshot once per resolve", async () => {
    const { controller, asks } = await build(ACTIVE);
    await controller.switchTo({ kind: "space", id: "p" });
    asks.mockClear();
    controller.refresh();
    expect(asks).toHaveBeenCalledTimes(1);
  });

  it("does not read the snapshot for a space with no property member", async () => {
    const { controller, asks } = await build([{ kind: "file", path: "Other.md" }]);
    await controller.switchTo({ kind: "space", id: "p" });
    controller.refresh();
    expect(asks).not.toHaveBeenCalled();
  });

  it("keeps the previous result while the snapshot is unavailable", async () => {
    const { controller, set } = await build(ACTIVE);
    await controller.switchTo({ kind: "space", id: "p" });
    expect(visibleNotes(controller)).toEqual(["Work/a.md"]);
    set(unavailable);
    controller.refresh();
    expect(visibleNotes(controller)).toEqual(["Work/a.md"]);
  });

  it("holds rather than rendering empty on a first start, then fills when ready", async () => {
    // It used to publish itself EMPTY here: `resolveMembers` was handed
    // `null`, the property member contributed nothing, and "not known yet"
    // reached the tree as "matches nothing". The controller now holds the
    // recompute back (`stillReading`) and the tree falls open until an index
    // has been ready once.
    const { controller, set } = await build(ACTIVE);
    set(unavailable);
    await controller.switchTo({ kind: "space", id: "p" });
    expect(controller.currentSnapshot()).toBeNull();
    set(ready);
    controller.refresh();
    expect(visibleNotes(controller)).toEqual(["Work/a.md"]);
  });

  it("keeps a property-only space's other matches when a note is removed while cold", async () => {
    // "Remove from space" on a property-matched row writes an exclusion. That
    // must hide the one note, not miss a cache and empty the space.
    const everyActive: PropertySnapshot = {
      status: "ready",
      index: createPropertyIndex(
        [
          { path: "Work/a.md", frontmatter: { status: "active" } },
          { path: "Work/b.md", frontmatter: { status: "active" } },
        ],
        1
      ),
    };
    const { controller, store, set } = await build(ACTIVE);
    set(everyActive);
    await controller.switchTo({ kind: "space", id: "p" });
    expect(visibleNotes(controller)).toEqual(["Work/a.md", "Work/b.md"]);
    set(unavailable);
    await store.mutate((d) => {
      d.spaces[0].exclude = ["Work/a.md"];
    });
    controller.refresh();
    expect(visibleNotes(controller)).toEqual(["Work/b.md"]);
  });

  it("applies a note added while cold on top of the kept matches", async () => {
    const { controller, store, set } = await build(ACTIVE);
    await controller.switchTo({ kind: "space", id: "p" });
    set(unavailable);
    await store.mutate((d) => {
      d.spaces[0].members.push({ kind: "file", path: "Other.md" });
    });
    controller.refresh();
    expect(visibleNotes(controller)).toEqual(["Work/a.md", "Other.md"]);
  });

  it("picks up a replaced accessor", async () => {
    const { controller } = await build(ACTIVE);
    await controller.switchTo({ kind: "space", id: "p" });
    controller.setPropertySnapshot(() => ({
      status: "ready",
      index: createPropertyIndex([{ path: "Work/b.md", frontmatter: { status: "active" } }], 2),
    }));
    controller.refresh();
    expect(visibleNotes(controller)).toEqual(["Work/b.md"]);
  });
});
