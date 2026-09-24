import { describe, expect, it } from "vitest";
import {
  CORRELATION_WINDOW_MS,
  MAX_CORRELATION_BUFFER,
  correlate,
  prune,
  type VaultEventRecord,
} from "../src/lifecycle/moveCorrelator";

const T = 1_000_000;

/** A file event. Stats default to a distinctive, matchable triple. */
function ev(
  over: Partial<VaultEventRecord> & Pick<VaultEventRecord, "kind" | "path">
): VaultEventRecord {
  return { isFolder: false, size: 31, ctime: 555, mtime: 555, at: T, ...over };
}

/** A folder event: no stat at all, as measured against Obsidian 1.13.7. */
function folder(kind: "create" | "delete", path: string, at = T): VaultEventRecord {
  return { kind, path, isFolder: true, size: null, ctime: null, mtime: null, at };
}

describe("prune", () => {
  it("keeps events inside the window and drops the rest", () => {
    const buf = [
      ev({ kind: "create", path: "a.md", at: T }),
      ev({ kind: "create", path: "b.md", at: T - 99_999 }),
    ];
    expect(prune(buf, T).map((e) => e.path)).toEqual(["a.md"]);
  });

  it("keeps an event exactly at the window edge", () => {
    const buf = [ev({ kind: "create", path: "a.md", at: T - CORRELATION_WINDOW_MS })];
    expect(prune(buf, T)).toHaveLength(1);
  });
});

describe("correlate: files", () => {
  it("matches a delete against an earlier create — the measured order", () => {
    // Obsidian fires create first, 600-1000ms before the delete.
    const buffer = [ev({ kind: "create", path: "Bulk/X.md", at: T })];
    const event = ev({ kind: "delete", path: "X.md", at: T + 800 });
    expect(correlate({ buffer, event })).toEqual({ oldPath: "X.md", newPath: "Bulk/X.md" });
  });

  it("matches the other way round too, since the order is not a contract", () => {
    const buffer = [ev({ kind: "delete", path: "X.md", at: T })];
    const event = ev({ kind: "create", path: "Bulk/X.md", at: T + 800 });
    expect(correlate({ buffer, event })).toEqual({ oldPath: "X.md", newPath: "Bulk/X.md" });
  });

  it("matches an in-place rename, where the basename DIFFERS", () => {
    // Measured: a rename preserves size/ctime/mtime but not the name, so the
    // basename can never be a requirement.
    const buffer = [ev({ kind: "create", path: "Renamed.md", at: T })];
    const event = ev({ kind: "delete", path: "Original.md", at: T + 600 });
    expect(correlate({ buffer, event })).toEqual({
      oldPath: "Original.md",
      newPath: "Renamed.md",
    });
  });

  it("declines a delete with no create at all — a genuine delete", () => {
    expect(correlate({ buffer: [], event: ev({ kind: "delete", path: "X.md" }) })).toBeNull();
  });

  it("declines when the file left the vault entirely", () => {
    // Measured: moving out of the vault fires delete with NO create. The
    // correlator must not invent a destination.
    const buffer = [ev({ kind: "create", path: "Other.md", size: 999, ctime: 1, mtime: 1 })];
    expect(correlate({ buffer, event: ev({ kind: "delete", path: "X.md" }) })).toBeNull();
  });

  it("declines when two candidates match — ambiguity declines", () => {
    // Batch-copied files can share size and ctime to the millisecond. Guessing
    // would repoint membership at the wrong file, worse than losing it.
    const buffer = [
      ev({ kind: "create", path: "A/X.md" }),
      ev({ kind: "create", path: "B/X.md" }),
    ];
    expect(correlate({ buffer, event: ev({ kind: "delete", path: "X.md" }) })).toBeNull();
  });

  it("requires size, ctime AND mtime to match", () => {
    for (const differing of [{ size: 32 }, { ctime: 556 }, { mtime: 556 }]) {
      const buffer = [ev({ kind: "create", path: "Bulk/X.md", ...differing })];
      expect(correlate({ buffer, event: ev({ kind: "delete", path: "X.md" }) })).toBeNull();
    }
  });

  it("declines a partner outside the window", () => {
    const buffer = [ev({ kind: "create", path: "Bulk/X.md", at: T })];
    const event = ev({ kind: "delete", path: "X.md", at: T + CORRELATION_WINDOW_MS + 1 });
    expect(correlate({ buffer, event })).toBeNull();
  });

  it("declines a same-path pair, which is a rewrite and not a move", () => {
    // A sync client rewriting a file in place produces delete+create at the
    // SAME path. There is nothing to repair.
    const buffer = [ev({ kind: "create", path: "X.md" })];
    expect(correlate({ buffer, event: ev({ kind: "delete", path: "X.md" }) })).toBeNull();
  });

  it("ignores events of the same kind", () => {
    const buffer = [ev({ kind: "delete", path: "Bulk/X.md" })];
    expect(correlate({ buffer, event: ev({ kind: "delete", path: "X.md" }) })).toBeNull();
  });

  it("never matches on null stats", () => {
    // Folders report null; two of them must not correlate as files.
    const buffer = [
      ev({ kind: "create", path: "Bulk/X.md", size: null, ctime: null, mtime: null }),
    ];
    const event = ev({ kind: "delete", path: "X.md", size: null, ctime: null, mtime: null });
    expect(correlate({ buffer, event })).toBeNull();
  });
});

