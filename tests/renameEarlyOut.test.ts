// @vitest-environment jsdom
/**
 * The rename early-out, made to match the comment above it.
 *
 * Both vault handlers in `main.ts` (`vault.on("rename")` and
 * `repairIfMoved`) skip the write when a rename touches nothing spaces
 * stores, and both comments call that read "a cheap early-out". It was not
 * cheap: it built a whole repaired document with `repairOnRename` and then ran
 * two whole-document `JSON.stringify`s to compare it.
 *
 * V3's measurement is the reason this is a comment-correctness fix and not an
 * emergency: 0.2 ms at 67 KB and 13.2 ms at 3.94 MB, and R10's 3.1 MB figure
 * (and the ~11 s extrapolation built on it) could not be reproduced. So the
 * exact comparison is KEPT as the fallback and nothing about the decision
 * changes; `renameTouchesDefs` is only allowed to say "provably nothing to do".
 *
 * The tests below are about that one-directional guarantee. A predicate that
 * looked only at member paths — the obvious version — passes the first three
 * cases and fails the `root` and order-map ones, which is what makes them
 * worth writing.
 *
 * Layer 1 in substance (pure functions over plain data); jsdom only because
 * importing `main.ts` pulls in modules that touch `document` at import time.
 */
import { describe, expect, it } from "vitest";
import { renameTouchesDefs, sameDefs } from "../src/main";
import { repairOnRename } from "../src/lifecycle/pathRepair";
import { DEFAULT_DEFINITIONS, type SpacesDefinitions } from "../src/types";

function defsWith(patch: Partial<SpacesDefinitions>): SpacesDefinitions {
  return { ...structuredClone(DEFAULT_DEFINITIONS), ...patch };
}

const RESEARCH = {
  id: "research",
  name: "Research",
  icon: "microscope",
  color: "#4ecdc4",
};

/** The property the early-out has to hold: "false" must mean "provably equal". */
function repairIsNoOp(
  defs: SpacesDefinitions,
  oldPath: string,
  newPath: string
): boolean {
  return sameDefs(defs, repairOnRename(defs, oldPath, newPath));
}

