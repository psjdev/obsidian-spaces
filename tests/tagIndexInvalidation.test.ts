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
  /** How many times a coalesced recompute was requested. */
  requested: () => number;
  fire: () => void;
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
  let requested = 0;
  record.controller = {
    activeSpace: () => active,
    setTagIndex: (index: TagIndex) => void installed.push(index),
  };
  // Shadows the private method: the coalescer itself is `eventCoalescer.ts`'s
  // business and is tested there.
  record.onVaultChange = async () => {
    requested++;
  };
  return {
    plugin,
    installed,
    requested: () => requested,
    fire: () => (plugin as unknown as { onMetadataEvent(): void }).onMetadataEvent(),
  };
}

describe("a metadata-cache event", () => {
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
