// @vitest-environment jsdom
/**
 * The gates on `SwitcherView.alignToPane()` -- which permutations get the
 * alignment properties written, and which are left to the stylesheet.
 *
 * `stripAlign.test.ts` covers the arithmetic. This covers the wiring, which
 * the pure tests cannot see: whether the right boxes are measured, and
 * whether each gate actually stops the write.
 *
 * WHY THE PROTOTYPE STUB: jsdom performs no layout, so every
 * `getBoundingClientRect` is zeroes, every box is rejected as "not laid out",
 * and the properties come out cleared -- in EVERY case, gate or no gate. A
 * test written against that would pass with the gates deleted. Feeding real
 * rects in is what makes the gate the only thing left deciding, so a deleted
 * gate fails here. The numbers are the live measurements the feature was
 * designed against (strip left, All pinned, header shown).
 *
 * It is stubbed on the PROTOTYPE rather than on the elements because
 * `setUnlocked()` re-renders and rebuilds every child, which would throw away
 * stubs attached to individual nodes -- and the re-render is precisely what
 * the unlocked case needs to survive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { buildFakeVault } from "./helpers/fakeVault";
import { DEFAULT_DEFINITIONS, type SpaceDefinition } from "../src/types";

/** The live geometry, keyed by the element each rect belongs to. */
const TOOLBAR = { top: 40, height: 42 };
const HEADER = { top: 82, height: 26 };
const TREE_ROW = { top: 112, height: 25 };
const PINNED = { top: 46, height: 28 };
const RAIL_ICON = { top: 91, height: 28 };

const real = Element.prototype.getBoundingClientRect;

function rectFor(el: Element): { top: number; height: number } | null {
  if (el.classList.contains("nav-header")) return TOOLBAR;
  if (el.classList.contains("spaces-space-header")) return HEADER;
  if (el.classList.contains("tree-item-self")) return TREE_ROW;
  if (el.classList.contains("spaces-switcher-item")) {
    const rail = el.parentElement;
    if (!rail?.classList.contains("spaces-switcher-rail")) return PINNED;
    // Scrolling the rail moves its children up, and their rects follow. The
    // stub has to model that or a scrolled rail is indistinguishable from an
    // unscrolled one, and the compensation under test does nothing here.
    return { top: RAIL_ICON.top - rail.scrollTop, height: RAIL_ICON.height };
  }
  return null;
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const r = rectFor(this);
    if (!r) return real.call(this);
    return {
      top: r.top,
      height: r.height,
      bottom: r.top + r.height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: r.top,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = real;
});

const SPACES: SpaceDefinition[] = [
  { id: "a", name: "Garden", icon: "leaf", color: "#4ecdc4", members: [] },
  { id: "b", name: "Inbox", icon: "inbox", color: "#4ecdc4", members: [] },
];

async function build(withHeader = true) {
  let stored: unknown = {
    ...DEFAULT_DEFINITIONS,
    settings: { ...DEFAULT_DEFINITIONS.settings, pinAllSpace: true },
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

  // The pane rows the strip aligns to, in the order the explorer builds them.
  const host = document.createElement("div");
  host.appendChild(Object.assign(document.createElement("div"), { className: "nav-header" }));
  if (withHeader) {
    host.appendChild(
      Object.assign(document.createElement("div"), { className: "spaces-space-header" })
    );
  }
  const tree = Object.assign(document.createElement("div"), {
    className: "nav-files-container",
  });
  tree.appendChild(Object.assign(document.createElement("div"), { className: "tree-item-self" }));
  host.appendChild(tree);
  document.body.appendChild(host);

  switcher.mount(host);
  return { switcher, defs, host };
}

function props(host: HTMLElement): [string, string] {
  const strip = host.querySelector<HTMLElement>(".spaces-switcher");
  if (!strip) throw new Error("no strip");
  return [
    strip.style.getPropertyValue("--spaces-strip-pad-top"),
    strip.style.getPropertyValue("--spaces-strip-rail-gap"),
  ];
}

describe("alignment is applied", () => {
  it("writes both offsets for a vertical strip with All pinned", async () => {
    const { switcher, host } = await build();
    switcher.applyPlacement("left");
    // 7px centres the pinned icon on the toolbar; 6px centres the rail's
    // first icon on the header. Same numbers `stripAlign.test.ts` derives.
    expect(props(host)).toEqual(["7px", "6px"]);
  });

  it("applies to the right edge the same way as the left", async () => {
    const { switcher, host } = await build();
    switcher.applyPlacement("right");
    expect(props(host)).toEqual(["7px", "6px"]);
  });

  it("falls through to the first tree row when the header is hidden", async () => {
    const { switcher, host } = await build(false);
    switcher.applyPlacement("left");
    // The tree row's centre is 124.5 rather than the header's 95, so the gap
    // above the rail grows instead of shrinking.
    expect(props(host)).toEqual(["7px", "36px"]);
  });
});

describe("a scrolled rail", () => {
  it("keeps the same offsets however far the rail has been scrolled", async () => {
    // TWO FRESH STRIPS, ONE PASS EACH, rather than scrolling one and
    // re-solving. The stubbed rects are static: they do not move in response
    // to the padding a previous pass applied, so a second pass over the same
    // strip drifts by the amount the first pass moved things -- an artefact
    // of the stub, not of the solver, which live measurement shows settling
    // on the first pass. Comparing two first passes keeps the scroll the only
    // difference between them.
    const plain = await build();
    plain.switcher.applyPlacement("left");
    expect(props(plain.host)).toEqual(["7px", "6px"]);

    const scrolled = await build();
    const rail = scrolled.host.querySelector<HTMLElement>(".spaces-switcher-rail");
    if (!rail) throw new Error("no rail");
    rail.scrollTop = 150;
    scrolled.switcher.applyPlacement("left");
    // Without the compensation this is "156px": live, that left a hole above
    // the rail which survived scrolling back to the top.
    expect(props(scrolled.host)).toEqual(props(plain.host));
  });
});

describe("alignment is withheld", () => {
  it("leaves a horizontal strip to the stylesheet", async () => {
    const { switcher, host } = await build();
    switcher.applyPlacement("left");
    expect(props(host)).toEqual(["7px", "6px"]);
    switcher.applyPlacement("bottom");
    expect(props(host)).toEqual(["", ""]);
  });

  it("leaves the strip alone while it is unlocked", async () => {
    // The grip is inserted ahead of the pinned control, so nothing in the
    // strip is where alignment assumed. Both offsets would clamp to their
    // floors and sit the divider flush against its neighbours; the design
    // spacing is the better look for a transient editing mode.
    const { switcher, host } = await build();
    switcher.applyPlacement("left");
    expect(props(host)).toEqual(["7px", "6px"]);
    switcher.setUnlocked(true);
    expect(props(host)).toEqual(["", ""]);
    switcher.setUnlocked(false);
    expect(props(host)).toEqual(["7px", "6px"]);
  });

  it("leaves the strip alone when All is not pinned", async () => {
    const { switcher, defs, host } = await build();
    switcher.applyPlacement("left");
    expect(props(host)).toEqual(["7px", "6px"]);
    await defs.mutate((d) => {
      d.settings.pinAllSpace = false;
    });
    switcher.render();
    expect(props(host)).toEqual(["", ""]);
  });
});
