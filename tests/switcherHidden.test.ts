// @vitest-environment jsdom
/**
 * The hidden strip, end to end through `SwitcherView`: the setting, the
 * placement, the rebuild and the teardown. The reveal controller and the dock
 * helpers have their own tests; this is the wiring that joins them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS, type StripPlacement } from "../src/types";
import { CLS_STRIP_HIDDEN, CLS_STRIP_OPEN, CLS_STRIP_ZONE } from "../src/explorer/selectors";

const hosts: HTMLElement[] = [];
const views: SwitcherView[] = [];

async function build(hideStrip: boolean, placement: StripPlacement = "left") {
  let stored: unknown = {
    ...DEFAULT_DEFINITIONS,
    settings: { ...DEFAULT_DEFINITIONS.settings, hideStrip, stripPlacement: placement },
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
  const controller = new SpaceController(
    defs,
    runtime,
    buildFakeVault({}),
    { apply: vi.fn(), livePaths: () => new Set<string>() },
    createMapTagIndex(new Map()),
    () => ({ status: "unavailable", unparsed: [] })
  );
  const view = new SwitcherView(
    defs,
    runtime,
    controller,
    () => undefined,
    () => false,
    () => undefined,
    {
      dragged: () => ({ paths: [], truncated: false }),
      onDropped: () => undefined,
      onRefused: () => undefined,
    }
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  views.push(view);
  view.mount(host);
  view.applyPlacement(placement);
  const set = (patch: Record<string, unknown>) =>
    defs.mutate((d) => {
      Object.assign(d.settings, patch);
    });
  return { view, host, defs, set };
}

const zones = (host: HTMLElement) => host.querySelectorAll(`.${CLS_STRIP_ZONE}`);
const strip = (host: HTMLElement) => host.querySelector<HTMLElement>(".spaces-switcher")!;
const enter = (el: Element) => el.dispatchEvent(new MouseEvent("mouseenter"));
const move = (clientX: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX }));

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  hosts.splice(0).forEach((h) => h.remove());
  vi.restoreAllMocks();
});

describe("hidden strip wiring", () => {
  it("hides the strip when the setting is on and the placement is left", async () => {
    const { host } = await build(true);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    expect(zones(host)).toHaveLength(1);
  });

  it("does not hide it with the setting off", async () => {
    const { host } = await build(false);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
  });

  it.each(["bottom", "top", "right"] as const)(
    "does not hide it for %s, whatever the setting says",
    async (placement) => {
      const { host } = await build(true, placement);
      expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
      expect(zones(host)).toHaveLength(0);
    }
  );

  it("re-establishes the hidden state after the pane is rebuilt", async () => {
    const { view, host } = await build(true);
    // What a space switch does: tear the pane down and mount again.
    view.mount(host);
    view.applyPlacement("left");
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    expect(zones(host)).toHaveLength(1);
    // And the rebuilt zone is live, not a leftover.
    enter(zones(host)[0]);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("is hidden straight after mount, before any applyPlacement", async () => {
    const { view, host } = await build(true);
    view.mount(host);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    expect(zones(host)).toHaveLength(1);
  });

  it("keeps one controller per pane across repeated placement applies", async () => {
    const { view, host } = await build(true);
    view.applyPlacement("left");
    view.applyPlacement("left");
    expect(zones(host)).toHaveLength(1);
  });

  it("stays open when the pane is re-docked while revealed", async () => {
    const { view, host } = await build(true);
    enter(zones(host)[0]);
    view.applyPlacement("left");
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("tears the controller down and unhides when the setting goes off", async () => {
    const { view, host, set } = await build(true);
    enter(zones(host)[0]);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
    const remove = vi.spyOn(window, "removeEventListener");
    await set({ hideStrip: false });
    // main.ts calls this on every definitions change.
    view.applyPlacement("left");
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
    expect(remove.mock.calls.some((c) => c[0] === "mousemove")).toBe(true);
  });

  it("tears the controller down when the placement leaves left", async () => {
    const { view, host } = await build(true);
    enter(zones(host)[0]);
    view.applyPlacement("top");
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
    // The watcher is gone: moving the pointer changes nothing.
    move(500);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
  });

  it("removes the zone and the document listeners when the view is destroyed", async () => {
    const { view, host } = await build(true);
    enter(zones(host)[0]);
    const remove = vi.spyOn(window, "removeEventListener");
    const removeDoc = vi.spyOn(document, "removeEventListener");
    view.destroy();
    expect(zones(host)).toHaveLength(0);
    expect(remove.mock.calls.some((c) => c[0] === "mousemove")).toBe(true);
    expect(removeDoc.mock.calls.some((c) => c[0] === "mouseleave")).toBe(true);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
  });

  it("measures the strip live for the close decision", async () => {
    const { host } = await build(true);
    let right = 38;
    vi.spyOn(strip(host), "getBoundingClientRect").mockImplementation(
      () => ({ right }) as DOMRect
    );
    enter(zones(host)[0]);
    move(100);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    enter(zones(host)[0]);
    right = 300;
    move(100);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("does not realign the strip on a reveal", async () => {
    const { host } = await build(true);
    const align = vi.spyOn(
      SwitcherView.prototype as unknown as { alignToPane(): void },
      "alignToPane"
    );
    const before = align.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      enter(zones(host)[0]);
      expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
      move(9999);
      expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    }
    expect(align.mock.calls.length).toBe(before);
  });
});
