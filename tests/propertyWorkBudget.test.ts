import { describe, expect, it, vi, beforeEach } from "vitest";
import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { createVaultChangeCoalescer } from "../src/lifecycle/eventCoalescer";
import { resolveMembers } from "../src/controller/resolveMembers";
import { holdsPropertyMember, watchesMetadata } from "../src/definitions/membership";
import type { SpaceDefinition } from "../src/types";
import { createLazyPropertySnapshot, createObsidianPropertySnapshot } from "../src/visibility/ObsidianPropertyIndex";
import { createObsidianVaultIndex } from "../src/visibility/ObsidianVaultIndex";
import {
  PropertyRefreshHub,
  RefreshFlushState,
  metadataNotifyRoute,
  runFlush,
  submitMetadataWork,
  submitVaultWork,
} from "../src/visibility/PropertyRefreshHub";
import { createLazyTagIndex, createMapTagIndex, type TagIndex } from "../src/visibility/TagIndex";
import { createPropertyIndex, type PropertySnapshot } from "../src/visibility/PropertyIndex";
import { normalizeValue } from "../src/visibility/propertyValues";

/**
 * THE WORK BUDGET OF PROPERTY MEMBERS, as counts.
 *
 * A budget in milliseconds is unfalsifiable on a CI runner and unreviewable.
 * These are counts of the Obsidian-facing calls (`getMarkdownFiles`,
 * `getFileCache`, `getRoot`) and of value normalizations, which are the same
 * on every machine and fail loudly when somebody regresses them:
 *
 *   1. One metadata event costs AT MOST ONE vault walk, whatever burst made it.
 *   2. A vault with no property member and no open picker pays NOTHING.
 *   3. Opening the picker expands NO value buckets.
 *   4. A space naming one key pays for one key, not every key in the vault.
 *
 * "A vault walk" is a `getMarkdownFiles` listing OR a `getRoot` tree walk.
 *
 * WHAT IS REAL AND WHAT IS NOT. The hub, the coalescer, `RefreshFlushState`,
 * `submitVaultWork`, `metadataNotifyRoute`, the vault walk, the property
 * snapshot, `resolveMembers` and the membership gates are the production
 * modules. The plugin class is not (it needs an Obsidian runtime), so the
 * handler glue below is a MIRROR of `onMetadataEvent`, `onVaultChange` and the
 * coalescer's flush in main.ts. A change to that glue in main.ts is not seen
 * here; the parts that decide what a flush DOES are shared (see `runFlush`).
 */

