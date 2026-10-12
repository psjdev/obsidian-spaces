import { describe, expect, it } from "vitest";
import { createPropertyIndex } from "../src/visibility/PropertyIndex";

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

  it("does not answer for an inherited key", () => {
    expect(createPropertyIndex([entry("a.md", { x: 1 })], 1).pathsWithKey("constructor")).toEqual([]);
  });
});
