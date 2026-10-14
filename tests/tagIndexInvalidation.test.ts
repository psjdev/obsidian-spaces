// @vitest-environment jsdom
/**
 * What a metadata-cache event must do, and to whom.
 *
 * The bug this pins: both metadata listeners returned early unless the
 * CURRENTLY ACTIVE space watched metadata, and the flush is the only other
 * `setTagIndex` caller. So tagging a note while *All* (or a folder space) was
 * active never invalidated the tag index, and the stale index survived for the
 * rest of the session — `pathsMatching` answered from a picture taken before
 * the tag existed, the note came back `hidden-nonmember` after switching into
 * the tag space, and `spaceAddTargets` re-opened the bug `910bc6b` closed by
 * offering to add a note the tag already held.
 *
 * Two concerns were conflated in one early return, so the fix separates them:
 *
 *  - INVALIDATE unconditionally. `createLazyTagIndex` means a replacement
 *    costs one closure until something reads it, so gating it bought nothing
 *    and cost correctness.
 *  - REQUEST A RECOMPUTE only when the active space's contents can actually
 *    have changed, which is what `watchesMetadata` has always been for.
 *
 * Layer: unit. The controller and the coalescer are fakes, so this is evidence
 * about the decision, not about Obsidian.
 */
import { describe, expect, it } from "vitest";
import SpacesPlugin from "../src/main";
import type { SpaceDefinition } from "../src/types";
import type { TagIndex } from "../src/visibility/TagIndex";

function space(members: SpaceDefinition["members"], root?: string): SpaceDefinition {
  const s: SpaceDefinition = { id: "s", name: "S", icon: "box", color: "#808080", members };
  return root === undefined ? s : { ...s, root };
}

const TAG_SPACE = space([{ kind: "tag", tag: "project" }]);
const PATH_SPACE = space([{ kind: "file", path: "a.md" }]);
const FOLDER_SPACE = space([{ kind: "tag", tag: "project" }], "Work");

interface Harness {
  plugin: SpacesPlugin;
  /** Every tag index handed to the controller, newest last. */
  installed: TagIndex[];
  /** Every property snapshot accessor handed to the controller, newest last. */
  propertyInstalled: Array<() => unknown>;
  /** How many times a coalesced recompute was requested. */
  requested: () => number;
  fire: () => void;
  /** A VAULT event, through the plugin's own `onVaultChange`. */
  fireVault: () => Promise<void>;
  /** Subscribes to the plugin's REAL hub, as an open picker does. */
  openPicker: () => () => void;
  /** What the coming flush would do, from the plugin's own `flushState`. */
  pending: () => Promise<{ full: boolean; recompute: boolean; rebuild: boolean }>;
}

function harness(active: SpaceDefinition | null): Harness {
  const plugin = new SpacesPlugin(
    {} as ConstructorParameters<typeof SpacesPlugin>[0],
    {} as ConstructorParameters<typeof SpacesPlugin>[1]
  );
  const record = (plugin as unknown as Record<string, unknown>);
  // The only part of `app` the invalidation path touches: it builds a LAZY
  // index, so nothing is walked unless something asks the index a question.
  record.app = {
    vault: { getMarkdownFiles: () => [] },
    metadataCache: { getFileCache: () => null },
  };
  const installed: TagIndex[] = [];
  const propertyInstalled: Array<() => unknown> = [];
  let requested = 0;
  record.controller = {
    activeSpace: () => active,
    setTagIndex: (index: TagIndex) => void installed.push(index),
    setPropertySnapshot: (get: () => unknown) => void propertyInstalled.push(get),
  };
  // Shadows the shared coalescer: the coalescer itself is `eventCoalescer.ts`'s
  // business and is tested there. This sits BELOW the routing fork in
  // `onMetadataEvent` (`onVaultChange` versus `submitMetadataWork`), so
  // counting submits cannot tell the routes apart. It therefore RUNS the
  // submitted work, and the tests below read the plugin's real
  // `flushState`, which is what differs: a vault event marks the burst full
  // (the O(vault) tree re-index), a metadata event marks it for a recompute.
  record.vaultChanges = {
    submit: async (work: () => Promise<unknown>) => {
      requested++;
      await work();
    },
  };
  return {
    plugin,
    installed,
    propertyInstalled,
    requested: () => requested,
    fire: () => (plugin as unknown as { onMetadataEvent(): void }).onMetadataEvent(),
    fireVault: () =>
      (
        plugin as unknown as { onVaultChange(fn: () => Promise<unknown>): Promise<void> }
      ).onVaultChange(async () => undefined),
    openPicker: () => plugin.subscribePropertyRefresh(() => undefined),
    /** What the coming flush would do, read from the plugin's own state. */
    pending: async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      return (
        plugin as unknown as {
          flushState: { take(): { full: boolean; recompute: boolean; rebuild: boolean } };
        }
      ).flushState.take();
    },
  };
}

