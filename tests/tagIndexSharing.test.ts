/**
 * One tag index per vault picture, not three.
 *
 * `SettingsTab`, `SpaceContentsModal` and the controller each constructed
 * their own `createObsidianTagIndex` over identical data, and at load two of
 * them built within 30 ms of each other — a second full walk of every
 * markdown file's metadata cache for the same answer.
 *
 * The controller already owns one, already replaces it on the flush, and
 * already exposes it (`tagIndex()`) so a question asked outside a recompute is
 * answered from the same picture the tree was drawn from. So the controller's
 * is THE index, and the two UI surfaces are handed an accessor to it instead
 * of a constructor.
 *
 * Asserted structurally, over the runtime import graph, because the thing
 * being prevented is a module reaching for its own builder. A behavioural
 * test cannot see this: two indexes over the same vault give the same
 * answers, which is exactly why the duplication survived review.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildRuntimeImportGraph } from "./helpers/importGraph";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const BUILDER = "visibility/ObsidianTagIndex.ts";

describe("who may construct a tag index", () => {
  it("is main.ts alone", () => {
    const graph = buildRuntimeImportGraph(SRC);
    const importers = [...graph.entries()]
      .filter(([, deps]) => deps.includes(BUILDER))
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual(["main.ts"]);
  });

  it("does not include the settings tab or the contents dialog", () => {
    // Named separately from the assertion above so a failure says which
    // surface grew its own index back.
    const graph = buildRuntimeImportGraph(SRC);
    expect(graph.get("ui/SettingsTab.ts")).not.toContain(BUILDER);
    expect(graph.get("ui/SpaceContentsModal.ts")).not.toContain(BUILDER);
  });
});