describe("renameTouchesDefs", () => {
  it("returns false for a rename that touches nothing stored", () => {
    const defs = defsWith({
      spaces: [{ ...RESEARCH, members: [{ path: "Papers/A.md", kind: "file" }] }],
    });
    expect(renameTouchesDefs(defs, "Inbox/scratch.md", "Inbox/notes.md")).toBe(false);
    expect(repairIsNoOp(defs, "Inbox/scratch.md", "Inbox/notes.md")).toBe(true);
  });

  it("returns true when a member path IS the renamed path", () => {
    const defs = defsWith({
      spaces: [{ ...RESEARCH, members: [{ path: "Papers/A.md", kind: "file" }] }],
    });
    expect(renameTouchesDefs(defs, "Papers/A.md", "Papers/B.md")).toBe(true);
    expect(repairIsNoOp(defs, "Papers/A.md", "Papers/B.md")).toBe(false);
  });

  it("returns true when a member path is UNDER the renamed folder", () => {
    const defs = defsWith({
      spaces: [{ ...RESEARCH, members: [{ path: "Papers/A.md", kind: "file" }] }],
    });
    expect(renameTouchesDefs(defs, "Papers", "Journals")).toBe(true);
    expect(repairIsNoOp(defs, "Papers", "Journals")).toBe(false);
  });

  it("does not mistake a sibling that merely shares a name prefix", () => {
    // "Papers2/A.md" is not under "Papers", and a bare `startsWith(oldPath)`
    // would say it is — which would spend the full comparison on every rename
    // of any folder whose name prefixes another.
    const defs = defsWith({
      spaces: [{ ...RESEARCH, members: [{ path: "Papers2/A.md", kind: "file" }] }],
    });
    expect(renameTouchesDefs(defs, "Papers", "Journals")).toBe(false);
    expect(repairIsNoOp(defs, "Papers", "Journals")).toBe(true);
  });

  it("returns true when only a space's `root` is affected", () => {
    // `repairOnRename` rewrites `root` too, so a predicate that read
    // members alone would skip a repair the code performs.
    const defs = defsWith({
      spaces: [{ ...RESEARCH, root: "Papers", members: [] }],
    });
    expect(renameTouchesDefs(defs, "Papers", "Journals")).toBe(true);
    expect(repairIsNoOp(defs, "Papers", "Journals")).toBe(false);
  });

  it("returns true when only an EXCLUSION names the renamed path", () => {
    // The half that would otherwise do nothing at all. `repairOnRename`
    // rewrites `exclude`, so a predicate that read `root` and the member
    // paths alone would early-out and leave the exclusion pointing at a path
    // the note has left: the note reappears in the space, and whatever later
    // occupies the old path is excluded in its place.
    const defs = defsWith({
      spaces: [{ ...RESEARCH, exclude: ["Papers/A.md"], members: [] }],
    });
    expect(renameTouchesDefs(defs, "Papers/A.md", "Papers/B.md")).toBe(true);
    expect(repairIsNoOp(defs, "Papers/A.md", "Papers/B.md")).toBe(false);
  });

  it("returns true when an exclusion sits UNDER the renamed folder", () => {
    const defs = defsWith({
      spaces: [{ ...RESEARCH, exclude: ["Papers/A.md"], members: [] }],
    });
    expect(renameTouchesDefs(defs, "Papers", "Journals")).toBe(true);
    expect(repairIsNoOp(defs, "Papers", "Journals")).toBe(false);
  });

  it("returns true when only an order map KEY is affected", () => {
    // Order lists are keyed BY FOLDER PATH, so a folder rename rewrites
    // keys as well as entries. Nothing in `spaces` mentions the path here.
    const defs = defsWith({
      spaces: [{ ...RESEARCH, members: [] }],
      orders: { all: { Papers: ["Papers/A.md"] } },
    });
    expect(renameTouchesDefs(defs, "Papers", "Journals")).toBe(true);
    expect(repairIsNoOp(defs, "Papers", "Journals")).toBe(false);
  });

  it("returns true when only a per-space order ENTRY is affected", () => {
    const defs = defsWith({
      spaces: [{ ...RESEARCH, members: [] }],
      orders: { bySpaceId: { research: { Papers: ["Papers/A.md", "Papers/B.md"] } } },
    });
    expect(renameTouchesDefs(defs, "Papers/A.md", "Papers/Z.md")).toBe(true);
    expect(repairIsNoOp(defs, "Papers/A.md", "Papers/Z.md")).toBe(false);
  });

  it("returns true when an order entry already sits at the DESTINATION path", () => {
    // The move branch drops `newPath` from the source folder's list when
    // the parent changed — a change with no rewrite anywhere, so a predicate
    // that only looked for `oldPath` would skip it.
    const defs = defsWith({
      spaces: [{ ...RESEARCH, members: [] }],
      orders: { all: { Papers: ["Journals/A.md"] } },
    });
    expect(renameTouchesDefs(defs, "Papers/A.md", "Journals/A.md")).toBe(true);
    expect(repairIsNoOp(defs, "Papers/A.md", "Journals/A.md")).toBe(false);
  });

  it("never says 'nothing to do' when the repair would change the document", () => {
    // The guarantee stated as a sweep: over every combination of a small
    // corpus, `false` implies the repair is a no-op. The reverse is allowed —
    // `true` only costs the exact comparison that used to run unconditionally.
    const corpus: SpacesDefinitions[] = [
      defsWith({ spaces: [] }),
      defsWith({ spaces: [{ ...RESEARCH, members: [{ path: "Papers", kind: "folder" }] }] }),
      defsWith({ spaces: [{ ...RESEARCH, root: "Papers/Sub", members: [] }] }),
      defsWith({
        spaces: [{ ...RESEARCH, members: [{ path: "Papers/A.md", kind: "file" }] }],
        orders: { all: { "": ["Papers"], Papers: ["Papers/A.md"] } },
      }),
      defsWith({
        spaces: [{ ...RESEARCH, members: [] }],
        orders: { bySpaceId: { research: { Papers: ["Papers/A.md"] } } },
      }),
      defsWith({
        spaces: [
          { ...RESEARCH, exclude: ["Papers/A.md", "Papers/Sub/B.md"], members: [] },
        ],
      }),
    ];
    const renames: [string, string][] = [
      ["Papers", "Journals"],
      ["Papers/A.md", "Papers/B.md"],
      ["Papers/A.md", "Journals/A.md"],
      ["Papers/Sub", "Papers/Other"],
      ["Inbox/x.md", "Inbox/y.md"],
      ["Papers2", "Papers3"],
      ["", "Papers"],
    ];
    for (const defs of corpus) {
      for (const [oldPath, newPath] of renames) {
        if (renameTouchesDefs(defs, oldPath, newPath)) continue;
        expect(
          repairIsNoOp(defs, oldPath, newPath),
          `skipped a real repair: ${JSON.stringify(defs)} ${oldPath} -> ${newPath}`
        ).toBe(true);
      }
    }
  });
});
