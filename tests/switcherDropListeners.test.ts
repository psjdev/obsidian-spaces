// @vitest-environment jsdom
/**
 * The rail's own `dragover` and `drop`, against a real `SwitcherView` in a DOM.
 *
 * `switcherDrop.test.ts` pins the pure decision; this pins the LISTENERS that
 * spend it. That gap was real: the drop highlight had no assertion in any
 * layer, and deleting `markDropTarget`, the `is-drop-target` class and the
 * whole `dropTargetEl` field left lint, tsc and every unit test green.
 *
 * Three things are inseparable here and so are asserted together on each case:
 * whether the icon lights, whether the event is cancelled, and whether anything
 * is said. An icon that lights but does not cancel promises a drop the browser
 * will never deliver; one that cancels without lighting claims a gesture it
 * gives no feedback for; and a refusal that neither lights nor cancels NOR
 * speaks is indistinguishable from a feature that does not work.
 *
 * GEOMETRY: jsdom lays nothing out, so `pointerAlong` reads zero and the edge
 * auto-scroll is a no-op. That is fine and deliberate: scrolling is not what
 * this file is about, and `spaceReorder.test.ts` pins the arithmetic against
 * real numbers.
 */
import { describe, expect, it, vi } from "vitest";
import { SwitcherView } from "../src/ui/SwitcherView";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { SpaceController } from "../src/controller/SpaceController";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { buildFakeVault } from "./helpers/fakeVault";
import { CLIPPED_SELECTION } from "../src/ui/spaceDrop";
import { DEFAULT_DEFINITIONS, type SpaceDefinition } from "../src/types";
import type { DraggedFiles } from "../src/order/currentDrag";

const CURATED: SpaceDefinition = {
  id: "curated",
  name: "Work",
  icon: "box",
  color: "#808080",
  members: [],
};
const PINNED: SpaceDefinition = {
  id: "pinned",
  name: "Clients",
  icon: "folder",
  color: "#808080",
  root: "Clients",
  members: [],
};

interface Harness {
  host: HTMLElement;
  switcher: SwitcherView;
  onDropped: ReturnType<typeof vi.fn>;
  onRefused: ReturnType<typeof vi.fn>;
  drag: DraggedFiles;
  rootPresent: boolean;
}

/**
 * `drag` and `rootPresent` are mutable on the harness rather than captured, so
 * one mounted strip can be asked several questions in the order a real drag
 * would ask them. Both are read through the callbacks on every event, which is
 * the point: the view must never cache either.
 */
async function build(): Promise<Harness> {
  let stored: unknown = { ...DEFAULT_DEFINITIONS, spaces: [CURATED, PINNED] };
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
    createMapTagIndex(new Map())
  );
  const onDropped = vi.fn();
  const onRefused = vi.fn();
  const h = {
    onDropped,
    onRefused,
    drag: { paths: [] as readonly string[], truncated: false },
    rootPresent: true,
  };
  const switcher = new SwitcherView(
    defs,
    runtime,
    controller,
    () => undefined,
    () => false,
    () => undefined,
    {
      dragged: () => h.drag,
      rootExists: () => h.rootPresent,
      onDropped: (spaceId, drag) => onDropped(spaceId, drag),
      onRefused: (reason) => onRefused(reason),
    }
  );
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  switcher.mount(host);
  return Object.assign(h, { host, switcher });
}

