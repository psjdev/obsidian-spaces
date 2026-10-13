/**
 * First paint against a metadata cache that has not finished parsing.
 *
 * `onLayoutReady` fires long before Obsidian's metadata cache resolves, and
 * `getAllTags` returns null for every file it has not parsed yet. So a tag
 * space resolved to ZERO members at first paint and the explorer rendered
 * empty — 0 folder rows, 1 file row, no loading state, no explanation — for
 * about three seconds on a 10,000 note vault. That is indistinguishable from
 * data loss, and the coalescer does not bound it: 6,550 `changed` events over
 * two seconds produced exactly one flush, because the 250 ms max-wait timer
 * cannot fire while the main thread is busy parsing.
 *
 * The fix FALLS OPEN: while the cache is still building, a space whose
 * contents depend on it renders the unfiltered tree rather than an empty one.
 *
 * The hazard this file exists to pin is the other half. A tag space that
 * genuinely matches nothing MUST still render empty. "No matches yet" and "no
 * matches" are different answers and the controller must not conflate them,
 * so the fall-open is gated on a readiness signal, not on the member count.
 *
 * Layer: unit. The host is a fake, so this is evidence about the controller's
 * decision, not about when Obsidian's cache actually settles.
 */
import { describe, expect, it, vi } from "vitest";
import { SpaceController } from "../src/controller/SpaceController";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildFakeVault } from "./helpers/fakeVault";
import { createLazyTagIndex } from "../src/visibility/TagIndex";
import { createPropertyIndex, type PropertySnapshot } from "../src/visibility/PropertyIndex";
import { tagIndexOf } from "./helpers/tagIndex";
import { SCHEMA_VERSION, type MemberEntry, type SpaceDefinition } from "../src/types";

const vault = buildFakeVault({
  Papers: "folder",
  "Papers/A.md": "file",
  "Recipes.md": "file",
});

/** What the cache holds. Empty is the cold case: nothing parsed yet. */
type Tags = Map<string, string[]>;

async function build(
  members: MemberEntry[],
  tags: Tags,
  opts: { ready: boolean; root?: string; properties?: PropertySnapshot }
) {
  const space: SpaceDefinition = {
    id: "research",
    name: "Research",
    icon: "microscope",
    color: "#4ecdc4",
    members,
    ...(opts.root === undefined ? {} : { root: opts.root }),
  };
  let stored: unknown = {
    schemaVersion: SCHEMA_VERSION,
    settings: { globalIgnore: [], restoreLayouts: false },
    spaces: [space],
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
  const apply = vi.fn();
  let ready = opts.ready;
  let builds = 0;
  // Unavailable unless a case says otherwise, which is what a cache that has
  // not parsed every file reports.
  let properties: PropertySnapshot = opts.properties ?? { status: "unavailable" };
  let propertyAsks = 0;
  const controller = new SpaceController(
    store,
    runtime,
    vault,
    {
      apply,
      livePaths: () => new Set<string>(),
      metadataReady: () => ready,
    },
    createLazyTagIndex(() => {
      builds++;
      return tagIndexOf(tags);
    }),
    () => {
      propertyAsks++;
      return properties;
    }
  );
  return {
    controller,
    apply,
    runtime,
    builds: () => builds,
    propertyAsks: () => propertyAsks,
    resolve: () => {
      ready = true;
    },
    setProperties: (next: PropertySnapshot) => {
      properties = next;
    },
  };
}

const TAG_MEMBERS: MemberEntry[] = [{ kind: "tag", tag: "project" }];
const PROPERTY_MEMBERS: MemberEntry[] = [{ kind: "property", key: "status", value: "active" }];
const COLD: Tags = new Map();
const WARM: Tags = new Map([["Recipes.md", ["project"]]]);

/** A ready snapshot in which `Recipes.md`, and only it, is `status: active`. */
const readyProperties = (): PropertySnapshot => ({
  status: "ready",
  index: createPropertyIndex([{ path: "Recipes.md", frontmatter: { status: "active" } }], 1),
});

describe("a tag space at first paint, before the metadata cache has resolved", () => {
  it("renders the unfiltered tree rather than an empty one", async () => {
    const { controller, apply } = await build(TAG_MEMBERS, COLD, { ready: false });
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()).toBeNull();
    expect(apply).toHaveBeenLastCalledWith(null);
  });

  it("stays in the space it was asked for", async () => {
    // Falling open is a rendering decision, not a switch back to All: the
    // header, the switcher and the next recompute must all still be in the
    // space the user left the session in.
    const { controller, runtime } = await build(TAG_MEMBERS, COLD, { ready: false });
    await controller.switchTo({ kind: "space", id: "research" });
    expect(runtime.getSelection()).toEqual({ kind: "space", id: "research" });
    expect(controller.activeSpace()?.id).toBe("research");
  });

  it("does not walk the vault's metadata for an answer it will not use", async () => {
    const { controller, builds } = await build(TAG_MEMBERS, COLD, { ready: false });
    await controller.switchTo({ kind: "space", id: "research" });
    expect(builds()).toBe(0);
  });

  it("filters as soon as the cache reports itself resolved", async () => {
    const { controller, resolve } = await build(TAG_MEMBERS, WARM, { ready: false });
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()).toBeNull();
    resolve();
    controller.refresh();
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Recipes.md").visible).toBe(true);
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(false);
  });
});

