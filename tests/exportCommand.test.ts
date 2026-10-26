import { describe, expect, it } from "vitest";
import type { MemberKind, SpaceDefinition, VisibilityDecision } from "../src/types";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildFakeVault } from "./helpers/fakeVault";
import { fakeExportSink, type FakeExportSink } from "./helpers/fakeExportSink";
import { MANIFEST_FILENAME } from "../src/export/spaceManifest";
import { blockedMessage } from "../src/export/exportCopy";
import { type ExportContext, exportSpace } from "../src/export/exportCommand";

const space: SpaceDefinition = {
  id: "kitchen",
  name: "Kitchen",
  icon: "hammer",
  color: "#ff6b6b",
  members: [{ path: "Reading/book.md", kind: "file" }],
};

/** A manifest recording THIS space, which is what makes a replace safe. */
const OUR_MANIFEST = JSON.stringify({ space: { id: "kitchen" } });
/** A manifest recording a DIFFERENT space that shares the folder name. */
const OTHER_MANIFEST = JSON.stringify({ space: { id: "reading" } });

const tree: Record<string, MemberKind> = { Reading: "folder", "Reading/book.md": "file" };

const snapshot: VisibilitySnapshot = {
  visiblePaths: () => new Set(["Reading/book.md"]),
  decisionFor: (): VisibilityDecision => ({
    visible: true,
    reason: "exact-member",
    canRemoveMembership: true,
    overridesIgnore: false,
  }),
};

interface Harness {
  ctx: ExportContext;
  notices: string[];
  sinkRoots: string[];
  confirmedPaths: string[];
  sinks: FakeExportSink[];
}

function harness(
  over: Partial<ExportContext> = {},
  sinkOpts: { seed?: (s: FakeExportSink) => void; answer?: boolean } = {}
): Harness {
  // The answer, kept apart from the recorder: overriding `confirm` to say
  // no would otherwise replace the recording and every assertion about
  // what the user was ASKED would quietly see nothing.
  const answer = sinkOpts.answer ?? true;
  const notices: string[] = [];
  const sinkRoots: string[] = [];
  const confirmedPaths: string[] = [];
  const sinks: FakeExportSink[] = [];
  const ctx: ExportContext = {
    space,
    snapshot,
    vault: buildFakeVault(tree),
    order: undefined,
    links: {},
    isIgnored: () => false,
    isExcluded: () => false,
    vaultBasePath: "C:/Notes/Vault",
    parseProgress: () => 0,
    rootMissing: false,
    pickDir: async () => "C:/Users/x/Desktop",
    realpath: async (p) => p,
    confirm: async (prompt) => {
      confirmedPaths.push(prompt.body);
      return answer;
    },
    makeSink: (rootDir) => {
      sinkRoots.push(rootDir);
      const s = fakeExportSink();
      sinkOpts.seed?.(s);
      sinks.push(s);
      return s;
    },
    readBinary: async () => new TextEncoder().encode("x"),
    notify: (m) => notices.push(m),
    now: () => new Date("2026-10-25T10:00:00Z"),
    ...over,
  };
  return { ctx, notices, sinkRoots, confirmedPaths, sinks };
}