describe("correlate: folders", () => {
  /** The measured shape of an external folder move, minus the incoming event. */
  const movedTree: VaultEventRecord[] = [
    folder("create", "Bulk/Tree"),
    folder("create", "Bulk/Tree/Inner"),
    ev({ kind: "create", path: "Bulk/Tree/note.md", size: 12, ctime: 226, mtime: 226 }),
    ev({ kind: "create", path: "Bulk/Tree/Inner/deep.md", size: 9, ctime: 227, mtime: 227 }),
    folder("delete", "Bulk/Tree/Inner"),
    ev({ kind: "delete", path: "Tree/note.md", size: 12, ctime: 226, mtime: 226 }),
    ev({ kind: "delete", path: "Tree/Inner/deep.md", size: 9, ctime: 227, mtime: 227 }),
  ];

  it("derives a moved folder's mapping from a correlated descendant", () => {
    // A folder carries no stat, so it can only be identified through a child
    // whose stats do match.
    const event = folder("delete", "Tree", T + 900);
    expect(correlate({ buffer: movedTree, event })).toEqual({
      oldPath: "Tree",
      newPath: "Bulk/Tree",
    });
  });

  it("derives an external folder RENAME the same way", () => {
    const buffer: VaultEventRecord[] = [
      folder("create", "Renamed"),
      ev({ kind: "create", path: "Renamed/note.md", size: 12, ctime: 226, mtime: 226 }),
      ev({ kind: "delete", path: "Tree/note.md", size: 12, ctime: 226, mtime: 226 }),
    ];
    expect(correlate({ buffer, event: folder("delete", "Tree", T + 900) })).toEqual({
      oldPath: "Tree",
      newPath: "Renamed",
    });
  });

  it("declines an EMPTY folder, which has no descendant to key on", () => {
    const buffer = [folder("create", "Bulk/Empty")];
    expect(correlate({ buffer, event: folder("delete", "Empty", T + 900) })).toBeNull();
  });

  it("declines when descendants disagree about the destination", () => {
    const buffer: VaultEventRecord[] = [
      folder("create", "A/Tree"),
      folder("create", "B/Tree"),
      ev({ kind: "create", path: "A/Tree/one.md", size: 1, ctime: 1, mtime: 1 }),
      ev({ kind: "create", path: "B/Tree/two.md", size: 2, ctime: 2, mtime: 2 }),
      ev({ kind: "delete", path: "Tree/one.md", size: 1, ctime: 1, mtime: 1 }),
      ev({ kind: "delete", path: "Tree/two.md", size: 2, ctime: 2, mtime: 2 }),
    ];
    expect(correlate({ buffer, event: folder("delete", "Tree", T + 900) })).toBeNull();
  });

  it("requires a created folder to exist at the derived destination", () => {
    // A descendant that matches while no folder was created there means the
    // derivation is wrong, not that a folder moved.
    const buffer: VaultEventRecord[] = [
      ev({ kind: "create", path: "Bulk/Tree/note.md", size: 12, ctime: 226, mtime: 226 }),
      ev({ kind: "delete", path: "Tree/note.md", size: 12, ctime: 226, mtime: 226 }),
    ];
    expect(correlate({ buffer, event: folder("delete", "Tree", T + 900) })).toBeNull();
  });

  it("declines a created folder with no incoming delete to match", () => {
    // An inbound folder appearing from outside the vault: create only.
    expect(correlate({ buffer: [], event: folder("create", "Bulk/New", T) })).toBeNull();
  });
});

