// @vitest-environment jsdom
/**
 * The stall notice as `main.ts` runs it.
 *
 * The message is `tests/parseStallNotice.test.ts`; the trigger is
 * `tests/parseStall.test.ts`. What only lives in `main.ts` is the glue: the
 * accessor has to remember what the walk could not read, and the stall handler
 * has to decide whether anybody needs telling.
 *
 * This replaces the repair wiring test that went with 0.12.0's removal of the
 * repair. The invariant it protected is gone with the async repair; what is
 * left to protect is that the notice fires once, names something, and does
 * not interrupt somebody who is not reading properties at all.
 *
 * Layer: unit. The controller and the stall watcher are fakes; the plugin's
 * own methods are real.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { noticeLog, type Notice } from "./helpers/obsidian-stub";
import SpacesPlugin from "../src/main";
import type { PropertySnapshot } from "../src/visibility/PropertyIndex";
import type { SpaceDefinition } from "../src/types";

const PROPERTY_SPACE: SpaceDefinition = {
  id: "s",
  name: "S",
  icon: "box",
  color: "#808080",
  members: [{ kind: "property", key: "status", value: "done" }],
};

const TAG_SPACE: SpaceDefinition = {
  id: "t",
  name: "T",
  icon: "box",
  color: "#808080",
  members: [{ kind: "tag", tag: "work" }],
};

function harness(opts: {
  /** Vault paths, and the frontmatter the CACHE has for each (null = unparsed). */
  files: Record<string, Record<string, unknown> | null>;
  /** Byte sizes, for the "name the largest" rule. Default 0 for every path. */
  sizes?: Record<string, number>;
  active?: SpaceDefinition | null;
  /** Open pickers waiting on properties, which also deserve the notice. */
  pickers?: number;
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
    f.stat = { ctime: 0, mtime: 7, size: opts.sizes?.[path] ?? 0 };
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

  const active = "active" in opts ? opts.active : PROPERTY_SPACE;
  let drawnAsks = 0;
  record.controller = {
    activeSpace: () => active,
    setPropertySnapshot: () => undefined,
    refresh: () => undefined,
    // What `SpaceController.drawnPropertyIndex` does: ask the installed
    // accessor, which is what runs the walk. The real one holds the accessor
    // `main.ts` gave it; this builds one the same way.
    drawnPropertyIndex: () => {
      drawnAsks++;
      const get = (plugin as unknown as { newPropertySnapshot(): () => PropertySnapshot })
        .newPropertySnapshot();
      get();
      return null;
    },
  };
  record.propertyRefresh = { size: opts.pickers ?? 0, notify: () => undefined };

  let armed = 0;
  record.parseStall = {
    arm: () => void armed++,
    stalled: () => true,
    cancel: () => undefined,
  };

  return {
    plugin,
    armCount: (): number => armed,
    drawnAsks: (): number => drawnAsks,
    /** `main.ts`'s own accessor factory, and the ask that drives the build. */
    ask: (): PropertySnapshot => {
      const get = (plugin as unknown as { newPropertySnapshot(): () => PropertySnapshot })
        .newPropertySnapshot();
      return get();
    },
    /**
     * ONE accessor, handed back so a test can ask it more than once.
     *
     * `ask` builds a fresh accessor every call, which is the common path but
     * cannot see the memo boundary at all. See the second-ask test.
     */
    accessor: (): (() => PropertySnapshot) =>
      (plugin as unknown as { newPropertySnapshot(): () => PropertySnapshot })
        .newPropertySnapshot(),
    /** What the watcher calls when its verdict turns to "stalled". */
    stallFired: (): void => {
      (plugin as unknown as { reportParseStall(): void }).reportParseStall();
    },
    messages: (): string[] => noticeLog.map((n: Notice) => String(n.message)),
  };
}

