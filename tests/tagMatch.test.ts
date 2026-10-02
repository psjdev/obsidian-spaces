import { describe, expect, it } from "vitest";
import { normalizeTag, tagMatches } from "../src/visibility/tagMatch";

describe("normalizeTag", () => {
  it("drops one leading hash", () => {
    expect(normalizeTag("#project")).toBe("project");
  });

  it("lowercases, so stored and note spellings meet", () => {
    expect(normalizeTag("#Project/Atlas")).toBe("project/atlas");
  });

  it("trims surrounding whitespace from a typed value", () => {
    expect(normalizeTag("  #project  ")).toBe("project");
  });

  it("leaves an already bare tag alone", () => {
    expect(normalizeTag("project")).toBe("project");
  });
});

describe("tagMatches", () => {
  it("matches the tag itself", () => {
    expect(tagMatches("project", "project")).toBe(true);
  });

  it("matches a nested tag under it", () => {
    expect(tagMatches("project", "project/atlas")).toBe(true);
  });

  it("matches a tag nested several levels down", () => {
    expect(tagMatches("project", "project/atlas/phase1")).toBe(true);
  });

  // The one that a startsWith implementation gets wrong.
  it("does not match a tag that merely starts with the same letters", () => {
    expect(tagMatches("proj", "project")).toBe(false);
  });

  it("does not match a parent of the member tag", () => {
    expect(tagMatches("project/atlas", "project")).toBe(false);
  });

  it("does not match an unrelated tag", () => {
    expect(tagMatches("project", "person")).toBe(false);
  });
});
