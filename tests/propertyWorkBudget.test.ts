import { describe, expect, it, vi, beforeEach } from "vitest";
import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { createVaultChangeCoalescer } from "../src/lifecycle/eventCoalescer";
import { resolveMembers } from "../src/controller/resolveMembers";
import { holdsPropertyMember, watchesMetadata } from "../src/definitions/membership";
import type { SpaceDefinition } from "../src/types";
import { createLazyPropertySnapshot, createObsidianPropertySnapshot } from "../src/visibility/ObsidianPropertyIndex";
import { createObsidianVaultIndex } from "../src/visibility/ObsidianVaultIndex";
import { PropertyRefreshHub } from "../src/ui/PropertyRefreshHub";
import {
  RefreshFlushState,
  metadataNotifyRoute,
  runFlush,
  submitMetadataWork,
  submitVaultWork,
} from "../src/lifecycle/refreshFlush";
import { createObsidianTagIndex } from "../src/visibility/ObsidianTagIndex";
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
 *   1. One metadata event costs at most ONE WALK PER METADATA-DRIVEN INDEX
 *      (the tag index, the property snapshot), whatever burst made it, and
 *      none for the vault tree. A space holding both a tag member and a
 *      property member therefore pays two walks, not one: each index does its
 *      own listing and its own `getFileCache` per file. That is the budget as
 *      it stands; sharing one pass between the two is a design change that
 *      touches the tag feature and is not made here.
 *   2. A vault with no property member and no open picker pays NOTHING.
 *   3. Opening the picker expands NO value buckets.
 *   4. A space naming one key pays for one key, not every key in the vault.
 *
 * "A vault walk" is a `getMarkdownFiles` listing OR a `getRoot` tree walk.
 *
 * WHAT IS REAL AND WHAT IS NOT. The hub, the coalescer, `RefreshFlushState`,
 * `runFlush`, `submitVaultWork`, `submitMetadataWork`, `metadataNotifyRoute`,
 * the vault tree walk, the real tag index (`createObsidianTagIndex`, with only
 * `getAllTags` stubbed to read a `tags` field), the property snapshot,
 * `resolveMembers` and the membership gates are the production modules, all
 * against a counting `App`. The plugin class is not (it needs an Obsidian
 * runtime), so the glue below is a MIRROR of `onMetadataEvent`,
 * `onVaultChange` and `SpaceController.membersForSnapshot`. A change to that
 * glue in main.ts is not seen here: the routing fork in `onMetadataEvent` is
 * gated by `tagIndexInvalidation.test.ts`, which runs the real method. The
 * mirror also asks the property snapshot whenever it recomputes, where the
 * real controller skips the recompute while the cache is cold and the space
 * watches metadata; the cold cases below are therefore an upper bound.
 *
 * WHAT THE MIRROR CANNOT SEE, SAID PLAINLY. It has no stall watcher, no
 * `requestPropertyRepair` and no repair-driven `refresh`, so NONE of the work
 * the repair does is counted anywhere in this file. That budget is stated and
 * asserted against the real plugin methods instead, in
 * the removed repair wiring test, under "the cost of a repair that cannot
 * close its holes". Counting it here would need the plugin class and so an
 * Obsidian runtime, which is the reason the mirror exists at all.
 *
 * ONE-SIZE COUNTS CANNOT SEE A CONSTANT FACTOR. A count is the same on every
 * machine but it does not know that a pass costs 8 ms. What it can see is a
 * change in asymptotic class, so the sizes below run at 500 and 5,000 notes
 * and assert the counts equal the note count at both.
 */

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  // The stub offers no `getAllTags`. This reads the `tags` the counting app's
  // cache carries, the one thing the real tag index needs from it.
  getAllTags: (cache: { tags?: Array<{ tag: string }> }) => cache.tags?.map((t) => t.tag) ?? null,
}));

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
function countingApp(
  notes: number,
  opts: { cold?: boolean; unparsed?: number } = {}
): { app: App; counts: Counts; warm: () => void } {
  // A cold cache reports `null` for every file, as Obsidian does before it
  // has parsed them (startup, and the busiest moment).
  let cold = opts.cold === true;
  // A PARTIALLY warm cache: every file parses but this one, which is what the
  // cache looks like for most of the time it spends warming. Unlike the cold
  // fixture it does not let the walk stop at file 1, so it is the shape that
  // makes a second walk per burst expensive rather than free.
  let unparsed = opts.unparsed;
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
        if (cold) return null;
        const i = Number(f.path.slice(1, 6));
        if (i === unparsed) return null;
        return { frontmatter: frontmatter(i), ...(i % 4 === 0 ? { tags: [{ tag: "#inbox" }] } : {}) };
      },
    },
  } as unknown as App;
  return {
    app,
    counts,
    warm: () => {
      cold = false;
      unparsed = undefined;
    },
  };
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
function fakePlugin(
  notes: number,
  active: SpaceDefinition | null,
  opts: { cold?: boolean; unparsed?: number } = {}
) {
  const { app, counts, warm } = countingApp(notes, opts);
  const hub = new PropertyRefreshHub();
  const clock = manualTimer();
  const state = new RefreshFlushState();
  /** Every tag index handed to the controller, and who handed it over. */
  const tagInstalls: Array<{ from: "event" | "flush"; index: TagIndex }> = [];
  let installer: "event" | "flush" = "event";
  let generation = 0;
  let vault = createObsidianVaultIndex(app.vault);
  counts.treeWalks = 0; // construction is startup, not an event
  let tags: TagIndex = createLazyTagIndex(() => createObsidianTagIndex(app));
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

  // The REAL tag index, lazy as in main.ts: a listing plus a `getFileCache`
  // per file, paid when a tag member asks.
  const freshTags = () => {
    const index = createLazyTagIndex(() => createObsidianTagIndex(app));
    tagInstalls.push({ from: installer, index });
    return index;
  };

  const vaultChanges = createVaultChangeCoalescer({
    timer: clock.timer,
    flush: () => {
      installer = "flush";
      try {
        flushOnce();
      } finally {
        installer = "event";
      }
    },
  });
  const flushOnce = () =>
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
    warm,
    tagInstalls,
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

  it("a space that watches metadata through a TAG pays one walk, for the tag index", async () => {
    const plugin = fakePlugin(500, space([{ kind: "tag", tag: "inbox" }]));
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.recomputes).toBe(1);
    expect(plugin.members).toHaveLength(125);
    expect(plugin.counts.treeWalks).toBe(0);
    expect(plugin.counts.listings).toBe(1);
    expect(plugin.counts.cacheReads).toBe(500);
  });

  it("a space holding a tag AND a property member pays one walk per index, two in all", async () => {
    // Stated as the budget, not hidden: each metadata-driven index does its own
    // listing and its own cache read per file. A vault pass shared between them
    // would make this 1 and 500, and is a separate design change.
    const plugin = fakePlugin(
      500,
      space([
        { kind: "tag", tag: "inbox" },
        { kind: "property", key: "status", value: "done" },
      ])
    );
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.recomputes).toBe(1);
    expect(plugin.counts.treeWalks).toBe(0);
    expect(plugin.counts.listings).toBe(2);
    expect(plugin.counts.cacheReads).toBe(1000);
  });

  it("a cold cache costs ONE listing and one read PER FILE, however many events", async () => {
    // Startup. An unavailable snapshot is not kept, so every ask rebuilds; the
    // memo in `createLazyPropertySnapshot` is what holds a burst to one walk,
    // and one recompute asks once.
    //
    // THE COUNT CHANGED, DELIBERATELY: one cache read became 500, and 501
    // became 1,000. The walk used to abandon at the first null, so the cold
    // case was the cheapest in this file — and that cheapness was the bug.
    // Abandoning threw away WHICH files were unparsed, so a vault holding a
    // file Obsidian cannot parse had property members off permanently with
    // nothing to repair from; `ObsidianPropertyIndex.ts` carries the
    // measurement and the trade. The budget this file states is "one metadata
    // event costs at most ONE WALK per metadata-driven index", and that is
    // still exactly what is asserted here: one listing and one read per file
    // for fifty events, not fifty walks. What is gone is a short-circuit that
    // made one SHAPE of walk cheaper, not the bound on how many walks an event
    // may cause.
    const plugin = fakePlugin(500, space([{ kind: "property", key: "status" }]), { cold: true });
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.recomputes).toBe(1);
    expect(plugin.members).toEqual([]);
    expect(plugin.counts.treeWalks).toBe(0);
    expect(plugin.counts.listings).toBe(1);
    expect(plugin.counts.cacheReads).toBe(500);
    // The cache finishes parsing; the next burst is ready and walks once more.
    plugin.warm();
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.members.length).toBe(500);
    expect(plugin.counts.listings).toBe(2);
    expect(plugin.counts.cacheReads).toBe(1000);
  });

  it("a cold cache names every unparsed file, which is what the repair is driven by", () => {
    // What the extra 499 reads above are FOR, asserted rather than implied.
    const { app } = countingApp(3, { cold: true });
    const snap = createObsidianPropertySnapshot(app, 1);
    if (snap.status !== "unavailable") throw new Error("expected unavailable");
    expect([...snap.unparsed]).toEqual(["n00000.md", "n00001.md", "n00002.md"]);
  });

  it("a partially warm cache walks once across a burst that asks twice", async () => {
    // Every cold shape now costs one full walk, so this no longer differs from
    // the case above in PRICE — it differs in what it proves. 499 notes parsed
    // and the last not, and the burst asks twice, because `runFlush` tells the
    // open picker and then recomputes the space. Both asks must share one
    // walk, and only the memo makes that true.
    const plugin = fakePlugin(500, space([{ kind: "property", key: "status" }]), { unparsed: 499 });
    let asks = 0;
    plugin.hub.subscribe(() => {
      asks++;
      plugin.snapshot();
    });
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(asks).toBe(1);
    expect(plugin.recomputes).toBe(1);
    // The MIRROR resolves nothing from an unavailable snapshot. It has no
    // `SpaceController` — `refresh` here is a hand-written reduction of
    // `membersForSnapshot` — so nothing in this file holds a previous answer
    // or decides whether to publish one. That "unavailable is not empty" rule
    // is the controller's, and `coldMetadataCache.test.ts` is where it is
    // pinned; this asserts only what the mirror returns.
    expect(plugin.members).toEqual([]);
    expect(plugin.counts.listings).toBe(1);
    // 500 reads: one walk of 500 files. Two walks would be 2 listings and
    // 1,000 reads, which is what asking twice cost while an unavailable answer
    // was thrown away.
    expect(plugin.counts.cacheReads).toBe(500);

    // The note parses. The NEXT event installs a fresh accessor, which is what
    // drops the unavailable answer, so the burst after it is ready.
    plugin.warm();
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.members.length).toBe(500);
    expect(plugin.counts.listings).toBe(2);
    expect(plugin.counts.cacheReads).toBe(1000);
  });

  it("a cold cache with a picker open builds once per burst, however many the picker asks", async () => {
    const plugin = fakePlugin(500, null, { cold: true });
    let asks = 0;
    plugin.hub.subscribe(() => {
      asks++;
      plugin.snapshot();
    });
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(asks).toBe(1);
    expect(plugin.counts.listings).toBe(1);
    // 500, not 1, for the reason the cold case above gives: the walk runs to
    // the end so it can name the unparsed files.
    expect(plugin.counts.cacheReads).toBe(500);
  });

  it("a full flush installs a NEW tag index; a metadata-only burst installs none from the flush", async () => {
    // The tag feature's central invariant, carried by `runFlush`: a recompute
    // reading a fresh vault against a stale tag index shows a note the vault
    // has and the tags do not.
    const tagSpace = space([{ kind: "tag", tag: "inbox" }]);
    const vaultBurst = fakePlugin(50, tagSpace);
    const before = vaultBurst.tagInstalls.length;
    vaultBurst.vaultEvent();
    await tick();
    vaultBurst.settle();
    const fromFlush = vaultBurst.tagInstalls.slice(before).filter((t) => t.from === "flush");
    expect(fromFlush).toHaveLength(1);
    expect(vaultBurst.tagInstalls.slice(0, before).map((t) => t.index)).not.toContain(fromFlush[0].index);

    const metadataBurst = fakePlugin(50, tagSpace);
    for (let i = 0; i < 50; i++) metadataBurst.metadataEvent();
    await tick();
    metadataBurst.settle();
    expect(metadataBurst.tagInstalls.filter((t) => t.from === "flush")).toHaveLength(0);
    // The events themselves installed one each, which is what keeps the tag
    // index fresh without the flush.
    expect(metadataBurst.tagInstalls.filter((t) => t.from === "event")).toHaveLength(50);
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

describe("the counts are linear in the vault at two sizes", () => {
  // A count cannot see a constant factor, but it does see a change of
  // asymptotic class: a quadratic pass would not give cacheReads === notes.
  it.each([500, 5000])("at %i notes: one read per note, one normalization per note per key opened", async (notes) => {
    const plugin = fakePlugin(notes, space([{ kind: "property", key: "status", value: "done" }]));
    for (let i = 0; i < 50; i++) plugin.metadataEvent();
    await tick();
    plugin.settle();
    expect(plugin.counts.listings).toBe(1);
    expect(plugin.counts.cacheReads).toBe(notes);
    // `status` is on every note, plus the query.
    expect(vi.mocked(normalizeValue)).toHaveBeenCalledTimes(notes + 1);

    const snap = plugin.snapshot();
    if (snap.status !== "ready") throw new Error("expected ready");
    vi.mocked(normalizeValue).mockClear();
    snap.index.listValues("created");
    expect(vi.mocked(normalizeValue)).toHaveBeenCalledTimes(notes);
    vi.mocked(normalizeValue).mockClear();
    snap.index.listKeys();
    expect(vi.mocked(normalizeValue)).not.toHaveBeenCalled();
  });
});

describe("the pure index is no more expensive than its input", () => {
  it("builds the key map without reading a value", () => {
    vi.mocked(normalizeValue).mockClear();
    createPropertyIndex([{ path: "a.md", frontmatter: { x: "1", y: ["a", "b"] } }], 1);
    expect(vi.mocked(normalizeValue)).not.toHaveBeenCalled();
  });
});
