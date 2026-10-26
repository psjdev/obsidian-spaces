/**
 * `SpaceController.snapshotFor` — a snapshot for ANY space, not only the one
 * the user is in.
 *
 * The export needs it: a per-space action in Settings has to answer for a
 * space that is not active, and `currentSnapshot` cannot. It mirrors what
 * `recompute` builds, including the readiness gate that stops a tag or
 * property space resolving against an index that is not ready, because for
 * an export that gate is the difference between a folder holding a tag
 * space's notes and a folder holding none of them.
 */
import { describe, expect, it, vi } from "vitest";
import { SpaceController } from "../src/controller/SpaceController";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildFakeVault } from "./helpers/fakeVault";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { tagIndexOf } from "./helpers/tagIndex";
import { SCHEMA_VERSION, type SpaceDefinition } from "../src/types";
import { createPropertyIndex } from "../src/visibility/PropertyIndex";

const vault = buildFakeVault({
  Papers: "folder",
  "Papers/A.md": "file",
  "Papers/B.md": "file",
  Recipes: "folder",
  "Recipes/C.md": "file",
  "Loose.md": "file",
});

const papers: SpaceDefinition = {
  id: "papers",
  name: "Papers",
  icon: "file",
  color: "#4ecdc4",
  members: [{ path: "Papers", kind: "folder" }],
};
const recipes: SpaceDefinition = {
  id: "recipes",
  name: "Recipes",
  icon: "chef-hat",
  color: "#ff6b6b",
  members: [{ path: "Recipes/C.md", kind: "file" }],
};
const tagged: SpaceDefinition = {
  id: "tagged",
  name: "Tagged",
  icon: "tag",
  color: "#95e1d3",
  members: [{ kind: "tag", tag: "keep" }],
};

const propSpace: SpaceDefinition = {
  id: "props",
  name: "Props",
  icon: "list",
  color: "#fdcb6e",
  members: [{ kind: "property", key: "status", value: "active" }],
};

/** A controller whose property index answers for `Papers/A.md`. */
async function buildWithProperties() {
  const index = createPropertyIndex(
    [{ path: "Papers/A.md", frontmatter: { status: "active" } }],
    1
  );
  let stored: unknown = {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: false },
    spaces: [propSpace],
  };
  const store = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await store.load();
  const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
  runtime.load();
  const controller = new SpaceController(
    store,
    runtime,
    vault,
    { apply: vi.fn(), livePaths: () => new Set<string>(), metadataReady: () => true },
    createMapTagIndex(new Map()),
    () => ({ status: "ready", index })
  );
  return { controller };
}

async function build(opts: { metadataReady?: () => boolean; tags?: boolean } = {}) {
  let stored: unknown = {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: false },
    spaces: [papers, recipes, tagged],
  };
  const store = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await store.load();
  const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
  runtime.load();
  const controller = new SpaceController(
    store,
    runtime,
    vault,
    {
      apply: vi.fn(),
      livePaths: () => new Set<string>(),
      ...(opts.metadataReady ? { metadataReady: opts.metadataReady } : {}),
    },
    // Keyed by PATH -> tags, the way the vault describes itself.
    opts.tags ? tagIndexOf(new Map([["Papers/A.md", ["keep"]]])) : createMapTagIndex(new Map()),
    () => ({ status: "unavailable", unparsed: [] })
  );
  return { controller, store };
}

const visible = (s: { visiblePaths: () => Set<string> } | null): string[] =>
  s === null ? [] : [...s.visiblePaths()].sort();

describe("snapshotFor", () => {
  it("answers for a space that is not active", async () => {
    const { controller } = await build();
    // Still in All: nothing has been switched to.
    expect(controller.currentSnapshot()).toBeNull();
    expect(visible(controller.snapshotFor(recipes))).toContain("Recipes/C.md");
  });

  it("answers for each space independently", async () => {
    const { controller } = await build();
    expect(visible(controller.snapshotFor(papers))).toContain("Papers/A.md");
    expect(visible(controller.snapshotFor(papers))).not.toContain("Recipes/C.md");
    expect(visible(controller.snapshotFor(recipes))).not.toContain("Papers/A.md");
  });

  it("marks members with the reasons the export filters on", async () => {
    const { controller } = await build();
    const s = controller.snapshotFor(papers);
    expect(s?.decisionFor("Papers/A.md").reason).toBe("inherited-member");
    expect(s?.decisionFor("Papers").reason).toBe("exact-member");
  });

  it("leaves non-members out", async () => {
    const { controller } = await build();
    expect(visible(controller.snapshotFor(papers))).not.toContain("Loose.md");
  });

  it("does not disturb the snapshot the pane is showing", async () => {
    const { controller } = await build();
    await controller.switchTo({ kind: "space", id: "papers" });
    const before = controller.currentSnapshot();
    controller.snapshotFor(recipes);
    expect(controller.currentSnapshot()).toBe(before);
    expect(visible(controller.currentSnapshot())).toContain("Papers/A.md");
  });

  it("returns null while the metadata cache is not ready, for a tag space", async () => {
    // The gate that matters most for an export. "No matches yet" published
    // as "no matches" would be a folder with almost nothing in it.
    const { controller } = await build({ metadataReady: () => false, tags: true });
    expect(controller.snapshotFor(tagged)).toBeNull();
  });

  it("still answers for a space that does NOT watch metadata, cold cache or not", async () => {
    // A curated space of paths has nothing to wait for, and refusing it
    // would make the export needlessly unavailable at startup.
    const { controller } = await build({ metadataReady: () => false });
    expect(visible(controller.snapshotFor(papers))).toContain("Papers/A.md");
  });

  it("resolves a tag space once the cache is ready", async () => {
    const { controller } = await build({ metadataReady: () => true, tags: true });
    expect(visible(controller.snapshotFor(tagged))).toContain("Papers/A.md");
  });

  it("honours globalIgnore", async () => {
    // Ablating this to an empty matcher was green, and it would copy every
    // ignored note in a folder space out of the vault.
    const { controller, store } = await build();
    await store.mutate((d) => {
      d.settings.globalIgnore = ["Papers/B.md"];
    });
    const s = controller.snapshotFor(papers);
    expect(visible(s)).toContain("Papers/A.md");
    expect(visible(s)).not.toContain("Papers/B.md");
  });

  it("resolves property members against the property index", async () => {
    // Ablating the index away was green, and a property space would then
    // export nothing at all.
    const withProps = await buildWithProperties();
    const s = withProps.controller.snapshotFor(propSpace);
    expect(visible(s)).toContain("Papers/A.md");
  });

  it("honours the space's exclude list", async () => {
    const { controller } = await build();
    const s = controller.snapshotFor({ ...papers, exclude: ["Papers/B.md"] });
    expect(visible(s)).toContain("Papers/A.md");
    expect(visible(s)).not.toContain("Papers/B.md");
  });
});