describe("the stall notice, as main.ts wires it", () => {
  beforeEach(() => {
    noticeLog.length = 0;
  });

  it("names the first unparsed note once the stall latches", () => {
    const h = harness({
      files: { "0000 huge.md": null, "b.md": { status: "done" }, "c.md": null },
    });
    h.ask();
    h.stallFired();
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain('"0000 huge.md"');
    expect(h.messages()[0]).toContain("2 notes");
  });

  it("no longer stays silent just because nothing has walked", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong. The reasoning
    // was "the paths come from the walk, so a stall with nothing recorded has
    // nothing to name" — true of the data, false as a behavior, because on a
    // jammed vault the walk may never be asked for at all. A real Obsidian
    // then showed no notice in three runs of five. The handler asks for
    // itself now; see "walks for itself when nothing else has asked".
    const h = harness({ files: { "a.md": null } });
    h.stallFired();
    expect(h.messages()).toHaveLength(1);
  });

  it("says nothing when every file parsed", () => {
    const h = harness({ files: { "a.md": { status: "done" } } });
    h.ask();
    h.stallFired();
    expect(h.messages()).toEqual([]);
  });

  it("spares a space that does not read properties", () => {
    // A tag space is just as incomplete on a jammed vault, but this plugin is
    // not the thing that should be telling its owner so, and a notice they
    // cannot act on from a feature they are not using is noise.
    const h = harness({ files: { "a.md": null }, active: TAG_SPACE });
    h.ask();
    h.stallFired();
    expect(h.messages()).toEqual([]);
  });

  it("still tells someone with a picker open and no space active", () => {
    const h = harness({ files: { "a.md": null }, active: null, pickers: 1 });
    h.ask();
    h.stallFired();
    expect(h.messages()).toHaveLength(1);
  });

  it("arms the watcher when a walk finds holes, and not when it does not", () => {
    const jammed = harness({ files: { "a.md": null } });
    jammed.ask();
    expect(jammed.armCount()).toBe(1);

    const healthy = harness({ files: { "a.md": { status: "done" } } });
    healthy.ask();
    expect(healthy.armCount()).toBe(0);
  });

  it("names the LARGEST unparsed note, not the first one listed", () => {
    // THE REASON THIS EXISTS. In a real Obsidian the first unparsed path in
    // `getMarkdownFiles()` order was a sixty-byte note while the note jamming
    // the queue was 33 MB, and the notice told the user to move or split the
    // sixty-byte one. Vault listing order is not parse queue order.
    const h = harness({
      files: { "tiny-first.md": null, "huge.md": null, "tiny-last.md": null },
      sizes: { "tiny-first.md": 60, "huge.md": 33_000_000, "tiny-last.md": 80 },
    });
    h.ask();
    h.stallFired();
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain('The largest is "huge.md"');
    expect(h.messages()[0]).not.toContain("tiny-first.md");
  });

  it("walks for itself when nothing else has asked", () => {
    // MEASURED IN A REAL OBSIDIAN, which is the only reason this case exists.
    // `propertyUnparsed` is filled by the snapshot accessor, and the accessor
    // runs only when something asks. `SpaceController.stillReading` returns
    // early on `metadataReady() === false` WITHOUT asking, and that flag stays
    // false for the session when the plugin loads after `resolved` has fired.
    // On a 33 MB jammed vault, three runs in five therefore showed NO notice
    // at all: the feature was silent in exactly the case it exists for.
    //
    // So the stall handler asks for itself. No `ask()` here on purpose.
    const h = harness({ files: { "0000 huge.md": null, "b.md": { status: "done" } } });
    h.stallFired();
    expect(h.drawnAsks()).toBe(1);
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toContain('"0000 huge.md"');
  });

  it("does not walk again when the paths are already known", () => {
    // The walk is not free. Once the accessor has recorded holes, the stall
    // handler must use what it has rather than paying for a second one.
    const h = harness({ files: { "a.md": null } });
    h.ask();
    h.stallFired();
    expect(h.drawnAsks()).toBe(0);
    expect(h.messages()).toHaveLength(1);
  });

  it("records and re-arms on a LATER ask of the same accessor", () => {
    // THE MEMO BOUNDARY, and the one invariant the deleted repair wiring test
    // protected that nothing else does.
    //
    // `createLazyPropertySnapshot` memoizes, so the walk runs once per
    // accessor and every later ask gets the remembered answer. The record and
    // the re-arm sit OUTSIDE that memo on purpose: a jammed vault sends no
    // further metadata events, so the accessor in force is asked again and
    // again by whoever is still looking at a property space, and those asks
    // are the only signal that somebody still cares.
    //
    // Move the two lines inside the memo and the whole suite stays green
    // without this case: every other test here builds a fresh accessor per
    // assertion and so never crosses the boundary.
    const h = harness({ files: { "a.md": null } });
    const get = h.accessor();
    get();
    expect(h.armCount()).toBe(1);
    get();
    get();
    expect(h.armCount()).toBe(3);
  });

  it("keeps the paths from the walk that found them, not from a later one", () => {
    // The accessor records `unparsed` when it builds. A second accessor built
    // over a vault that has since parsed must not leave the first one's paths
    // behind to be named by a stall that arrives afterwards.
    const files: Record<string, Record<string, unknown> | null> = { "a.md": null };
    const h = harness({ files });
    h.ask();
    files["a.md"] = { status: "done" };
    h.ask();
    h.stallFired();
    expect(h.messages()).toEqual([]);
  });
});