describe("what a metadata event asks the flush to do", () => {
  it("is a recompute and not a vault re-index, for a space that watches metadata", async () => {
    // Routing a metadata event through `onVaultChange` marks the burst full,
    // and the flush then rebuilds the vault tree for a change that cannot have
    // moved it. That is the defect Task 13 fixed; this is its gate.
    const h = harness(TAG_SPACE);
    h.fire();
    expect(await h.pending()).toEqual({ full: false, recompute: true, rebuild: false });
  });

  it("asks for nothing when no space watches metadata and no picker is open", async () => {
    for (const active of [null, FOLDER_SPACE, PATH_SPACE]) {
      const h = harness(active);
      h.fire();
      expect(await h.pending()).toEqual({ full: false, recompute: false, rebuild: false });
    }
  });

  it("flushes for an open picker alone, and asks that flush for nothing else", async () => {
    // The THIRD route, which nothing drove against the real method: the two
    // other harnesses in the suite never subscribe, so `propertyRefresh.size`
    // was always 0 and `metadataNotifyRoute`'s second argument was never
    // exercised here. A picker open over a space that watches nothing still
    // needs the flush, to be told the snapshot was replaced — and the flush
    // must not re-index the tree or recompute a space that cannot have
    // changed.
    const h = harness(PATH_SPACE);
    const release = h.openPicker();
    h.fire();
    expect(h.requested()).toBe(1);
    expect(await h.pending()).toEqual({ full: false, recompute: false, rebuild: false });
    release();
    h.fire();
    expect(h.requested()).toBe(1);
  });

  it("does not install a second snapshot over the one the event just installed", async () => {
    // A vault event, then a metadata event that routes to NOTHING. The event
    // installs a snapshot either way, so the flush behind the vault event
    // must not install another: `rebuild` is `full && !fresh`, and the flag
    // tracks the install rather than the route it took afterwards.
    const h = harness(PATH_SPACE);
    await h.fireVault();
    h.fire();
    expect(h.propertyInstalled.length).toBe(1);
    expect(await h.pending()).toEqual({ full: true, recompute: true, rebuild: false });
  });
});

describe("a metadata-cache event", () => {
  it("replaces the property snapshot as well, whichever space is active", () => {
    // The same staleness the tag index had: a property member would otherwise
    // go on answering from the frontmatter as it was when the snapshot was
    // first read.
    for (const active of [null, FOLDER_SPACE, PATH_SPACE, TAG_SPACE]) {
      const h = harness(active);
      h.fire();
      h.fire();
      expect(h.propertyInstalled.length).toBe(2);
      expect(h.propertyInstalled[0]).not.toBe(h.propertyInstalled[1]);
    }
  });

  it("replaces the tag index while All is active", () => {
    // The reported repro: tag a note with All active, switch to the tag
    // space, and the note is missing. Nothing else in the session replaces
    // the index, so the staleness is permanent.
    const h = harness(null);
    h.fire();
    expect(h.installed.length).toBe(1);
  });

  it("replaces the tag index while a folder space is active", () => {
    // `watchesMetadata` is false for a folder space even when it stores tag
    // members, so this was the second door into the same staleness.
    const h = harness(FOLDER_SPACE);
    h.fire();
    expect(h.installed.length).toBe(1);
  });

  it("replaces the tag index while a space of files and folders is active", () => {
    const h = harness(PATH_SPACE);
    h.fire();
    expect(h.installed.length).toBe(1);
  });

  it("replaces the tag index while a tag space is active", () => {
    const h = harness(TAG_SPACE);
    h.fire();
    expect(h.installed.length).toBe(1);
  });

  it("hands over a fresh index each time rather than the same object", () => {
    const h = harness(null);
    h.fire();
    h.fire();
    expect(h.installed.length).toBe(2);
    expect(h.installed[0]).not.toBe(h.installed[1]);
  });

  it("costs nothing but a closure until something reads the index", () => {
    // The whole reason invalidation can be unconditional. `getMarkdownFiles`
    // is the first thing `createObsidianTagIndex` calls, so a walk that
    // happened would be visible here.
    let walks = 0;
    const h = harness(null);
    (h.plugin as unknown as { app: { vault: { getMarkdownFiles: () => unknown[] } } }).app.vault.getMarkdownFiles =
      (): unknown[] => {
        walks++;
        return [];
      };
    h.fire();
    expect(walks).toBe(0);
    // ...and it is a real index once asked.
    expect(h.installed[0].pathsMatching("project")).toEqual([]);
    expect(walks).toBe(1);
  });
});

describe("requesting a recompute after a metadata event", () => {
  it("does not, while All is active", () => {
    const h = harness(null);
    h.fire();
    expect(h.requested()).toBe(0);
  });

  it("does not, for a space of files and folders", () => {
    const h = harness(PATH_SPACE);
    h.fire();
    expect(h.requested()).toBe(0);
  });

  it("does not, for a folder space, which renders from its root", () => {
    const h = harness(FOLDER_SPACE);
    h.fire();
    expect(h.requested()).toBe(0);
  });

  it("does, for a space whose contents depend on a note's tags", () => {
    const h = harness(TAG_SPACE);
    h.fire();
    expect(h.requested()).toBe(1);
  });
});