vi.mock("../src/visibility/propertyValues", async () => {
  const actual = await vi.importActual<typeof import("../src/visibility/propertyValues")>(
    "../src/visibility/propertyValues"
  );
  return { ...actual, normalizeValue: vi.fn(actual.normalizeValue) };
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const manualTimer = () => {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timer: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: number) => void pending.delete(id),
      now: () => now,
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
};

/** What the Obsidian-facing calls were asked, and how often. */
interface Counts {
  /** `vault.getMarkdownFiles()` calls. */
  listings: number;
  /** `vault.getRoot()` calls: one per tree walk. */
  treeWalks: number;
  /** `metadataCache.getFileCache()` calls. */
  cacheReads: number;
}

/**
 * A vault of `notes` markdown files, five properties on most of them and one
 * key, `created`, with a value distinct per note. Counts every call the
 * property feature can make into Obsidian.
 */
function countingApp(notes: number): { app: App; counts: Counts } {
  const counts: Counts = { listings: 0, treeWalks: 0, cacheReads: 0 };
  const root = new TFolder();
  root.path = "/";
  const files = Array.from({ length: notes }, (_, i) => {
    const f = new TFile();
    f.path = `n${String(i).padStart(5, "0")}.md`;
    f.parent = root;
    return f;
  });
  root.children = files;
  const frontmatter = (i: number) => ({
    status: i % 3 === 0 ? "done" : "active",
    area: `area-${i % 7}`,
    priority: i % 5,
    topics: ["a", "b"],
    created: `2026-01-01T00:${String(i).padStart(5, "0")}`,
  });
  const app = {
    vault: {
      getRoot: () => {
        counts.treeWalks++;
        return root;
      },
      getMarkdownFiles: () => {
        counts.listings++;
        return [...files];
      },
    },
    metadataCache: {
      getFileCache: (f: TFile) => {
        counts.cacheReads++;
        return { frontmatter: frontmatter(Number(f.path.slice(1, 6))) };
      },
    },
  } as unknown as App;
  return { app, counts };
}

const space = (members: SpaceDefinition["members"], root?: string): SpaceDefinition => ({
  id: "s",
  name: "S",
  icon: "box",
  color: "#808080",
  members,
  ...(root === undefined ? {} : { root }),
});

/**
 * main.ts's handlers over the real coordination pieces, against a counting
 * vault. `flush` is what the shared coalescer runs.
 */
function fakePlugin(notes: number, active: SpaceDefinition | null) {
  const { app, counts } = countingApp(notes);
  const hub = new PropertyRefreshHub();
  const clock = manualTimer();
  const state = new RefreshFlushState();
  const tagBuilds = { n: 0 };
  let generation = 0;
  let vault = createObsidianVaultIndex(app.vault);
  counts.treeWalks = 0; // construction is startup, not an event
  let tags: TagIndex;
  const newSnapshot = () => {
    const g = ++generation;
    return createLazyPropertySnapshot(() => createObsidianPropertySnapshot(app, g));
  };
  let properties = newSnapshot();
  let recomputes = 0;
  let members: ReturnType<typeof resolveMembers> = [];

  /** `SpaceController.membersForSnapshot`, reduced to the property decision. */
  const refresh = () => {
    recomputes++;
    if (active === null) return;
    let index = null;
    if (holdsPropertyMember(active)) {
      const snap = properties();
      index = snap.status === "ready" ? snap.index : null;
    }
    members = resolveMembers(active, tags, index);
  };

  const freshTags = () =>
    createLazyTagIndex(() => {
      tagBuilds.n++;
      return createMapTagIndex(new Map());
    });

  const vaultChanges = createVaultChangeCoalescer({
    timer: clock.timer,
    flush: () =>
      runFlush(state, {
        replaceVaultIndex: () => {
          vault = createObsidianVaultIndex(app.vault);
        },
        replaceTagIndex: () => {
          tags = freshTags();
        },
        installPropertySnapshot: () => {
          properties = newSnapshot();
        },
        notifyPickers: () => hub.notify(),
        refresh,
      }),
  });

  const vaultEvent = () => {
    void submitVaultWork((w) => vaultChanges.submit(w), state, async () => undefined);
  };
  const metadataEvent = () => {
    tags = freshTags();
    properties = newSnapshot();
    const route = metadataNotifyRoute(watchesMetadata(active), hub.size);
    if (route === "none") return;
    if (route === "picker-flush") void vaultChanges.submit(async () => undefined);
    else void submitMetadataWork((w) => vaultChanges.submit(w), state);
    state.noteSnapshotInstalled();
  };

  return {
    app,
    counts,
    tagBuilds,
    hub,
    state,
    get recomputes() {
      return recomputes;
    },
    get members() {
      return members;
    },
    get vault() {
      return vault;
    },
    snapshot: (): PropertySnapshot => properties(),
    metadataEvent,
    vaultEvent,
    settle: () => clock.advance(10_000),
  };
}

const total = (c: Counts) => c.listings + c.treeWalks;

beforeEach(() => {
  vi.mocked(normalizeValue).mockClear();
});

describe("budget 1: one metadata event costs at most one vault walk", () => {
  it("a burst of 50 events in a space that watches metadata walks the vault once", async () => {
    const plugin = fakePlugin(500, space([{ kind: "property", key: "status", value: "done" }]));
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.recomputes).toBe(1);
    expect(plugin.members.length).toBeGreaterThan(0);
    // The one walk is the frontmatter walk the property member asked for. The
    // tree walk is not needed: a note's metadata is not vault structure.
    expect(plugin.counts.treeWalks).toBe(0);
    expect(plugin.counts.listings).toBe(1);
    expect(plugin.counts.cacheReads).toBe(500);
    expect(total(plugin.counts)).toBeLessThanOrEqual(1);
  });

  it("a burst of 50 events with only a picker open walks the vault once", async () => {
    const plugin = fakePlugin(500, null);
    const reads: number[] = [];
    plugin.hub.subscribe(() => {
      const snap = plugin.snapshot();
      if (snap.status === "ready") reads.push(snap.index.listKeys().length);
    });
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(reads).toHaveLength(1);
    expect(total(plugin.counts)).toBeLessThanOrEqual(1);
  });

  it("a space that watches metadata through a TAG walks no files for a property", async () => {
    const plugin = fakePlugin(500, space([{ kind: "tag", tag: "inbox" }]));
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.recomputes).toBe(1);
    expect(plugin.counts.treeWalks).toBe(0);
    expect(plugin.counts.listings).toBe(0);
    expect(plugin.counts.cacheReads).toBe(0);
  });

  it("a note creation (vault event, then metadata event) walks each thing once", async () => {
    const plugin = fakePlugin(500, space([{ kind: "property", key: "status" }]));
    plugin.vaultEvent();
    plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.recomputes).toBe(1);
    // The vault event genuinely changed the tree, so one tree walk is owed.
    expect(plugin.counts.treeWalks).toBe(1);
    expect(plugin.counts.listings).toBe(1);
  });
});

