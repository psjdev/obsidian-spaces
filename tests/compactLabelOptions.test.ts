// @vitest-environment jsdom
/**
 * The one place a label setting is READ, exercised against the real setting.
 *
 * WHY THIS FILE EXISTS. A review of this branch found that the removed
 * `compactPathThreshold` was readable only by production code:
 * `compactLabelOptions()` was its sole reader and no test called it, so
 * hardcoding the threshold to any constant left the whole suite green. A
 * setting nothing asserts is a setting that can be deleted by accident.
 *
 * So these tests drive `compactLabelOptions()` itself, with the setting
 * written into a REAL `DefinitionStore`, and they check both values -- one
 * value alone would still pass against a hardcoded answer.
 */
import { describe, expect, it, vi } from "vitest";
import { makePluginForSeam } from "./helpers/seamHarness";
import type { CompactLabelPolicy } from "../src/ui/compactLabel";

const TREE = {
  "": ["Clients"],
  Clients: ["Clients/Meetings"],
  "Clients/Meetings": ["Clients/Meetings/a.md"],
};
const VISIBLE = ["Clients", "Clients/Meetings", "Clients/Meetings/a.md"];

function seeded() {
  return makePluginForSeam({
    compactFolderChains: true,
    tree: TREE,
    visible: VISIBLE,
    members: ["Clients/Meetings/a.md"],
  });
}

/** The live settings object, which is what the production reader reads. */
function settingsOf(h: ReturnType<typeof seeded>): Record<string, unknown> {
  return h.plugin["defs"].get().settings as unknown as Record<string, unknown>;
}

describe("compactLabelOptions", () => {
  it("permits shortening when the user leaves the toggle on", () => {
    const h = seeded();
    settingsOf(h).abbreviateCompactedPaths = true;
    expect(h.plugin["compactLabelOptions"]()).toEqual<CompactLabelPolicy>({
      abbreviateWhenOverflowing: true,
    });
  });

  it("forbids it when the user turns the toggle off", () => {
    const h = seeded();
    settingsOf(h).abbreviateCompactedPaths = false;
    expect(h.plugin["compactLabelOptions"]()).toEqual<CompactLabelPolicy>({
      abbreviateWhenOverflowing: false,
    });
  });

  it("reads the setting fresh on every call, not once at construction", () => {
    // The toggle changes without this method being re-created, and the
    // definitions subscriber reaches it through `controller.refresh()` on
    // every write.
    const h = seeded();
    settingsOf(h).abbreviateCompactedPaths = true;
    expect(h.plugin["compactLabelOptions"]().abbreviateWhenOverflowing).toBe(true);
    settingsOf(h).abbreviateCompactedPaths = false;
    expect(h.plugin["compactLabelOptions"]().abbreviateWhenOverflowing).toBe(false);
  });

  it("carries nothing but the policy, so no folder count can creep back in", () => {
    const h = seeded();
    expect(Object.keys(h.plugin["compactLabelOptions"]())).toEqual(["abbreviateWhenOverflowing"]);
  });

  /**
   * The WIRING, which the reader above cannot vouch for on its own: a method
   * that returns the right answer and is never handed to the adapter draws
   * every row with whatever the adapter was seeded with.
   */
  it("is what the adapter is handed on every snapshot", () => {
    const h = seeded();
    settingsOf(h).abbreviateCompactedPaths = false;
    const adapter = h.plugin["adapter"];
    const spy = vi.spyOn(adapter, "setChainIndex");
    h.plugin["applyAdapterSnapshot"](h.plugin["controller"].currentSnapshot());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual<CompactLabelPolicy>({ abbreviateWhenOverflowing: false });

    settingsOf(h).abbreviateCompactedPaths = true;
    h.plugin["applyAdapterSnapshot"](h.plugin["controller"].currentSnapshot());
    expect(spy.mock.calls[1][1]).toEqual<CompactLabelPolicy>({ abbreviateWhenOverflowing: true });
  });
});
