// @vitest-environment jsdom
/**
 * Regression: the grip's icon must reflect the placement the strip is
 * LANDING on, not the one it is leaving.
 *
 * Root cause (main.ts's definitions subscription, now fixed): it called
 * `switcher.render()` before `switcher.applyPlacement(...)`. `render()` is
 * the only place that draws the grip's icon, and it derives the icon from
 * `this.axis`, which derives from `this.placement` -- so a `render()` that
 * runs before `applyPlacement()` updates that field always draws for the
 * placement the strip is about to leave, and nothing redraws it afterwards.
 *
 * Built against a REAL `SwitcherView`, `DefinitionStore`, `RuntimeStateStore`
 * and `SpaceController` (the same construction `tests/controller.test.ts`
 * uses) rather than a mock of `render()`'s internals: the bug lived entirely
 * in the ORDER two real calls ran in, which a test that stubs either method
 * away cannot see.
 *
 * COMPROMISE on where the two calls come from: this drives `applyPlacement`
 * and `render()` directly, in the same order and with the same arguments as
 * `main.ts`'s subscription, rather than triggering the plugin's actual
 * `defs.subscribe(...)` closure. That closure lives inside `startSteps()`,
 * reached only through the full explorer-binding lifecycle (`start()` ->
 * `bindExplorer()`), which needs a much larger workspace/leaf harness than
 * this fix warrants. The ablation below (see the comment on the `it` block)
 * confirms this still catches exactly the bug that shipped: reversing the
 * two calls here reproduces the same wrong order `main.ts` had, and fails
 * the same way.
 *
 * ICON ASSERTION: the stub's `setIcon` (tests/helpers/obsidian-stub.ts)
 * deliberately does not model Obsidian's real Lucide SVG output ("no test
 * may assert on the shape of what lands here") -- it only stamps the
 * `data-stub-icon` attribute with the exact `iconId` argument `src/` passed,
 * "so a failure is legible in a DOM dump". That argument (`grip-horizontal`
 * vs. `grip-vertical`) is precisely the thing this bug got wrong, so reading
 * that attribute is asserting on `src/`'s own behaviour, not on invented
 * icon markup -- real SVG-shape assertions stay Layer 4, per that file.
 */
import { describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS } from "../src/types";

async function build() {
  let stored: unknown = { ...DEFAULT_DEFINITIONS };
  const defs = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await defs.load();
  const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
  runtime.load();
  const vault = buildFakeVault({});
  const controller = new SpaceController(defs, runtime, vault, {
    apply: vi.fn(),
    livePaths: () => new Set<string>(),
  });
  const switcher = new SwitcherView(
    defs,
    runtime,
    controller,
    () => undefined,
    () => false,
    () => undefined
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  switcher.mount(host);
  return { switcher, defs, host };
}

/** What `src/` last asked the grip's icon to be, per the stub's own contract. */
function gripIcon(host: HTMLElement): string | null {
  return host.querySelector(".spaces-strip-grip")?.getAttribute("data-stub-icon") ?? null;
}

describe("the grip's icon follows the placement it is landing on", () => {
  it("shows the vertical-dots icon at the bottom, and switches to horizontal-dots when moved to the right", async () => {
    const { switcher, defs, host } = await build();
    switcher.setUnlocked(true);
    expect(defs.get().settings.stripPlacement).toBe("bottom");
    // `axisFor("bottom")` is "x" (icons run horizontally), and `render()`
    // draws "grip-vertical" for that axis -- see the ternary this asserts
    // against, `src/ui/SwitcherView.ts` near `setIcon(grip, ...)`.
    expect(gripIcon(host)).toBe("grip-vertical");

    await defs.mutate((d) => {
      d.settings.stripPlacement = "right";
    });

    // The fixed order, matching main.ts's definitions subscription:
    // `applyPlacement` updates `this.placement` FIRST, so the `render()`
    // that follows draws the grip for the placement just applied rather
    // than the one it is leaving.
    //
    // Ablation performed by hand (see task-1011-report.md): swapping these
    // two lines back to `render()` then `applyPlacement()` -- the exact
    // order that shipped the bug -- makes this assertion fail with
    // `"grip-vertical"` instead of `"grip-horizontal"`, because `render()`
    // then runs while `this.placement` still reads "bottom".
    switcher.applyPlacement(defs.get().settings.stripPlacement);
    switcher.render();

    // `axisFor("right")` is "y" (icons run vertically), which draws
    // "grip-horizontal" -- the icon that actually changed is what this bug
    // got wrong.
    expect(gripIcon(host)).toBe("grip-horizontal");
  });
});