describe("prune: the length cap", () => {
  it("keeps only the newest MAX_CORRELATION_BUFFER records", () => {
    const buf: VaultEventRecord[] = [];
    for (let i = 0; i < MAX_CORRELATION_BUFFER + 200; i++) {
      buf.push(ev({ kind: "create", path: `n${i}.md`, at: T - (buf.length ? 1 : 0) }));
    }
    const kept = prune(buf, T);
    expect(kept).toHaveLength(MAX_CORRELATION_BUFFER);
    // Newest wins: the last record pushed must survive.
    expect(kept[kept.length - 1].path).toBe(`n${MAX_CORRELATION_BUFFER + 199}.md`);
    expect(kept[0].path).toBe("n200.md");
  });

  it("does not disturb a buffer under the cap", () => {
    const buf = [
      ev({ kind: "create", path: "a.md" }),
      ev({ kind: "delete", path: "b.md" }),
    ];
    expect(prune(buf, T).map((e) => e.path)).toEqual(["a.md", "b.md"]);
  });
});

describe("correlate: the folder scan is bounded", () => {
  /**
   * `filePairs` is O(B^2) per folder delete: 2,040 events measured at 281 ms.
   * The cap makes the cost independent of burst size, so an oversized buffer
   * handed in directly is still bounded.
   */
  it("bounds the O(B^2) pair scan even when handed an oversized buffer", () => {
    const buffer: VaultEventRecord[] = [];
    for (let i = 0; i < 6000; i++) {
      buffer.push(
        ev({ kind: i % 2 ? "create" : "delete", path: `Bulk/f${i}.md`, size: i, ctime: i, mtime: i })
      );
    }
    const started = Date.now();
    correlate({ buffer, event: folder("delete", "Tree", T) });
    // 6,000 unbounded is ~9x the 2,040/281 ms measurement, so roughly 2.5 s.
    // Capped it is ~1 ms. The bound was 60 ms, which measured the machine as
    // well as the cap: under a full parallel suite run this took 362 ms on an
    // otherwise idle laptop and failed twice, while passing every time the
    // file ran alone. 500 ms is still far below the uncapped cost, so a
    // regression in the cap fails just as loudly, and scheduling noise no
    // longer decides the result.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("still correlates a folder move whose descendants are inside the cap", () => {
    const buffer: VaultEventRecord[] = [
      folder("create", "Bulk/Tree", T),
      ev({ kind: "create", path: "Bulk/Tree/note.md", size: 12, ctime: 226, mtime: 226 }),
      ev({ kind: "delete", path: "Tree/note.md", size: 12, ctime: 226, mtime: 226 }),
    ];
    expect(correlate({ buffer, event: folder("delete", "Tree", T + 900) })).toEqual({
      oldPath: "Tree",
      newPath: "Bulk/Tree",
    });
  });
});
