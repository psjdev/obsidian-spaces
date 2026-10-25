import { describe, expect, it } from "vitest";
import type { MemberKind, SpaceDefinition, VisibilityDecision } from "../src/types";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildFakeVault } from "./helpers/fakeVault";
import { fakeExportSink, type FakeExportSink } from "./helpers/fakeExportSink";
import { MANIFEST_FILENAME } from "../src/export/spaceManifest";
import { blockedMessage } from "../src/export/exportCopy";
import { type ExportContext, exportActiveSpace } from "../src/export/exportCommand";

const space: SpaceDefinition = {
  id: "kitchen",
  name: "Kitchen",
  icon: "hammer",
  color: "#ff6b6b",
  members: [{ path: "Reading/book.md", kind: "file" }],
};

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

function harness(over: Partial<ExportContext> = {}, sinkOpts: { seed?: (s: FakeExportSink) => void } = {}): Harness {
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
      return true;
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

describe("exportActiveSpace: the guards, in order", () => {
  it("refuses when no space is active", async () => {
    const h = harness({ space: null });
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("no-space")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("refuses when the snapshot is not ready", async () => {
    const h = harness({ snapshot: null });
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("indexing")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("refuses while the metadata cache is still parsing", async () => {
    // The snapshot is NOT null for a curated space during a cold parse, so
    // the check above does not cover this. Without it the export ships
    // every note with none of its images and reports success.
    const h = harness({ parseProgress: () => 3 });
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("indexing")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("proceeds when parse progress is unavailable", async () => {
    // null means the private API is not shaped as expected. Fail open, as
    // the rest of the plugin does with this signal.
    const h = harness({ parseProgress: () => null });
    await exportActiveSpace(h.ctx);
    expect(h.sinkRoots).toHaveLength(1);
  });

  it("refuses a folder space whose root is missing", async () => {
    const h = harness({ rootMissing: true });
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("missing-root")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("treats a cancelled picker as cancelled, however it says so", async () => {
    // showOpenDialog yields filePaths[0] === undefined on cancel, not null.
    for (const v of [null, undefined, ""] as const) {
      const h = harness({ pickDir: async () => v });
      await exportActiveSpace(h.ctx);
      expect(h.sinkRoots).toEqual([]);
      expect(h.notices).toEqual([]);
    }
  });
});

describe("exportActiveSpace: where it writes", () => {
  it("roots the sink at the chosen folder plus the space's name", async () => {
    // Mis-wiring this to the chosen folder would delete everything the user
    // picked, and every other test here would stay green.
    const h = harness();
    await exportActiveSpace(h.ctx);
    expect(h.sinkRoots).toEqual(["C:/Users/x/Desktop/Kitchen"]);
  });

  it("sanitises the space name into the folder", async () => {
    const h = harness({ space: { ...space, name: "a/b" } });
    await exportActiveSpace(h.ctx);
    expect(h.sinkRoots).toEqual(["C:/Users/x/Desktop/a-b"]);
  });

  it("refuses a destination that RESOLVES onto the vault", async () => {
    // The vault-deletion path: pick the vault's parent, name the space
    // after the vault folder.
    const h = harness({
      pickDir: async () => "C:/Notes",
      space: { ...space, name: "Vault" },
    });
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("inside-vault")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("resolves links before judging the destination", async () => {
    // A junction pointing into the vault defeats a pure string compare.
    const h = harness({ realpath: async () => "C:/Notes/Vault/Exports" });
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("inside-vault")]);
    expect(h.sinkRoots).toEqual([]);
  });

  it("refuses when the vault path is unknown", async () => {
    const h = harness({ vaultBasePath: null });
    await exportActiveSpace(h.ctx);
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
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("collision")]);
  });
});

describe("exportActiveSpace: replacing", () => {
  it("does not ask when the destination does not exist", async () => {
    const h = harness();
    await exportActiveSpace(h.ctx);
    expect(h.confirmedPaths).toEqual([]);
    expect(h.sinks[0]?.removed).toEqual([]);
  });

  it("refuses a non-empty folder that is not one of ours", async () => {
    // A space called Documents must never eat the user's Documents folder.
    const h = harness({}, {
      seed: (s) => {
        void s.writeText("someone-elses-work.md", "mine");
      },
    });
    await exportActiveSpace(h.ctx);
    expect(h.notices).toEqual([blockedMessage("not-our-folder")]);
    expect(h.confirmedPaths).toEqual([]);
    expect(h.sinks[0]?.removed).toEqual([]);
  });

  it("asks before replacing one of our own exports, and stops on cancel", async () => {
    const h = harness({ confirm: async () => false }, {
      seed: (s) => {
        void s.writeText(MANIFEST_FILENAME, "{}");
      },
    });
    await exportActiveSpace(h.ctx);
    expect(h.sinks[0]?.removed).toEqual([]);
    expect(h.sinks[0]?.files.size).toBe(0);
  });

  it("replaces one of our own exports once confirmed", async () => {
    const h = harness({}, {
      seed: (s) => {
        void s.writeText(MANIFEST_FILENAME, "{}");
      },
    });
    await exportActiveSpace(h.ctx);
    expect(h.sinks[0]?.removed).toEqual([""]);
    expect(h.sinks[0]?.files.has("Reading/book.md")).toBe(true);
  });

  it("shows the path it is about to delete", async () => {
    const h = harness({}, {
      seed: (s) => {
        void s.writeText(MANIFEST_FILENAME, "{}");
      },
    });
    await exportActiveSpace(h.ctx);
    expect(h.confirmedPaths[0]).toContain("C:/Users/x/Desktop/Kitchen");
  });
});

describe("exportActiveSpace: reporting", () => {
  it("reports what it copied", async () => {
    const h = harness();
    await exportActiveSpace(h.ctx);
    expect(h.notices[0]).toContain("C:/Users/x/Desktop/Kitchen");
    expect(h.notices[0]).toContain("1");
  });

  it("reports a sink error instead of throwing", async () => {
    const h = harness({
      makeSink: () => {
        throw new Error("ENOTDIR: not a directory");
      },
    });
    await expect(exportActiveSpace(h.ctx)).resolves.toBeUndefined();
    expect(h.notices[0]).toContain("ENOTDIR");
  });

  it("reports a realpath failure instead of throwing", async () => {
    const h = harness({
      realpath: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    await expect(exportActiveSpace(h.ctx)).resolves.toBeUndefined();
    expect(h.notices[0]).toContain("ENOENT");
  });
});
