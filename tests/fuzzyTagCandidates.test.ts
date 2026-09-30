/**
 * What the create panel's `#` picker offers, and in what order.
 *
 * Kept apart from `tagCandidates.test.ts` because the two answer different
 * questions with the same source: that one is the add-a-tag field's substring
 * filter, this one is the picker's ranked search.
 *
 * Layer 1. The scorer is injected, exactly as `spaceSuggest.test.ts` injects
 * one, so nothing here needs `prepareFuzzySearch` — which the stub cannot
 * reproduce and deliberately refuses to imitate. What is asserted is
 * everything AROUND the scoring: which tags are put in front of it, in what
 * spelling, what a null source does, and how ties are broken.
 */

import { describe, expect, it } from "vitest";
import { fuzzyTagCandidates, type TagSource } from "../src/ui/tagCandidates";

/** A source holding the tags Obsidian would hand over, `#` and all. */
const from = (tags: string[]): TagSource => ({ knownTags: () => tags });

interface Score {
  score: number;
}

/**
 * A stand-in for `prepareFuzzySearch`: a subsequence test, scoring an earlier
 * first match higher. Not Obsidian's algorithm and not trying to be — it only
 * has to be a plausible scorer whose output a test can predict.
 */
const subsequence =
  (query: string) =>
  (text: string): Score | null => {
    let at = -1;
    let first = -1;
    for (const ch of query) {
      at = text.indexOf(ch, at + 1);
      if (at < 0) return null;
      if (first < 0) first = at;
    }
    return { score: 100 - first };
  };

/** Every scorer call, so a test can see what was offered for scoring. */
const recording = (): { make: (q: string) => (t: string) => Score | null; queries: string[] } => {
  const queries: string[] = [];
  return {
    queries,
    make: (q) => {
      queries.push(q);
      return subsequence(q);
    },
  };
};

const tagsOf = <M,>(hits: { tag: string }[] | null): string[] | null =>
  hits === null ? null : hits.map((h) => h.tag);

describe("fuzzyTagCandidates", () => {
  it("scores the normalized query, not the characters typed", () => {
    // The user types the `#` they see everywhere else in Obsidian, in whatever
    // case they like. The stored spelling is bare and lowercase, so a scorer
    // handed the raw text would miss on both counts. Normalizing HERE rather
    // than at the call site is why this function takes a factory.
    const rec = recording();
    fuzzyTagCandidates(from(["#project"]), "#PROJ", rec.make);
    expect(rec.queries).toEqual(["proj"]);
  });

  it("offers the stored spelling, so what is picked is what is written", () => {
    // Tags are stored without a leading `#`. A hit carrying `#Project` would
    // put both the `#` and the case into `members`, where nothing else
    // expects either.
    expect(tagsOf(fuzzyTagCandidates(from(["#Project"]), "proj", subsequence))).toEqual([
      "project",
    ]);
  });

  it("matches a subsequence across segments, which a substring filter cannot", () => {
    // The whole reason the picker ranks instead of filtering: `proj/con` is
    // how you would type your way to `projects/console`, and
    // `tagCandidates`'s substring test rejects it outright.
    expect(
      tagsOf(fuzzyTagCandidates(from(["#projects/console", "#archive"]), "projcon", subsequence))
    ).toEqual(["projects/console"]);
  });

  it("puts the better score first, whatever the alphabet says", () => {
    // `zeta` beats `alphabeta` on this scorer because its matched characters
    // are adjacent. Alphabetical order would have inverted it, so this is the
    // assertion that the ranking is actually applied.
    const hits = fuzzyTagCandidates(from(["#alphabeta", "#zeta"]), "eta", subsequence);
    expect(tagsOf(hits)).toEqual(["zeta", "alphabeta"]);
  });

  it("breaks a tie alphabetically rather than by enumeration order", () => {
    // Equal scores must not reshuffle between keystrokes that changed no
    // score. The source is handed them in the wrong order on purpose.
    const hits = fuzzyTagCandidates(from(["#archive", "#alpha", "#anchor"]), "a", subsequence);
    expect(hits?.map((h) => h.match?.score)).toEqual([100, 100, 100]);
    expect(tagsOf(hits)).toEqual(["alpha", "anchor", "archive"]);
  });

  it("drops what the scorer rejects", () => {
    expect(tagsOf(fuzzyTagCandidates(from(["#project", "#archive"]), "zzz", subsequence))).toEqual(
      []
    );
  });

  it("browses on an empty query instead of searching", () => {
    // A bare `#` is how someone finds out what the vault holds. Scoring
    // against nothing would order the list by nothing, so the whole set comes
    // back alphabetically with no match to highlight.
    const rec = recording();
    const hits = fuzzyTagCandidates(from(["#zeta", "#alpha"]), "", rec.make);
    expect(tagsOf(hits)).toEqual(["alpha", "zeta"]);
    expect(hits?.map((h) => h.match)).toEqual([null, null]);
    // Not merely unused: never built.
    expect(rec.queries).toEqual([]);
  });

  it("carries the scorer's result through, for the caller to highlight with", () => {
    // `renderResults` needs the match itself, not a boolean. Losing it here
    // would cost the highlighted characters that make this read like the
    // quick switcher.
    const hits = fuzzyTagCandidates(from(["#project"]), "proj", subsequence);
    expect(hits?.[0]?.match).toEqual({ score: 100 });
  });

  it("collapses two spellings of one tag to the single entry that gets stored", () => {
    expect(tagsOf(fuzzyTagCandidates(from(["#Project", "#project"]), "proj", subsequence))).toEqual(
      ["project"]
    );
  });

  it("drops a bare # rather than offering a nameless row", () => {
    expect(tagsOf(fuzzyTagCandidates(from(["#", "#project"]), "", subsequence))).toEqual([
      "project",
    ]);
  });

  it("caps AFTER ranking, so the cap takes the best matches", () => {
    // Capping the alphabetical set first would throw away the best hit
    // whenever it happened to sort late, which is the failure a cap is most
    // likely to hide.
    const hits = fuzzyTagCandidates(from(["#alphabeta", "#zeta"]), "eta", subsequence, 1);
    expect(tagsOf(hits)).toEqual(["zeta"]);
  });

  it("caps at 50 by default", () => {
    const many = Array.from({ length: 200 }, (_, i) => `#tag${String(i).padStart(3, "0")}`);
    expect(fuzzyTagCandidates(from(many), "", subsequence)).toHaveLength(50);
    expect(fuzzyTagCandidates(from(many), "tag", subsequence)).toHaveLength(50);
  });

  it("reports null when the source cannot say, rather than an empty list", () => {
    // `nativeKnownTags` reports a missing private `getTags` by RETURNING
    // null. The picker has a different thing to say for each case, so the two
    // must not arrive looking alike.
    expect(fuzzyTagCandidates({ knownTags: () => null }, "proj", subsequence)).toBeNull();
  });

  it("offers an empty list when the vault genuinely has no tags", () => {
    expect(fuzzyTagCandidates(from([]), "", subsequence)).toEqual([]);
  });
});