describe("exportSpace: the guards, in order", () => {
  it("refuses when no space is active", async () => {
    const h = harness({ space: null });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("no-space")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("refuses when the snapshot is not ready", async () => {
    const h = harness({ snapshot: null });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("indexing")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("refuses while the metadata cache is still parsing", async () => {
    // The snapshot is NOT null for a curated space during a cold parse, so
    // the check above does not cover this. Without it the export ships
    // every note with none of its images and reports success.
    const h = harness({ parseProgress: () => 3 });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("indexing")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("proceeds when parse progress is unavailable", async () => {
    // null means the private API is not shaped as expected. Fail open, as
    // the rest of the plugin does with this signal.
    const h = harness({ parseProgress: () => null });
    await exportSpace(h.ctx);
    expect(h.sinkRoots).toHaveLength(1);
  });

  it("refuses a folder space whose root is missing", async () => {
    const h = harness({ rootMissing: true });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("missing-root")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("treats a cancelled picker as cancelled, however it says so", async () => {
    // showOpenDialog yields filePaths[0] === undefined on cancel, not null.
    for (const v of [null, undefined, ""] as const) {
      const h = harness({ pickDir: async () => v });
      await exportSpace(h.ctx);
      expect(h.sinkRoots).toEqual([]);
      expect(h.notices).toEqual([]);
    }
  });
});

describe("exportSpace: where it writes", () => {
  it("roots the sink at the chosen folder plus the space's name", async () => {
    // Mis-wiring this to the chosen folder would delete everything the user
    // picked, and every other test here would stay green.
    const h = harness();
    await exportSpace(h.ctx);
    expect(h.sinkRoots).toEqual(["C:/Users/x/Desktop/Kitchen"]);
  });

  it("sanitises the space name into the folder", async () => {
    const h = harness({ space: { ...space, name: "a/b" } });
    await exportSpace(h.ctx);
    expect(h.sinkRoots).toEqual(["C:/Users/x/Desktop/a-b"]);
  });

  it("refuses a destination that RESOLVES onto the vault", async () => {
    // The vault-deletion path: pick the vault's parent, name the space
    // after the vault folder.
    const h = harness({
      pickDir: async () => "C:/Notes",
      space: { ...space, name: "Vault" },
    });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("inside-vault")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("resolves links before judging the destination", async () => {
    // A junction pointing into the vault defeats a pure string compare.
    const h = harness({ realpath: async () => "C:/Notes/Vault/Exports" });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("inside-vault")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("refuses when the vault path is unknown", async () => {
    const h = harness({ vaultBasePath: null });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("unknown-vault")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("refuses when the plan reports a collision", async () => {
    const h = harness({
      vault: buildFakeVault({ "Notes/README.md": "file", "Notes/readme.md": "file" }),
      snapshot: {
        visiblePaths: () => new Set(["Notes/README.md", "Notes/readme.md"]),
        decisionFor: (): VisibilityDecision => ({
          visible: true,
          reason: "exact-member",
          canRemoveMembership: true,
          overridesIgnore: false,
        }),
      },
    });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("collision")]);
    // Refusing AFTER the destination was replaced would delete a previous
    // export and then decline to write a new one.
    expect(h.sinkRoots).toEqual([]);
  });
});

describe("exportSpace: resolving the destination", () => {
  it("resolves the EXPORT folder, not only the folder that was picked", async () => {
    // A junction at <chosen>/<SpaceName> is a different link from one on
    // its parent. Resolving only the parent left it able to point into the
    // vault while the check looked at an unresolved last segment.
    const h = harness({
      realpath: async (p) =>
        p === "C:/Users/x/Desktop/Kitchen" ? "C:/Notes/Vault/sneaky" : p,
    });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("inside-vault")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("resolves the vault path too, so the comparison is symmetric", async () => {
    // The vault reached through a junction spells differently from the
    // vault reached directly; comparing one resolved path against one raw
    // one lets the export write inside it.
    const h = harness({
      vaultBasePath: "C:/VaultLink",
      realpath: async (p) => (p === "C:/VaultLink" ? "C:/Users/x/Desktop" : p),
    });
    await exportSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("inside-vault")]);
  });

  it("proceeds when the export folder does not exist yet", async () => {
    // A first export has nothing to resolve, which is not an error.
    const h = harness({
      realpath: async (p) => {
        if (p === "C:/Users/x/Desktop/Kitchen") throw new Error("ENOENT");
        return p;
      },
    });
    await exportSpace(h.ctx);
    expect(h.sinkRoots).toEqual(["C:/Users/x/Desktop/Kitchen"]);
  });

  it("roots the sink at the RESOLVED export folder", async () => {
    const h = harness({
      realpath: async (p) => (p === "C:/Users/x/Desktop/Kitchen" ? "D:/real/Kitchen" : p),
    });
    await exportSpace(h.ctx);
    expect(h.sinkRoots).toEqual(["D:/real/Kitchen"]);
  });
});

describe("exportSpace: what it hands the selector", () => {
  it("passes isIgnored through, so an ignored embed stays out", async () => {
    // Owner decision O7, wired. Replacing ctx.isIgnored with a constant
    // used to leave every test green.
    const h = harness({
      vault: buildFakeVault({ ...tree, "Private/x.png": "file" }),
      links: { "Reading/book.md": { "Private/x.png": 1 } },
      isIgnored: (p) => p.startsWith("Private/"),
    });
    await exportSpace(h.ctx);
    expect([...(h.sinks[0]?.files.keys() ?? [])]).not.toContain("Private/x.png");
  });

  it("passes links through, so an embed comes along", async () => {
    const h = harness({
      vault: buildFakeVault({ ...tree, "Attachments/x.png": "file" }),
      links: { "Reading/book.md": { "Attachments/x.png": 1 } },
    });
    await exportSpace(h.ctx);
    expect([...(h.sinks[0]?.files.keys() ?? [])]).toContain("Attachments/x.png");
  });

  it("passes isExcluded through", async () => {
    const h = harness({
      vault: buildFakeVault({ ...tree, "Attachments/x.png": "file" }),
      links: { "Reading/book.md": { "Attachments/x.png": 1 } },
      isExcluded: (p) => p === "Attachments/x.png",
    });
    await exportSpace(h.ctx);
    expect([...(h.sinks[0]?.files.keys() ?? [])]).not.toContain("Attachments/x.png");
  });

  it("passes the order and the clock into the manifest", async () => {
    const h = harness({
      order: { Reading: ["Reading/book.md"] },
      now: () => new Date("2031-01-02T03:04:05Z"),
    });
    await exportSpace(h.ctx);
    const written = h.sinks[0]?.texts.get(MANIFEST_FILENAME) ?? "";
    expect(JSON.parse(written).space.order).toEqual({ Reading: ["Reading/book.md"] });
    expect(JSON.parse(written).exportedAt).toBe("2031-01-02T03:04:05.000Z");
  });
});

describe("exportSpace: replacing", () => {
  it("does not ask when the destination does not exist", async () => {
    const h = harness();
    await exportSpace(h.ctx);
    expect(h.confirmedPaths).toEqual([]);
    expect(h.sinks[0]?.removed).toEqual([]);
  });

  it("ASKS about an empty folder that is already there, rather than refusing", async () => {
    // A folder the user made earlier is still one they made on purpose, so
    // it is put to them. Refusing left a dead end inside the plugin.
    const h = harness({}, { answer: false,
      seed: (s) => {
        void s.ensureDir("");
      },
    });
    await exportSpace(h.ctx);
    expect(h.confirmedPaths).toHaveLength(1);
    expect(h.notices).toEqual([]);
    expect(h.sinks[0]?.files.size).toBe(0);
  });

  it("asks before replacing a folder that is not an export, and says so", async () => {
    // This is the path that can eat a user's Documents folder, so the
    // prompt has to say what the folder is and how much is in it.
    const h = harness({}, { answer: false,
      seed: (s) => {
        void s.ensureDir("");
        void s.writeText("someone-elses-work.md", "mine");
      },
    });
    await exportSpace(h.ctx);
    expect(h.confirmedPaths).toHaveLength(1);
    expect(h.confirmedPaths[0]).toMatch(/is not an export/i);
    expect(h.confirmedPaths[0]).toMatch(/1 note or folder/);
    expect(h.sinks[0]?.removed).toEqual([]);
  });

  it("deletes a folder that is not an export once confirmed", async () => {
    const h = harness({}, {
      seed: (s) => {
        void s.ensureDir("");
        void s.writeText("someone-elses-work.md", "mine");
      },
    });
    await exportSpace(h.ctx);
    expect(h.sinks[0]?.removed).toEqual([""]);
    expect(h.sinks[0]?.files.has("Reading/book.md")).toBe(true);
  });

  it("asks before replacing one of our own exports, and stops on cancel", async () => {
    const h = harness({}, { answer: false,
      seed: (s) => {
        // A real destination folder exists before anything is written into
        // it; the fake enforces that now, as the filesystem does.
        void s.ensureDir("");
        void s.writeText(MANIFEST_FILENAME, OUR_MANIFEST);
      },
    });
    await exportSpace(h.ctx);
    expect(h.sinks[0]?.removed).toEqual([]);
    expect(h.sinks[0]?.files.size).toBe(0);
  });

  it("replaces one of our own exports once confirmed", async () => {
    const h = harness({}, {
      seed: (s) => {
        // A real destination folder exists before anything is written into
        // it; the fake enforces that now, as the filesystem does.
        void s.ensureDir("");
        void s.writeText(MANIFEST_FILENAME, OUR_MANIFEST);
      },
    });
    await exportSpace(h.ctx);
    expect(h.sinks[0]?.removed).toEqual([""]);
    expect(h.sinks[0]?.files.has("Reading/book.md")).toBe(true);
  });

  it("says plainly when the folder holds ANOTHER space's export", async () => {
    // "Work/2026" and "Work-2026" share a destination, so this is reachable
    // without anyone doing anything odd.
    const h = harness({}, { answer: false,
      seed: (s) => {
        void s.ensureDir("");
        void s.writeText(MANIFEST_FILENAME, OTHER_MANIFEST);
      },
    });
    await exportSpace(h.ctx);
    expect(h.confirmedPaths).toHaveLength(1);
    expect(h.confirmedPaths[0]).toMatch(/not this one/i);
    expect(h.sinks[0]?.removed).toEqual([]);
  });

  it("treats a corrupt manifest as not an export", async () => {
    const h = harness({}, { answer: false,
      seed: (s) => {
        void s.ensureDir("");
        void s.writeText(MANIFEST_FILENAME, "{ not json");
      },
    });
    await exportSpace(h.ctx);
    expect(h.confirmedPaths[0]).toMatch(/is not an export/i);
    expect(h.sinks[0]?.removed).toEqual([]);
  });

  it("shows the path it is about to delete", async () => {
    const h = harness({}, {
      seed: (s) => {
        // A real destination folder exists before anything is written into
        // it; the fake enforces that now, as the filesystem does.
        void s.ensureDir("");
        void s.writeText(MANIFEST_FILENAME, OUR_MANIFEST);
      },
    });
    await exportSpace(h.ctx);
    expect(h.confirmedPaths[0]).toContain("C:/Users/x/Desktop/Kitchen");
  });
});

describe("exportSpace: reporting", () => {
  it("reports what it copied", async () => {
    const h = harness();
    await exportSpace(h.ctx);
    expect(h.notices[0]).toContain("C:/Users/x/Desktop/Kitchen");
    expect(h.notices[0]).toContain("1");
  });

  it("reports a sink error instead of throwing", async () => {
    const h = harness({
      makeSink: () => {
        throw new Error("ENOTDIR: not a directory");
      },
    });
    await expect(exportSpace(h.ctx)).resolves.toBeUndefined();
    expect(h.notices[0]).toContain("ENOTDIR");
  });

  it("reports a realpath failure instead of throwing", async () => {
    const h = harness({
      realpath: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    await expect(exportSpace(h.ctx)).resolves.toBeUndefined();
    expect(h.notices[0]).toContain("ENOENT");
  });
});
