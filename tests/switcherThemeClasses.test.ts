// @vitest-environment jsdom
/**
 * The strip's controls carry Obsidian's own component class as well as ours.
 * Without it a theme has no selector that reaches them, which is what made an
 * uncolored icon render at `--text-normal` while every other icon in the app
 * used `--icon-color`.
 */
import { describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS, type SpaceDefinition } from "../src/types";
import { DEFAULT_SPACE_COLOR } from "../src/definitions/appearance";

const SPACES: SpaceDefinition[] = [
  { id: "a", name: "Garden", icon: "leaf", color: "#4ecdc4", members: [] },
  // The neutral swatch, which is what a space gets when `autoAssignColor` is
  // off. An empty color is not representable: `validateSpace` rejects it and
  // drops the space.
  { id: "b", name: "Plain", icon: "inbox", color: DEFAULT_SPACE_COLOR, members: [] },
];

async function mount(): Promise<HTMLElement> {
  let stored: unknown = { ...DEFAULT_DEFINITIONS, spaces: SPACES };
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
  return host;
}

describe("the strip's controls are Obsidian icon buttons", () => {
  it("gives every space icon both classes", async () => {
    const host = await mount();
    const items = host.querySelectorAll(".spaces-switcher-item");
    expect(items.length).toBeGreaterThan(0);
    items.forEach((el) => expect(el.classList.contains("clickable-icon")).toBe(true));
  });

  it("gives the create control both classes", async () => {
    const host = await mount();
    const add = host.querySelector(".spaces-switcher-add");
    expect(add?.classList.contains("clickable-icon")).toBe(true);
  });

  it("still writes an assigned color as an inline style", async () => {
    // The color is the user's data. Inline is what keeps it winning over a
    // theme's rule for `.clickable-icon`, so this is not a detail of how the
    // element happens to be built.
    const host = await mount();
    const colored = host.querySelector<HTMLElement>('[aria-label="Garden"]');
    expect(colored?.style.color).toBe("rgb(78, 205, 196)");
  });

  it("writes no inline color for a space on the neutral swatch", async () => {
    // `#808080` is the neutral option in the color popover, not a color the
    // user picked for its own sake. Leaving it off the element is what lets
    // `--icon-color` apply, which is the difference the reporter described as
    // the icons being grey.
    const host = await mount();
    const plain = host.querySelector<HTMLElement>('[aria-label="Plain"]');
    expect(plain).not.toBeNull();
    expect(plain?.style.color).toBe("");
  });
});