describe("the hazard: no matches yet is not no matches", () => {
  it("renders a tag space that genuinely matches nothing as empty", async () => {
    // Same zero members as the cold case above, and it must reach the
    // OPPOSITE conclusion. The only difference is that the cache has answered.
    const { controller } = await build(TAG_MEMBERS, COLD, { ready: true });
    await controller.switchTo({ kind: "space", id: "research" });
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Recipes.md").visible).toBe(false);
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(false);
  });
});

describe("a property space whose snapshot has never been ready", () => {
  it("falls open rather than publishing itself empty, although the host says ready", async () => {
    // The two readiness signals are not the same question. `metadataReady` is
    // resolved-and-laid-out; snapshot readiness is strictly stricter, because
    // ONE unparsed file makes the whole property snapshot unavailable. Reading
    // only the host's signal let this space pass the gate, resolve its
    // property members against `null` and publish itself EMPTY — "not known
    // yet" rendered as "matches nothing", which is the contract
    // `resolveMembers` states and its caller was breaking.
    const { controller, apply } = await build(PROPERTY_MEMBERS, COLD, { ready: true });
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()).toBeNull();
    expect(apply).toHaveBeenLastCalledWith(null);
  });

  it("filters as soon as an index is ready", async () => {
    // Self-correcting, like the tag arm: the parse that makes the snapshot
    // ready is a metadata event, and main.ts asks for the recompute.
    const { controller, setProperties } = await build(PROPERTY_MEMBERS, COLD, { ready: true });
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()).toBeNull();
    setProperties(readyProperties());
    controller.refresh();
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Recipes.md").visible).toBe(true);
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(false);
  });

  it("renders a property space that genuinely matches nothing as empty", async () => {
    // The same hazard the tag arm has: a ready index that matches nothing is
    // an ANSWER, and the space must render empty rather than fall open.
    const { controller } = await build([{ kind: "property", key: "nobody" }], COLD, {
      ready: true,
      properties: readyProperties(),
    });
    await controller.switchTo({ kind: "space", id: "research" });
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Recipes.md").visible).toBe(false);
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(false);
  });

  it("holds its last good answer once one index has been ready", async () => {
    // Only the FIRST ready index of a session is waited for.
    // `drawnPropertyIndex` keeps it, so a cache going cold again mid-session
    // must neither blank the space nor re-open the whole tree.
    const { controller, setProperties } = await build(PROPERTY_MEMBERS, COLD, {
      ready: true,
      properties: readyProperties(),
    });
    await controller.switchTo({ kind: "space", id: "research" });
    setProperties({ status: "unavailable" });
    controller.refresh();
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Recipes.md").visible).toBe(true);
  });

  it("costs a tag space nothing", async () => {
    // The property arm is asked ONLY for a space that holds a property
    // member, so a tag space never touches the snapshot to answer the gate.
    // The accessor's first ask is a walk of every note's frontmatter.
    const { controller, propertyAsks } = await build(TAG_MEMBERS, WARM, { ready: true });
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()).not.toBeNull();
    expect(propertyAsks()).toBe(0);
  });
});

describe("a space the metadata cache cannot affect", () => {
  it("filters normally at first paint even while the cache is cold", async () => {
    // A curated space of paths has nothing to wait for. Falling open for it
    // would trade one wrong tree for another.
    const { controller } = await build([{ path: "Papers", kind: "folder" }], COLD, {
      ready: false,
    });
    await controller.switchTo({ kind: "space", id: "research" });
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(true);
    expect(snap!.decisionFor("Recipes.md").visible).toBe(false);
  });

  it("filters a folder space at first paint even while the cache is cold", async () => {
    // A folder space renders from its root and never consults its member
    // list, so its stored tag member changes nothing — which is exactly what
    // `watchesMetadata` already says about it.
    const { controller } = await build(TAG_MEMBERS, COLD, { ready: false, root: "Papers" });
    await controller.switchTo({ kind: "space", id: "research" });
    const snap = controller.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decisionFor("Papers/A.md").visible).toBe(true);
  });
});

describe("a host that reports no readiness at all", () => {
  it("filters, rather than falling open forever", async () => {
    // The signal is optional so every existing caller keeps its behaviour.
    // Absent must mean "ready": a host that never reports would otherwise
    // never filter a tag space again.
    let stored: unknown = {
      schemaVersion: SCHEMA_VERSION,
      settings: { globalIgnore: [], restoreLayouts: false },
      spaces: [
        {
          id: "research",
          name: "Research",
          icon: "microscope",
          color: "#4ecdc4",
          members: TAG_MEMBERS,
        },
      ],
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
      { apply: vi.fn(), livePaths: () => new Set<string>() },
      tagIndexOf(WARM),
      () => ({ status: "unavailable" })
    );
    await controller.switchTo({ kind: "space", id: "research" });
    expect(controller.currentSnapshot()?.decisionFor("Recipes.md").visible).toBe(true);
  });
});
