// @vitest-environment jsdom
/**
 * The class the strip root wears for the chosen active style.
 *
 * There are two classes now and three styles, so the root has to lose the
 * class it was wearing when the setting changes. The element survives a
 * render, so a switch from Boxed to Bolded that only adds would leave both
 * classes on and draw both looks at once.
 */
import { describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { BOLDED_CLASS, BOXED_CLASS } from "../src/ui/activeStyle";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS, type ActiveSpaceStyle } from "../src/types";
import { DEFAULT_SPACE_COLOR } from "../src/definitions/appearance";

async function mount(style: ActiveSpaceStyle) {
  let stored: unknown = {
    ...DEFAULT_DEFINITIONS,
    settings: { ...DEFAULT_DEFINITIONS.settings, activeSpaceStyle: style },
    spaces: [{ id: "a", name: "Garden", icon: "leaf", color: DEFAULT_SPACE_COLOR, members: [] }],
  };
  const defs = new DefinitionStore({
    read: async () => stored,
    write: async (d) => {
      stored = d;
    },
  });
  await defs.load();
  const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
  runtime.load();
  const controller = new SpaceController(defs, runtime, buildFakeVault({}), {
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
  const root = host.querySelector<HTMLElement>(".spaces-switcher");
  if (!root) throw new Error("the strip did not mount");
  return { root, defs, switcher };
}

describe("the class the strip wears for the active style", () => {
  it("wears neither class for shaded", async () => {
    // Shaded is the stylesheet's own rule, so there is nothing to add.
    const { root } = await mount("shaded");
    expect(root.classList.contains(BOXED_CLASS)).toBe(false);
    expect(root.classList.contains(BOLDED_CLASS)).toBe(false);
  });

  it("wears the boxed class for boxed", async () => {
    const { root } = await mount("boxed");
    expect(root.classList.contains(BOXED_CLASS)).toBe(true);
    expect(root.classList.contains(BOLDED_CLASS)).toBe(false);
  });

  it("wears the bolded class for bolded", async () => {
    const { root } = await mount("bolded");
    expect(root.classList.contains(BOLDED_CLASS)).toBe(true);
    expect(root.classList.contains(BOXED_CLASS)).toBe(false);
  });

  it("drops the old class when the setting changes", async () => {
    // The case a toggle-only implementation gets wrong. Both classes on the
    // root would draw a ring and a heavy glyph together, which is neither
    // style the user picked.
    const { root, defs, switcher } = await mount("boxed");
    await defs.mutate((d) => {
      d.settings.activeSpaceStyle = "bolded";
    });
    switcher.render();
    expect(root.classList.contains(BOLDED_CLASS)).toBe(true);
    expect(root.classList.contains(BOXED_CLASS)).toBe(false);
  });

  it("drops both classes on a change back to shaded", async () => {
    const { root, defs, switcher } = await mount("bolded");
    await defs.mutate((d) => {
      d.settings.activeSpaceStyle = "shaded";
    });
    switcher.render();
    expect(root.classList.contains(BOLDED_CLASS)).toBe(false);
    expect(root.classList.contains(BOXED_CLASS)).toBe(false);
  });
});
