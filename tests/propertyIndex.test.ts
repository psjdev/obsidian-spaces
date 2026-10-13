import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { createLazyPropertySnapshot, createObsidianPropertySnapshot } from "../src/visibility/ObsidianPropertyIndex";
import { createPropertyIndex, type PropertySnapshot } from "../src/visibility/PropertyIndex";
import { normalizeValue } from "../src/visibility/propertyValues";

// Counts normalization so the tests below can tell when value buckets are built.
vi.mock("../src/visibility/propertyValues", async () => {
  const actual = await vi.importActual<typeof import("../src/visibility/propertyValues")>(
    "../src/visibility/propertyValues"
  );
  return { ...actual, normalizeValue: vi.fn(actual.normalizeValue) };
});

const entry = (path: string, frontmatter: Record<string, unknown>) => ({ path, frontmatter });

const sample = () =>
  createPropertyIndex(
    [
      entry("b.md", { status: "Active", topics: ["atlas", "billing"] }),
      entry("a.md", { status: " active ", due: null }),
      entry("c.md", { status: "done" }),
      entry("d.md", { other: { nested: 1 } }),
    ],
    7
  );

describe("the pure property index", () => {
  it("carries its generation", () => {
    expect(sample().generation).toBe(7);
  });

  it("files a key however empty or unmatchable its value", () => {
    expect(sample().pathsWithKey("due")).toEqual(["a.md"]);
    expect(sample().pathsWithKey("other")).toEqual(["d.md"]);
  });

  it("matches on normalized values", () => {
    expect(sample().pathsMatching("status", "active").sort()).toEqual(["a.md", "b.md"]);
  });

  it("matches a list on its entries", () => {
    expect(sample().pathsMatching("topics", "atlas")).toEqual(["b.md"]);
  });

  it("lists keys with counts, by count then name", () => {
    expect(sample().listKeys()).toEqual([
      { key: "status", count: 3 },
      { key: "due", count: 1 },
      { key: "other", count: 1 },
      { key: "topics", count: 1 },
    ]);
  });

  it("hands back the one key list rather than rebuilding and re-sorting it", () => {
    // The picker asks on every draw and therefore on every keystroke in its
    // filter box, and then re-sorts by name itself. Identity is the whole
    // observation: a rebuilt list would be equal and not the same object.
    const index = sample();
    expect(index.listKeys()).toBe(index.listKeys());
  });

  it("lists a key's values with a representative spelling", () => {
    // `a.md` sorts before `b.md`, so " active " is the representative and is
    // drawn as authored.
    expect(sample().listValues("status")).toEqual([
      { value: " active ", normalized: "active", count: 2 },
      { value: "done", normalized: "done", count: 1 },
    ]);
  });

  it("lists no values for a key that offers none", () => {
    expect(sample().listValues("due")).toEqual([]);
    expect(sample().listValues("other")).toEqual([]);
  });

  it("is immutable against a later mutation of its input", () => {
    const fm: Record<string, unknown> = { status: "Active", topics: ["atlas"] };
    const index = createPropertyIndex([entry("a.md", fm)], 1);
    // Force nothing: `status` has not been expanded yet.
    fm.status = "done";
    (fm.topics as string[]).push("billing");
    expect(index.pathsMatching("status", "active")).toEqual(["a.md"]);
    expect(index.pathsMatching("status", "done")).toEqual([]);
    expect(index.pathsMatching("topics", "billing")).toEqual([]);
  });

  it("treats an empty-string value as a value", () => {
    const index = createPropertyIndex([entry("a.md", { x: "" })], 1);
    expect(index.pathsMatching("x", "")).toEqual(["a.md"]);
    expect(index.listValues("x")).toEqual([{ value: "", normalized: "", count: 1 }]);
  });

  it("builds value buckets only when a key is asked about", () => {
    const calls = vi.mocked(normalizeValue);
    calls.mockClear();
    const index = sample();
    expect(calls).not.toHaveBeenCalled();
    index.listKeys();
    index.pathsWithKey("status");
    expect(calls).not.toHaveBeenCalled();
    index.listValues("topics");
    expect(calls).toHaveBeenCalled();
  });

  it("memoizes a key's buckets after the first ask", () => {
    const calls = vi.mocked(normalizeValue);
    const index = sample();
    index.listValues("status");
    calls.mockClear();
    index.listValues("status");
    expect(calls).not.toHaveBeenCalled();
    // Only the query value is normalized, never a rebuild of the bucket.
    index.pathsMatching("status", "done");
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("files a note once in a bucket it offers twice", () => {
    const index = createPropertyIndex([entry("a.md", { t: ["x", "X"] }), entry("b.md", { t: "x" })], 1);
    expect(index.pathsMatching("t", "x")).toEqual(["a.md", "b.md"]);
  });

  it("does not answer for an inherited key", () => {
    expect(createPropertyIndex([entry("a.md", { x: 1 })], 1).pathsWithKey("constructor")).toEqual([]);
  });
});

describe("readiness", () => {
  it("builds nothing until something asks", () => {
    let built = 0;
    const lazy = createLazyPropertySnapshot(() => {
      built++;
      return { status: "ready", index: createPropertyIndex([], 1) };
    });
    expect(built).toBe(0);
    expect(lazy().status).toBe("ready");
    expect(built).toBe(1);
  });

  it("reports unavailable rather than an empty index", () => {
    const lazy = createLazyPropertySnapshot(() => ({ status: "unavailable", unparsed: [] }));
    const snapshot = lazy();
    expect(snapshot.status).toBe("unavailable");
    // The caller cannot reach a query at all, which is the point: an empty
    // array must never stand in for "not ready".
    expect("index" in snapshot).toBe(false);
  });

  it("builds once and keeps answering from the same ready snapshot", () => {
    let built = 0;
    const lazy = createLazyPropertySnapshot(() => {
      built++;
      return { status: "ready", index: createPropertyIndex([], 2) };
    });
    const first = lazy();
    expect(lazy()).toBe(first);
    expect(built).toBe(1);
  });

  it("keeps an unavailable answer too, so one burst never builds twice", () => {
    // A burst asks twice: `runFlush` notifies the pickers and then recomputes
    // the space. While any note is unparsed both asks used to walk the vault
    // and both returned nothing.
    let built = 0;
    const lazy = createLazyPropertySnapshot((): PropertySnapshot => {
      built++;
      return { status: "unavailable", unparsed: [] };
    });
    expect(lazy().status).toBe("unavailable");
    expect(lazy().status).toBe("unavailable");
    expect(built).toBe(1);
  });

  it("retries through a NEW accessor, so a warming cache is not unavailable forever", () => {
    // What drops the kept answer is the next metadata event, which installs a
    // fresh accessor (`main.ts`), never a second ask of this one.
    let built = 0;
    const build = (): PropertySnapshot => {
      built++;
      return built === 1
        ? { status: "unavailable", unparsed: [] }
        : { status: "ready", index: createPropertyIndex([], 3) };
    };
    expect(createLazyPropertySnapshot(build)().status).toBe("unavailable");
    const warmed = createLazyPropertySnapshot(build);
    expect(warmed().status).toBe("ready");
    expect(warmed().status).toBe("ready");
    expect(built).toBe(2);
  });
});

describe("createObsidianPropertySnapshot", () => {
  type Cache = { frontmatter?: Record<string, unknown> } | null;
  const fakeApp = (files: Array<{ path: string; cache: Cache }>): App =>
    ({
      vault: { getMarkdownFiles: () => files.map((f) => ({ path: f.path })) },
      metadataCache: {
        getFileCache: (file: { path: string }) => files.find((f) => f.path === file.path)!.cache,
      },
    }) as unknown as App;

  it("is unavailable when a cache not yet parsed comes last in the walk", () => {
    const snapshot = createObsidianPropertySnapshot(
      fakeApp([
        { path: "a.md", cache: { frontmatter: { x: 1 } } },
        { path: "b.md", cache: { frontmatter: { x: 2 } } },
        { path: "c.md", cache: null },
      ]),
      1
    );
    expect(snapshot.status).toBe("unavailable");
    expect("index" in snapshot).toBe(false);
  });

  it("lets a note with a cache but no frontmatter contribute nothing", () => {
    const snapshot = createObsidianPropertySnapshot(
      fakeApp([
        { path: "a.md", cache: {} },
        { path: "b.md", cache: { frontmatter: { x: 1 } } },
      ]),
      1
    );
    expect(snapshot.status).toBe("ready");
    if (snapshot.status !== "ready") return;
    expect(snapshot.index.pathsWithKey("x")).toEqual(["b.md"]);
  });

  it("carries the generation it was given into the index", () => {
    const snapshot = createObsidianPropertySnapshot(fakeApp([{ path: "a.md", cache: {} }]), 7);
    expect(snapshot.status === "ready" && snapshot.index.generation).toBe(7);
  });
});
