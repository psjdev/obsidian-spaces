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

  const active = "active" in opts ? opts.active : PROPERTY_SPACE;
  record.controller = {
    activeSpace: () => active,
    setPropertySnapshot: () => undefined,
    refresh: () => undefined,
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

  it("says nothing before anything has walked", () => {
    // The paths come from the walk. A stall that latches before any property
    // consumer has asked has nothing to name, and guessing would be worse
    // than silence.
    const h = harness({ files: { "a.md": null } });
    h.stallFired();
    expect(h.messages()).toEqual([]);
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
