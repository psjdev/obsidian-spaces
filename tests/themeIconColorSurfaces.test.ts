// @vitest-environment jsdom
/**
 * The Appearance toggle that forces theme colors, on every surface that
 * draws a space icon.
 *
 * One test file rather than one per surface, because the failure this guards
 * against is a surface being missed. The neutral swatch shipped to one
 * surface out of five and left the same space grey in the other four, so the
 * list below is the point of the file.
 *
 * The check is always the same: with the toggle on there is NO inline color,
 * which is what lets the theme's `--icon-color` apply. Computed color is no
 * use here, since the default theme resolves several of its icon variables to
 * the same value.
 */
import { describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { SpaceHeaderView } from "../src/ui/SpaceHeaderView";
import { appendSpaceIcon } from "../src/ui/spaceRow";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS, type SpaceDefinition } from "../src/types";

const COLOR = "#4ecdc4";
const SPACES: SpaceDefinition[] = [
  { id: "a", name: "Garden", icon: "leaf", color: COLOR, members: [] },
];

async function harness(useThemeIconColor: boolean) {
  let stored: unknown = {
    ...DEFAULT_DEFINITIONS,
    settings: { ...DEFAULT_DEFINITIONS.settings, useThemeIconColor, showSpaceHeader: true },
    spaces: SPACES,
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
  runtime.setSelection({ kind: "space", id: "a" });
  const controller = new SpaceController(defs, runtime, buildFakeVault({}), {
    apply: vi.fn(),
    livePaths: () => new Set<string>(),
  });
  return { defs, runtime, controller };
}

async function stripIcon(useThemeIconColor: boolean): Promise<HTMLElement> {
  const { defs, runtime, controller } = await harness(useThemeIconColor);
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
  const item = host.querySelector<HTMLElement>('[aria-label="Garden"]');
  if (!item) throw new Error("the strip drew no Garden");
  return item;
}

async function headerIcon(useThemeIconColor: boolean): Promise<HTMLElement> {
  const { defs, runtime } = await harness(useThemeIconColor);
  const header = new SpaceHeaderView(
    defs,
    runtime,
    async () => undefined,
    async () => undefined,
    () => true
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  header.mount(host);
  const icon = host.querySelector<HTMLElement>(".spaces-space-header-icon");
  if (!icon) throw new Error("the header drew no icon");
  return icon;
}

function rowIcon(useThemeIconColor: boolean): HTMLElement {
  const row = document.createElement("div");
  document.body.appendChild(row);
  // The same call the switcher popover and the quick switcher make.
  return appendSpaceIcon(
    row,
    { key: { kind: "space", id: "a" }, label: "Garden", icon: "leaf", color: COLOR, active: false },
    useThemeIconColor
  );
}

describe("forcing theme colors on every surface that draws a space icon", () => {
  it("paints the space's color on the strip with the toggle off", async () => {
    expect((await stripIcon(false)).style.color).toBe("rgb(78, 205, 196)");
  });

  it("writes no color on the strip with the toggle on", async () => {
    expect((await stripIcon(true)).style.color).toBe("");
  });

  it("paints the space's color in the header with the toggle off", async () => {
    expect((await headerIcon(false)).style.color).toBe("rgb(78, 205, 196)");
  });

  it("writes no color in the header with the toggle on", async () => {
    // The surface the neutral swatch fix missed the first time.
    expect((await headerIcon(true)).style.color).toBe("");
  });

  it("paints the space's color on a list row with the toggle off", async () => {
    expect(rowIcon(false).style.color).toBe("rgb(78, 205, 196)");
  });

  it("writes no color on a list row with the toggle on", async () => {
    // Covers the header's switcher popover and the quick switcher, which both
    // draw their rows through this one function.
    expect(rowIcon(true).style.color).toBe("");
  });

  it("gives the color back when the toggle goes off again", async () => {
    // The whole promise of the setting. Nothing was written to the space, so
    // a strip built after the toggle flips paints the stored color again.
    const { defs, runtime, controller } = await harness(true);
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
    expect(host.querySelector<HTMLElement>('[aria-label="Garden"]')?.style.color).toBe("");

    await defs.mutate((d) => {
      d.settings.useThemeIconColor = false;
    });
    switcher.render();
    expect(host.querySelector<HTMLElement>('[aria-label="Garden"]')?.style.color).toBe(
      "rgb(78, 205, 196)"
    );
    expect(defs.get().spaces[0].color).toBe(COLOR);
  });
});
