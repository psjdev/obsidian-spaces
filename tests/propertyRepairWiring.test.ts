// @vitest-environment jsdom
/**
 * The repair as `main.ts` runs it: when it is allowed to start, and how its
 * result reaches the controller.
 *
 * The pure pieces are tested elsewhere — `propertyRepair.test.ts` for the plan
 * and the merge, `parseStall.test.ts` for the trigger,
 * `propertyRepairEquivalence.test.ts` for the answers. What ONLY lives in
 * `main.ts` is the glue, and it carries the invariant the design is most
 * insistent about:
 *
 *   A property snapshot build is fully synchronous, which is what makes it
 *   safe against a metadata event or a rename landing mid-walk. The repair is
 *   async, so it must compute a COMPLETE new snapshot off to the side and
 *   install it in one step — never mutating one in flight, never leaving a
 *   half-repaired index observable.
 *
 * Layer: unit. The controller, the stall watcher and the frontmatter source
 * are fakes; the plugin's own methods are real.
 */
import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import SpacesPlugin from "../src/main";
import type { PropertySnapshot } from "../src/visibility/PropertyIndex";
import type { FrontmatterRead } from "../src/visibility/frontmatterHead";
import type { SpaceDefinition } from "../src/types";

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const PROPERTY_SPACE: SpaceDefinition = {
  id: "s",
  name: "S",
  icon: "box",
  color: "#808080",
  members: [{ kind: "property", key: "status", value: "done" }],
};