describe("budget 2: a vault with no property member and no picker pays nothing", () => {
  it.each([
    ["All", null],
    ["a folder space", space([], "Projects")],
    ["a space of paths", space([{ kind: "folder", path: "Areas" }])],
  ])("%s: metadata events cost no walk, no cache read and no index", async (_name, active) => {
    const plugin = fakePlugin(500, active);
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.counts).toEqual({ listings: 0, treeWalks: 0, cacheReads: 0 });
    expect(plugin.tagBuilds.n).toBe(0);
  });

  it("a vault event pays its tree walk and nothing for properties", async () => {
    const plugin = fakePlugin(500, space([{ kind: "folder", path: "Areas" }]));
    plugin.vaultEvent();
    await tick();
    plugin.settle();
    expect(plugin.counts.treeWalks).toBe(1);
    expect(plugin.counts.listings).toBe(0);
    expect(plugin.counts.cacheReads).toBe(0);
  });

  it("building the snapshot accessor reads nothing until something asks", () => {
    const { app, counts } = countingApp(500);
    createLazyPropertySnapshot(() => createObsidianPropertySnapshot(app, 1));
    expect(counts).toEqual({ listings: 0, treeWalks: 0, cacheReads: 0 });
  });
});

describe("budget 3: opening the picker expands no value buckets", () => {
  it("lists keys and counts without normalizing a single value", () => {
    const { app } = countingApp(500);
    const snap = createObsidianPropertySnapshot(app, 1);
    if (snap.status !== "ready") throw new Error("expected ready");
    vi.mocked(normalizeValue).mockClear();
    // Everything a Properties body needs before a key is opened: the keys, their
    // counts, and which notes carry each key.
    const keys = snap.index.listKeys();
    for (const { key } of keys) snap.index.pathsWithKey(key);
    expect(keys.map((k) => k.key).sort()).toEqual(["area", "created", "priority", "status", "topics"]);
    expect(vi.mocked(normalizeValue)).not.toHaveBeenCalled();
  });

  it("expands exactly the key that is opened, once", () => {
    const { app } = countingApp(500);
    const snap = createObsidianPropertySnapshot(app, 1);
    if (snap.status !== "ready") throw new Error("expected ready");
    vi.mocked(normalizeValue).mockClear();
    snap.index.listValues("created");
    expect(vi.mocked(normalizeValue)).toHaveBeenCalledTimes(500);
    vi.mocked(normalizeValue).mockClear();
    snap.index.listValues("created");
    expect(vi.mocked(normalizeValue)).not.toHaveBeenCalled();
  });
});

describe("budget 4: a space naming one key pays for one key", () => {
  const index = () => {
    const { app } = countingApp(500);
    const snap = createObsidianPropertySnapshot(app, 1);
    if (snap.status !== "ready") throw new Error("expected ready");
    return snap.index;
  };

  it("a key-only member normalizes nothing", () => {
    const idx = index();
    vi.mocked(normalizeValue).mockClear();
    resolveMembers(space([{ kind: "property", key: "status" }]), createMapTagIndex(new Map()), idx);
    expect(vi.mocked(normalizeValue)).not.toHaveBeenCalled();
  });

  it("a key=value member normalizes that key's values and the query, never another key's", () => {
    const idx = index();
    vi.mocked(normalizeValue).mockClear();
    const out = resolveMembers(
      space([{ kind: "property", key: "status", value: "done" }]),
      createMapTagIndex(new Map()),
      idx
    );
    expect(out.length).toBe(167);
    // 500 notes carry `status`, and the query is one more. Expanding every key
    // would be at least 500 * 4 (priority, area, status, created) more.
    expect(vi.mocked(normalizeValue)).toHaveBeenCalledTimes(501);
    // And the same snapshot answers the second ask from its memo.
    vi.mocked(normalizeValue).mockClear();
    resolveMembers(
      space([{ kind: "property", key: "status", value: "active" }]),
      createMapTagIndex(new Map()),
      idx
    );
    expect(vi.mocked(normalizeValue)).toHaveBeenCalledTimes(1);
  });
});

describe("the pure index is no more expensive than its input", () => {
  it("builds the key map without reading a value", () => {
    vi.mocked(normalizeValue).mockClear();
    createPropertyIndex([{ path: "a.md", frontmatter: { x: "1", y: ["a", "b"] } }], 1);
    expect(vi.mocked(normalizeValue)).not.toHaveBeenCalled();
  });
});
