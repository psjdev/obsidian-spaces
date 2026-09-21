import { describe, expect, it } from "vitest";
import { EMPTY_QUERY_SPACES, spaceSuggestions } from "../src/ui/spaceSuggest";
import type { SpaceEntry } from "../src/ui/spaceEntries";

/** A stand-in for what `prepareFuzzySearch` hands back: only `score` is read. */
interface Score {
  score: number;
}

const all: SpaceEntry = {
  key: { kind: "all" },
  icon: "layers",
  label: "All",
  color: undefined,
  active: true,
};

function space(label: string): SpaceEntry {
  return {
    key: { kind: "space", id: label.toLowerCase() },
    icon: "leaf",
    label,
    color: "#4ecdc4",
    active: false,
  };
}

/** `spaceEntries` guarantees *All* first, which the empty-query slice relies on. */
function entries(...labels: string[]): SpaceEntry[] {
  return [all, ...labels.map(space)];
}

/** Scores by substring position: earlier match scores higher. Null for no match. */
function substring(query: string): (text: string) => Score | null {
  return (text) => {
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    // Positive, so an index-0 match does not produce -0 and trip toEqual.
    return at === -1 ? null : { score: 100 - at };
  };
}

/** Every entry matches, all with the same score, so only the tie-break orders them. */
const allTie = (): Score => ({ score: 1 });

const labelsOf = (out: { entry: SpaceEntry }[]): string[] => out.map((s) => s.entry.label);

describe("the empty query", () => {
  it("shows All and the first five spaces", () => {
    const out = spaceSuggestions(entries("a", "b", "c", "d", "e", "f", "g"), "", substring("x"));
    expect(labelsOf(out)).toEqual(["All", "a", "b", "c", "d", "e"]);
    expect(out).toHaveLength(EMPTY_QUERY_SPACES + 1);
  });

  it("does not truncate a vault that has five spaces or fewer", () => {
    // The common case: the whole set fits, so nothing is hidden behind the cap.
    const out = spaceSuggestions(entries("a", "b", "c", "d", "e"), "", substring("x"));
    expect(labelsOf(out)).toEqual(["All", "a", "b", "c", "d", "e"]);
  });

  it("shows All alone in a vault with no spaces", () => {
    expect(labelsOf(spaceSuggestions(entries(), "", substring("x")))).toEqual(["All"]);
  });

  it("treats a whitespace-only query as empty", () => {
    // Otherwise a stray space bar blanks the list: no name contains " ".
    const out = spaceSuggestions(entries("a", "b"), "   ", substring("   "));
    expect(labelsOf(out)).toEqual(["All", "a", "b"]);
  });

  it("scores nothing, because an empty query is not a search", () => {
    const out = spaceSuggestions(entries("a"), "", substring("x"));
    expect(out.every((s) => s.match === null)).toBe(true);
  });
});

describe("searching", () => {
  it("returns only the entries that match", () => {
    const out = spaceSuggestions(entries("Garden", "Inbox", "Gardening"), "gard", substring("gard"));
    expect(labelsOf(out)).toEqual(["Garden", "Gardening"]);
  });

  it("finds All by typing, like any other entry", () => {
    // All is not special-cased out of the search; it is the most common
    // destination and typing "all" must reach it.
    expect(labelsOf(spaceSuggestions(entries("Inbox"), "all", substring("all")))).toEqual(["All"]);
  });

  it("is not capped once a query is typed", () => {
    const many = entries(...Array.from({ length: 20 }, (_, i) => `Space ${i}`));
    expect(spaceSuggestions(many, "space", substring("space"))).toHaveLength(20);
  });

  it("puts the better score first, whatever the strip order", () => {
    // "Garden" matches at index 0, "My Garden" at index 3, so the later
    // definition wins on score and must overtake it.
    const out = spaceSuggestions(entries("My Garden", "Garden"), "garden", substring("garden"));
    expect(labelsOf(out)).toEqual(["Garden", "My Garden"]);
  });

  it("breaks equal scores by strip order, so results do not reshuffle", () => {
    const out = spaceSuggestions(entries("Zebra", "Apple", "Mango"), "x", allTie);
    expect(labelsOf(out)).toEqual(["All", "Zebra", "Apple", "Mango"]);
  });

  it("returns nothing when no name matches", () => {
    expect(spaceSuggestions(entries("Garden"), "zzz", substring("zzz"))).toEqual([]);
  });

  it("carries the match through, so the caller can highlight it", () => {
    const out = spaceSuggestions(entries("Garden"), "gard", substring("gard"));
    expect(out[0]?.match).toEqual({ score: 100 });
  });
});
