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
    spaces: [{ id: "a", name: "A", icon: "box", color: "#000000", members: [] }],
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

/**
 * The geometry the close threshold is read from: the pane's left edge and the
 * strip's layout width. jsdom reports 0 for both, so any test about the
 * threshold has to supply them.
 *
 * A width rather than a rect, deliberately: `offsetWidth` is what the view
 * hands the controller for the settled edge, because a `transform` does not
 * change it. The width is read through a getter so a test can move it.
 */
function paneGeometry(host: HTMLElement, left: number, width: () => number): void {
  Object.defineProperty(strip(host), "offsetWidth", { configurable: true, get: width });
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => ({ left }) as DOMRect);
}

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  hosts.splice(0).forEach((h) => h.remove());
  vi.restoreAllMocks();
});

const rail = (host: HTMLElement) => host.querySelector<HTMLElement>(".spaces-switcher-rail")!;
const icon = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-space-id="a"]')!;
const fire = (el: Element, type: string) =>
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));

const held = (view: SwitcherView) =>
  (view as unknown as { reveal: { isHeld(): boolean } | null }).reveal?.isHeld();

describe("hidden strip drags", () => {
  it("opens and holds when a drag enters the zone", async () => {
    const { view, host } = await build(true);
    zones(host)[0].dispatchEvent(new Event("dragenter", { bubbles: true }));
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
    expect(held(view)).toBe(true);
  });

  it("holds and opens for a reorder drag that starts inside the strip", async () => {
    const { view, host } = await build(true);
    fire(icon(host), "dragstart");
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
    expect(held(view)).toBe(true);
  });

  it("releases on dragend", async () => {
    const { view, host } = await build(true);
    fire(icon(host), "dragstart");
    fire(rail(host), "dragend");
    expect(held(view)).toBe(false);
  });

  it("releases on a reorder drop with no dragend after it", async () => {
    const { view, host } = await build(true);
    fire(icon(host), "dragstart");
    fire(rail(host), "drop");
    expect(held(view)).toBe(false);
  });

  it("releases on a file drop that ends early", async () => {
    const { view, host } = await build(true);
    zones(host)[0].dispatchEvent(new Event("dragenter", { bubbles: true }));
    fire(rail(host), "drop");
    expect(held(view)).toBe(false);
  });

  it("releases when the explorer reports the drag done", async () => {
    const { view, host } = await build(true);
    zones(host)[0].dispatchEvent(new Event("dragenter", { bubbles: true }));
    view.clearDropTarget();
    expect(held(view)).toBe(false);
  });

  it("recovers from an external drag that no release ever reaches", async () => {
    // An OS-originated drag has no dragstart or dragend in the page and is
    // dropped somewhere that is not the rail. Nothing releases; the first
    // pointer move afterwards must still close the strip.
    const { host } = await build(true);
    zones(host)[0].dispatchEvent(new Event("dragenter", { bubbles: true }));
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
    move(500);
    move(900);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
  });

  it("tolerates a drag with hiding off", async () => {
    const { host } = await build(false);
    expect(() => {
      fire(icon(host), "dragstart");
      fire(rail(host), "drop");
      fire(rail(host), "dragend");
    }).not.toThrow();
  });
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

  describe("a rebuild under a resting pointer", () => {
    const open = (host: HTMLElement) => host.classList.contains(CLS_STRIP_OPEN);

    it("keeps a revealed strip revealed", async () => {
      const { view, host } = await build(true);
      enter(zones(host)[0]);
      view.mount(host);
      expect(open(host)).toBe(true);
      expect(zones(host)).toHaveLength(1);
    });

    it("keeps a closed strip closed", async () => {
      const { view, host } = await build(true);
      view.mount(host);
      expect(open(host)).toBe(false);
    });

    it("does not carry a reveal across the setting being switched off", async () => {
      const { view, host, set } = await build(true);
      enter(zones(host)[0]);
      await set({ hideStrip: false });
      view.mount(host);
      expect(open(host)).toBe(false);
      expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
      expect(zones(host)).toHaveLength(0);
    });

    it("does not carry a reveal across the placement leaving left", async () => {
      const { view, host } = await build(true);
      enter(zones(host)[0]);
      view.applyPlacement("top");
      view.mount(host);
      expect(open(host)).toBe(false);
      expect(zones(host)).toHaveLength(0);
    });

    it("does not carry a reveal across a real teardown", async () => {
      const { view, host } = await build(true);
      enter(zones(host)[0]);
      view.destroy();
      expect(open(host)).toBe(false);
      view.mount(host);
      expect(open(host)).toBe(false);
    });

    it("closes on a pointer move right of the strip, and stays for one on it", async () => {
      const { view, host } = await build(true);
      paneGeometry(host, 0, () => 300);
      enter(zones(host)[0]);
      view.mount(host);
      // The rebuild made a new strip element, so the geometry goes on again.
      paneGeometry(host, 0, () => 300);
      move(100);
      expect(open(host)).toBe(true);
      move(500);
      expect(open(host)).toBe(false);
    });
  });

  it("keeps a revealed strip open under a pointer the slide has not reached", async () => {
    // The defect this threshold had: `getBoundingClientRect().right` runs
    // 50, 57, 63, 69, 74, 78, 81, 82 over the 120ms reveal (measured in the
    // running app), so a pointer at 70 -- inside the strip's settled 44..82
    // the whole time -- read as past the strip and closed it under the user.
    const { host } = await build(true);
    const painted = [50, 57, 63, 69, 74, 78, 81, 82];
    let frame = 0;
    paneGeometry(host, 44, () => 38);
    vi.spyOn(strip(host), "getBoundingClientRect").mockImplementation(
      () => ({ left: 44, right: painted[frame] }) as DOMRect
    );
    const revealed = () => host.classList.contains(CLS_STRIP_OPEN);
    enter(zones(host)[0]);
    expect(revealed()).toBe(true);
    for (frame = 0; frame < painted.length; frame++) {
      move(70);
      expect(revealed(), `painted edge at ${painted[frame]}`).toBe(true);
    }
    // Past the settled edge it still closes, which is the documented rule.
    move(83);
    expect(revealed()).toBe(false);
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

  it("re-measures the settled edge for every close decision", async () => {
    const { host } = await build(true);
    let width = 38;
    paneGeometry(host, 0, () => width);
    enter(zones(host)[0]);
    move(100);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    enter(zones(host)[0]);
    width = 300; // a wider strip, from a zoom or a theme change
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

describe("hidden strip keyboard and screen reader access", () => {
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
  const focusables = (host: HTMLElement) => Array.from(strip(host).querySelectorAll<HTMLElement>(FOCUSABLE));
  const tabindexes = (host: HTMLElement) => focusables(host).map((el) => el.getAttribute("tabindex"));

  it("keeps every strip control in the tab order while hidden", async () => {
    const { host } = await build(true);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    const controls = focusables(host);
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      const tab = el.getAttribute("tabindex");
      expect(tab === null || Number(tab) >= 0, `tabindex on ${el.className}`).toBe(true);
      expect(el.hasAttribute("disabled")).toBe(false);
      expect(el.hasAttribute("hidden")).toBe(false);
    }
    // Identical to the same strip un-hidden: hiding changed nothing here.
    const shown = await build(false);
    expect(tabindexes(host)).toEqual(tabindexes(shown.host));
  });

  it("leaves the strip and its ancestors in the accessibility tree while hidden", async () => {
    const { host } = await build(true);
    for (let el: HTMLElement | null = strip(host); el; el = el.parentElement) {
      expect(el.hasAttribute("aria-hidden"), `aria-hidden on ${el.className}`).toBe(false);
      expect(el.hasAttribute("inert")).toBe(false);
      expect(el.hasAttribute("hidden")).toBe(false);
      expect(el.style.display).not.toBe("none");
      expect(el.style.visibility).toBe("");
    }
    for (const el of Array.from(strip(host).querySelectorAll("*"))) {
      expect(el.getAttribute("aria-hidden")).not.toBe("true");
    }
  });

  it("still accepts focus while hidden", async () => {
    const { host } = await build(true);
    const target = focusables(host).find((el) => el.getAttribute("tabindex") !== "-1")!;
    target.focus();
    expect(document.activeElement).toBe(target);
  });
});

describe("hidden strip while unlocked", () => {
  const winRemove = () => vi.spyOn(window, "removeEventListener");

  it("restores a normal visible strip on unlock, and hides again on lock", async () => {
    const { view, host, defs } = await build(true);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    expect(zones(host)).toHaveLength(1);
    const remove = winRemove();
    view.setUnlocked(true);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
    expect(remove.mock.calls.some((c) => c[0] === "mousemove")).toBe(true);
    // The setting is untouched.
    expect(defs.get().settings.hideStrip).toBe(true);
    // No listeners left: a pointer move changes nothing.
    move(9999);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    view.setUnlocked(false);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    expect(zones(host)).toHaveLength(1);
    // And the rebuilt zone is live.
    enter(zones(host)[0]);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("leaves a revealed strip visible rather than stuck open on unlock", async () => {
    const { view, host } = await build(true);
    enter(zones(host)[0]);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
    view.setUnlocked(true);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
    view.setUnlocked(false);
    // Locking starts from a clean hidden strip, not a leftover open one.
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
  });

  it("stays visible through a re-dock while unlocked", async () => {
    const { view, host } = await build(true);
    view.setUnlocked(true);
    view.applyPlacement("left");
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
  });

  it("does not hide on lock when the setting is off", async () => {
    const { view, host } = await build(false);
    view.setUnlocked(true);
    view.setUnlocked(false);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
  });

  it("does not hide on lock when the placement is not left", async () => {
    const { view, host } = await build(true, "top");
    view.setUnlocked(true);
    view.setUnlocked(false);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
  });

  const reveal = (view: SwitcherView) => (view as unknown as { reveal: unknown }).reveal;

  it("stays fully visible through a pane rebuild while unlocked", async () => {
    const { view, host } = await build(true);
    // Revealed first, so a rebuild has something it could wrongly carry over.
    enter(zones(host)[0]);
    view.setUnlocked(true);
    view.mount(host);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(false);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    expect(zones(host)).toHaveLength(0);
    expect(reveal(view)).toBeNull();
  });

  it("hides again on lock after a rebuild while unlocked", async () => {
    const { view, host } = await build(true);
    view.setUnlocked(true);
    view.mount(host);
    view.setUnlocked(false);
    expect(host.classList.contains(CLS_STRIP_HIDDEN)).toBe(true);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    expect(zones(host)).toHaveLength(1);
    expect(reveal(view)).not.toBeNull();
    enter(zones(host)[0]);
    expect(host.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });
});