function iconFor(host: HTMLElement, id: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-space-id="${id}"]`);
  if (!el) throw new Error(`no switcher icon for ${id}`);
  return el;
}

/** *All* renders as a switcher item with no `data-space-id`, which is what makes it decline. */
function allIcon(host: HTMLElement): HTMLElement {
  const el = Array.from(host.querySelectorAll<HTMLElement>(".spaces-switcher-item")).find(
    (e) => e.dataset.spaceId === undefined
  );
  if (!el) throw new Error("no *All* icon in the strip");
  return el;
}

function send(el: HTMLElement, type: string): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

/** Which icons in the strip are wearing the drop mark. */
function lit(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>(".is-drop-target")).map(
    (e) => e.dataset.spaceId ?? "(no id)"
  );
}

describe("the rail's dragover marks only a target that would act", () => {
  it("lights a curated icon and cancels the event", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    const e = send(iconFor(h.host, "curated"), "dragover");
    expect(lit(h.host)).toEqual(["curated"]);
    expect(e.defaultPrevented).toBe(true);
    expect(h.onRefused).not.toHaveBeenCalled();
  });

  it("lights a folder-pinned icon and cancels the event", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    const e = send(iconFor(h.host, "pinned"), "dragover");
    expect(lit(h.host)).toEqual(["pinned"]);
    expect(e.defaultPrevented).toBe(true);
  });

  // The negative that matters most: *All* holds no members, so it is not a
  // target, and the event has to pass through untouched.
  it("neither lights nor cancels over All", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    const e = send(allIcon(h.host), "dragover");
    expect(lit(h.host)).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    expect(h.onRefused).not.toHaveBeenCalled();
  });

  it("neither lights nor cancels when no file drag is live", async () => {
    const h = await build();
    const e = send(iconFor(h.host, "curated"), "dragover");
    expect(lit(h.host)).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  // A folder space keeps its root string after the folder is deleted, so this
  // icon used to light and then fail every rename behind the drop.
  it("neither lights nor cancels for a folder space whose root is gone", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    h.rootPresent = false;
    const e = send(iconFor(h.host, "pinned"), "dragover");
    expect(lit(h.host)).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    // Silent: the space's own empty state already explains a missing root.
    expect(h.onRefused).not.toHaveBeenCalled();
  });

  it("moves the mark rather than leaving two icons lit", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    send(iconFor(h.host, "curated"), "dragover");
    send(iconFor(h.host, "pinned"), "dragover");
    expect(lit(h.host)).toEqual(["pinned"]);
  });

  it("takes the mark off when the pointer leaves the rail", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    send(iconFor(h.host, "curated"), "dragover");
    expect(lit(h.host)).toEqual(["curated"]);
    iconFor(h.host, "curated").dispatchEvent(
      new MouseEvent("dragleave", { bubbles: true, relatedTarget: document.body })
    );
    expect(lit(h.host)).toEqual([]);
  });

  it("takes the mark off when a drag ends without the pointer moving", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    send(iconFor(h.host, "curated"), "dragover");
    // A file drag's source is a tree row, so the rail hears no `dragend`. This
    // is the callback `main.ts` spends `DragOrdering`'s drag-done hook on, and
    // that hook fires at each drag's end AND at the next drag's `dragstart`.
    // (It used to be described as learning of every drag "however it ended",
    // which was not true: see `clearDropTarget`.)
    h.switcher.clearDropTarget();
    expect(lit(h.host)).toEqual([]);
  });
});

describe("the rail's dragover refuses a clipped selection out loud", () => {
  /**
   * The merge blocker, at the layer the user meets it.
   *
   * No light, because an icon that lights and then refuses is the exact failure
   * the decision seam exists to prevent. No cancel, so the browser shows "no
   * drop" and fires no `drop` at all. And therefore words, because with no
   * `drop` event there is no later moment to speak from and silence would read
   * as a broken feature.
   */
  it("neither lights nor cancels, and says why", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md", "Notes/b.md"], truncated: true };
    const e = send(iconFor(h.host, "pinned"), "dragover");
    expect(lit(h.host)).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    expect(h.onRefused).toHaveBeenCalledTimes(1);
    expect(h.onRefused).toHaveBeenCalledWith(CLIPPED_SELECTION);
  });

  it("refuses a clipped drag on a curated space too", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: true };
    const e = send(iconFor(h.host, "curated"), "dragover");
    expect(lit(h.host)).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    expect(h.onRefused).toHaveBeenCalledTimes(1);
  });

  // `dragover` fires every few pixels of pointer travel, so the guard is what
  // stands between one explanation and a stack of identical notices.
  it("says it once per drag however many dragovers arrive", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: true };
    for (let i = 0; i < 5; i++) send(iconFor(h.host, "pinned"), "dragover");
    send(iconFor(h.host, "curated"), "dragover");
    expect(h.onRefused).toHaveBeenCalledTimes(1);
  });

  it("explains the next drag as well", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: true };
    send(iconFor(h.host, "pinned"), "dragover");
    h.switcher.clearDropTarget();
    send(iconFor(h.host, "pinned"), "dragover");
    expect(h.onRefused).toHaveBeenCalledTimes(2);
  });

  // Over *All* there is nothing to explain: that icon was never a target, and
  // the "no drop" cursor says so on its own.
  it("stays quiet over a target that was never a target", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: true };
    send(allIcon(h.host), "dragover");
    expect(h.onRefused).not.toHaveBeenCalled();
  });

  it("never hands a clipped drag to the write, even if a drop reaches it", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: true };
    // A drop cannot arrive after a refused dragover, since nothing cancelled
    // it. Dispatched anyway, because the cost of being wrong here is an
    // irreversible partial move.
    const e = send(iconFor(h.host, "pinned"), "drop");
    expect(h.onDropped).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("a reorder drag still takes the old branch", () => {
  /**
   * The regression guard for the second meaning this drop target gained.
   * `dragFromId` is the discriminator, set by the icon's own `dragstart`, and
   * the reorder branch must stay exactly as it was: cancel the event, draw no
   * drop mark, and leave the file-drop seam alone.
   */
  it("cancels the event and draws no drop mark", async () => {
    const h = await build();
    // A file drag is live at the same time, so a branch that read the record
    // instead of `dragFromId` would light an icon here.
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    send(iconFor(h.host, "curated"), "dragstart");
    const e = send(iconFor(h.host, "pinned"), "dragover");
    expect(e.defaultPrevented).toBe(true);
    expect(lit(h.host)).toEqual([]);
    expect(h.onRefused).not.toHaveBeenCalled();
  });

  it("does not run the file drop on a reorder drop", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    send(iconFor(h.host, "curated"), "dragstart");
    send(iconFor(h.host, "pinned"), "drop");
    expect(h.onDropped).not.toHaveBeenCalled();
  });
});

describe("the rail's drop spends the same answer the dragover showed", () => {
  it("hands the whole record to the write", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md", "Notes/b.md"], truncated: false };
    send(iconFor(h.host, "curated"), "dragover");
    const e = send(iconFor(h.host, "curated"), "drop");
    expect(e.defaultPrevented).toBe(true);
    expect(h.onDropped).toHaveBeenCalledWith("curated", {
      paths: ["Notes/a.md", "Notes/b.md"],
      truncated: false,
    });
    // And the mark goes with the drop, rather than waiting for a teardown.
    expect(lit(h.host)).toEqual([]);
  });

  it("does nothing for a drop over All", async () => {
    const h = await build();
    h.drag = { paths: ["Notes/a.md"], truncated: false };
    const e = send(allIcon(h.host), "drop");
    expect(h.onDropped).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