function harness(opts: {
  /** Vault paths, and the frontmatter the CACHE has for each (null = unparsed). */
  files: Record<string, Record<string, unknown> | null>;
  /** What reading the head off disk answers, per path. */
  heads?: Record<string, FrontmatterRead>;
  stalled?: boolean;
  active?: SpaceDefinition | null;
}) {
  const plugin = new SpacesPlugin(
    {} as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  const record = plugin as unknown as Record<string, unknown>;
  const tfiles = new Map<string, TFile>();
  for (const path of Object.keys(opts.files)) {
    const f = new TFile();
    f.path = path;
    f.stat = { ctime: 0, mtime: 7, size: 0 };
    tfiles.set(path, f);
  }
  record.app = {
    vault: {
      getMarkdownFiles: () => [...tfiles.values()],
      getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
    },
    metadataCache: {
      getFileCache: (f: TFile) => {
        const fm = opts.files[f.path];
        return fm === null ? null : { frontmatter: fm };
      },
    },
  };
  record.loaded = true;

  const installed: Array<() => PropertySnapshot> = [];
  const refreshes: number[] = [];
  const active = "active" in opts ? opts.active : PROPERTY_SPACE;
  record.controller = {
    activeSpace: () => active,
    setPropertySnapshot: (get: () => PropertySnapshot) => void installed.push(get),
    // ASKS, as the real `membersForSnapshot` does for a space that resolves a
    // property member. A fake that only counted would hide the one thing the
    // stall path depends on: a recompute is what builds the fresh accessor.
    refresh: () => {
      refreshes.push(installed.length);
      if (active !== null) installed[installed.length - 1]?.();
    },
  };

  let stalled = opts.stalled ?? false;
  const armed = vi.fn();
  record.parseStall = { arm: armed, stalled: () => stalled, cancel: () => undefined };

  const heads: Record<string, FrontmatterRead> = { ...opts.heads };
  const read = vi.fn(
    async (path: string): Promise<FrontmatterRead> => heads[path] ?? { kind: "unreadable" }
  );
  record.frontmatter = { read };

  return {
    plugin,
    installed,
    refreshes,
    armed,
    read,
    /** Change a file's mtime, the way a real edit would. */
    touch: (path: string, mtime: number): void => {
      const f = tfiles.get(path);
      if (f === undefined) throw new Error("no such file " + path);
      f.stat = { ...f.stat, mtime };
    },
    /** A new file the cache has not parsed, with the head read it will get. */
    addFile: (path: string, head: FrontmatterRead): void => {
      const f = new TFile();
      f.path = path;
      f.stat = { ctime: 0, mtime: 7, size: 0 };
      tfiles.set(path, f);
      opts.files[path] = null;
      heads[path] = head;
    },
    jam: () => {
      stalled = true;
    },
    /** `main.ts`'s own accessor factory, and the ask that drives the build. */
    ask: (): PropertySnapshot => {
      const get = (plugin as unknown as { newPropertySnapshot(): () => PropertySnapshot })
        .newPropertySnapshot();
      installed.push(get);
      return get();
    },
    stallFired: (): void => {
      (plugin as unknown as { repairPropertiesIfStalled(): void }).repairPropertiesIfStalled();
    },
    generation: (): number => record.propertyGeneration as number,
  };
}

describe("when the repair is allowed to start", () => {
  it("does NOT read anything while the stall watcher has not latched", async () => {
    // The cold start, at the wiring level: every file unparsed and nothing
    // saying Obsidian has stopped. This is the case that must cost no disk.
    const h = harness({ files: { "a.md": null, "b.md": null }, heads: { "a.md": { kind: "none" } } });
    expect(h.ask().status).toBe("unavailable");
    await tick();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("arms the watcher whenever an ask finds unparsed files", () => {
    // The watcher gives up after two minutes; this is how a user who switches
    // into a property space long afterwards still gets served.
    const h = harness({ files: { "a.md": null } });
    h.ask();
    expect(h.armed).toHaveBeenCalled();
  });

  it("does not arm, and does not read, when the cache answered for everything", async () => {
    const h = harness({ files: { "a.md": { status: "done" } }, stalled: true });
    expect(h.ask().status).toBe("ready");
    await tick();
    expect(h.armed).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("reads nothing when more files are unparsed than a jam could explain", async () => {
    // `planRepair`'s bound, reached through the plugin. Even with the watcher
    // wrongly latched, a vault-sized unparsed list is never read off disk.
    const files: Record<string, null> = {};
    for (let i = 0; i < 400; i++) files[`n${i}.md`] = null;
    const h = harness({ files, stalled: true });
    expect(h.ask().status).toBe("unavailable");
    await tick();
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe("how the result is installed", () => {
  it("installs ONE complete snapshot, and nothing before it", async () => {
    const h = harness({
      files: { "parsed.md": { status: "done" }, "jammed.md": null, "also.md": null },
      heads: { "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } }, "also.md": { kind: "none" } },
      stalled: true,
    });
    const before = h.ask();
    expect(before.status).toBe("unavailable");
    const installsBefore = h.installed.length;
    await tick();

    // Exactly one install came out of the repair, and it is ready and whole.
    expect(h.installed.length).toBe(installsBefore + 1);
    const snapshot = h.installed[h.installed.length - 1]();
    if (snapshot.status !== "ready") throw new Error("expected the repaired snapshot to be ready");
    expect(snapshot.index.pathsMatching("status", "done")).toEqual(["jammed.md", "parsed.md"]);
    // A constant thunk: asking again cannot rebuild, so it can never ask for a
    // second repair of itself.
    expect(h.installed[h.installed.length - 1]()).toBe(snapshot);
    // And the recompute happened AFTER the install, not before it.
    expect(h.refreshes).toEqual([installsBefore + 1]);
  });

  it("stays unavailable, and says which file, when one cannot be read either", async () => {
    const h = harness({
      files: { "jammed.md": null, "locked.md": null },
      heads: { "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } } },
      stalled: true,
    });
    h.ask();
    await tick();
    const snapshot = h.installed[h.installed.length - 1]();
    if (snapshot.status !== "unavailable") throw new Error("expected unavailable");
    expect([...snapshot.unparsed]).toEqual(["locked.md"]);
  });

  it("installs NOTHING when a newer snapshot landed while it was reading", async () => {
    const h = harness({
      files: { "jammed.md": null },
      heads: { "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } } },
      stalled: true,
    });
    // A metadata event mid-read: `newPropertySnapshot` stamps a newer
    // generation, and the repair must drop its result rather than install an
    // older picture over it.
    h.read.mockImplementation(async () => {
      h.ask();
      return { kind: "frontmatter", frontmatter: { status: "done" } };
    });
    h.ask();
    const installsBefore = h.installed.length;
    await tick();
    expect(h.installed.length).toBe(installsBefore);
    expect(h.refreshes).toEqual([]);
  });

  it("runs one repair at a time", async () => {
    const h = harness({
      files: { "jammed.md": null },
      heads: { "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } } },
      stalled: true,
    });
    h.ask();
    h.ask();
    h.ask();
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("stops without touching the controller if the plugin unloaded mid-read", async () => {
    const h = harness({
      files: { "jammed.md": null, "other.md": null },
      heads: {
        "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } },
        "other.md": { kind: "none" },
      },
      stalled: true,
    });
    h.read.mockImplementationOnce(async () => {
      (h.plugin as unknown as Record<string, unknown>).loaded = false;
      return { kind: "none" };
    });
    h.ask();
    const installsBefore = h.installed.length;
    await tick();
    expect(h.installed.length).toBe(installsBefore);
    expect(h.refreshes).toEqual([]);
  });

  it("passes the file's mtime to the source, so the memo can tell a change", async () => {
    const h = harness({
      files: { "jammed.md": null },
      heads: { "jammed.md": { kind: "none" } },
      stalled: true,
    });
    h.ask();
    await tick();
    expect(h.read).toHaveBeenCalledWith("jammed.md", 7);
  });
});

describe("when the watcher latches with a space already on screen", () => {
  it("rebuilds and repairs, rather than waiting for an event a jammed vault never sends", async () => {
    const h = harness({
      files: { "jammed.md": null },
      heads: { "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } } },
    });
    // The space asked first and was told "unavailable"; that answer is
    // memoized, so nothing would ask again on its own.
    expect(h.ask().status).toBe("unavailable");
    await tick();
    expect(h.read).not.toHaveBeenCalled();

    h.jam();
    h.stallFired();
    await tick();
    const snapshot = h.installed[h.installed.length - 1]();
    expect(snapshot.status).toBe("ready");
  });

  it("repairs on a LATER ask of the same accessor, not only on the first", async () => {
    // The order a user actually produces: the vault jams, the stall is
    // detected while nothing is watching properties, and only then does the
    // user switch into a property space. The accessor in force has memoized
    // its unavailable answer, so the recompute that switch causes asks it
    // again and gets that answer back WITHOUT rebuilding. If the repair hung
    // off the build alone, this user would wait forever — and a jammed vault
    // sends no further metadata events to rescue them.
    const h = harness({
      files: { "jammed.md": null },
      heads: { "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } } },
    });
    const get = (h.plugin as unknown as { newPropertySnapshot(): () => PropertySnapshot })
      .newPropertySnapshot();
    expect(get().status).toBe("unavailable");
    await tick();
    expect(h.read).not.toHaveBeenCalled();

    h.jam();
    // The same accessor, asked again. It answers from its memo, and that must
    // still be enough to start the repair.
    expect(get().status).toBe("unavailable");
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);
    const snapshot = h.installed[h.installed.length - 1]();
    expect(snapshot.status).toBe("ready");
  });

  it("does nothing at all when no space and no picker is reading properties", async () => {
    // Budget 2: a vault with no metadata-driven space and no open picker pays
    // NOTHING, stalled or not.
    const h = harness({ files: { "jammed.md": null }, heads: { "jammed.md": { kind: "none" } }, active: null });
    h.jam();
    h.stallFired();
    await tick();
    expect(h.installed).toEqual([]);
    expect(h.read).not.toHaveBeenCalled();
  });
});

/**
 * THE BUDGET FOR THE REPAIR ITSELF, against the real plugin methods.
 *
 * `tests/propertyWorkBudget.test.ts` cannot state this one: its glue is a
 * mirror of `onMetadataEvent` with no stall watcher and no repair in it, so
 * every count below is invisible there. The numbers the wave 6 reviewer
 * measured against these same methods were 20 metadata events producing 20
 * extra property-index builds, 20 extra recomputes and 20 real disk reads per
 * persistently unreadable file — up to 200 serial `open`/`read`/`close` per
 * event at the cap, on the disconnected-share case `nodeHeadReader.ts` names.
 *
 * THE BOUND: a repair that does not close its holes costs ONE repair, ONE read
 * per file and ONE extra recompute, however many metadata events follow —
 * until a file it failed on actually changes, or the stall latches afresh.
 */
describe("the cost of a repair that cannot close its holes", () => {
  /** A metadata event, as `main.ts` serves it: a brand new lazy accessor, asked. */
  const metadataEvent = (h: ReturnType<typeof harness>): void => void h.ask();

  it("reads once and recomputes once across twenty metadata events", async () => {
    const h = harness({ files: { "locked.md": null }, stalled: true });
    for (let i = 0; i < 20; i++) {
      metadataEvent(h);
      await tick();
    }
    // One repair, one head read, one extra recompute. Not twenty.
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.refreshes).toHaveLength(1);
  });

  it("counts the installs, so a repair that gets nowhere cannot keep rebuilding", async () => {
    // A partial repair: one file answers, one never will. The snapshot stays
    // unavailable, so the second ask would otherwise start the whole thing
    // again — a complete `PropertyIndex` rebuild and an extra `refresh` each.
    const h = harness({
      files: { "jammed.md": null, "locked.md": null },
      heads: { "jammed.md": { kind: "frontmatter", frontmatter: { status: "done" } } },
      stalled: true,
    });
    metadataEvent(h);
    await tick();
    const installsAfterFirst = h.installed.length;
    const refreshesAfterFirst = h.refreshes.length;
    for (let i = 0; i < 20; i++) {
      metadataEvent(h);
      await tick();
    }
    // Twenty more accessors were installed by the twenty asks themselves, and
    // not one more by a repair.
    expect(h.installed.length).toBe(installsAfterFirst + 20);
    expect(h.refreshes.length).toBe(refreshesAfterFirst);
    expect(h.read).toHaveBeenCalledTimes(2); // jammed.md and locked.md, once each
  });

  it("tries again when a file it failed on has actually changed", async () => {
    // Mtime is the signal, and it is the one already threaded through
    // `FrontmatterSource.read`. A share that came back with no edit is covered
    // by the fresh-latch clear below, not by this.
    const h = harness({ files: { "locked.md": null }, stalled: true });
    metadataEvent(h);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);

    metadataEvent(h);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);

    h.touch("locked.md", 99);
    metadataEvent(h);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.read).toHaveBeenLastCalledWith("locked.md", 99);
  });

  it("tries again when the stall watcher latches afresh", async () => {
    // The one event that says the situation itself changed. Without it a share
    // that came back with no mtime change would never be read again, which is
    // the reason `memoizeFrontmatterSource` refuses to cache "unreadable".
    const h = harness({ files: { "locked.md": null }, stalled: true });
    metadataEvent(h);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);

    metadataEvent(h);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);

    h.stallFired();
    await tick();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("does not block a repair when one of the files is new", async () => {
    // EVERY, not any: a path a repair can still make progress on is a path
    // worth reading, and progress on one file is what turns an unavailable
    // snapshot into a ready one.
    const h = harness({
      files: { "locked.md": null },
      stalled: true,
    });
    metadataEvent(h);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(1);

    // A second file appears unparsed, and this one CAN be read.
    h.addFile("new.md", { kind: "frontmatter", frontmatter: { status: "done" } });
    metadataEvent(h);
    await tick();
    expect(h.read).toHaveBeenCalledTimes(3); // locked.md again, and new.md
  });

  it("does nothing at all when no space and no picker is reading properties", async () => {
    // Budget 2: a vault with no metadata-driven space and no open picker pays
    // NOTHING, stalled or not.
    const h = harness({ files: { "jammed.md": null }, heads: { "jammed.md": { kind: "none" } }, active: null });
    h.jam();
    h.stallFired();
    await tick();
    expect(h.installed).toEqual([]);
    expect(h.read).not.toHaveBeenCalled();
  });
});
