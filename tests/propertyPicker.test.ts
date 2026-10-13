// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { byKey, makeHarness, panelEl, resetPanelDom, type Harness } from "./helpers/createPanel";
import { noticeLog } from "./helpers/obsidian-stub";
import { validateDefinitions } from "../src/definitions/schema";
import { isPickableKey, holdsProperty } from "../src/ui/propertyRows";
import {
  createPropertyIndex,
  type PropertyIndex,
  type PropertySnapshot,
} from "../src/visibility/PropertyIndex";
import { SpaceController } from "../src/controller/SpaceController";
import { DefinitionStore } from "../src/definitions/DefinitionStore";
import { RuntimeStateStore } from "../src/runtime/RuntimeStateStore";
import { buildFakeVault } from "./helpers/fakeVault";
import { createMapTagIndex } from "../src/visibility/TagIndex";
import { VAULT_COALESCE_WINDOW_MS, createVaultChangeCoalescer } from "../src/lifecycle/eventCoalescer";
import { PropertyRefreshHub } from "../src/ui/PropertyRefreshHub";
import {
  RefreshFlushState,
  installThenNotify,
  submitMetadataWork,
  submitVaultWork,
  metadataNotifyRoute,
} from "../src/lifecycle/refreshFlush";

/** Lets the coalescer's promise chain run far enough to schedule its timer. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A timer the test advances by hand. */
const manualTimer = () => {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timer: {
      set: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (id: number) => void pending.delete(id),
      now: () => now,
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
};

/**
 * Stands in for the plugin class, which needs an Obsidian runtime. It is built
 * from the same real pieces `main.ts` uses (the hub, both coalescers, the
 * install-then-notify step and the route decision) and mirrors main.ts's
 * handlers. It is a mirror, not the plugin: it proves those pieces behave as
 * the handlers rely on, not that the handlers call them. It holds no spaces,
 * so no space's membership can be what keeps a picker fresh.
 */
const fakePlugin = (opts: { spaceWatchesMetadata?: boolean } = {}) => {
  const hub = new PropertyRefreshHub();
  const clock = manualTimer();
  const state = new RefreshFlushState();
  const log: string[] = [];
  const finish = (rebuild: boolean) =>
    installThenNotify(
      () => {
        if (rebuild) log.push("install");
      },
      () => {
        log.push("notify");
        hub.notify();
      }
    );
  const vaultChanges = createVaultChangeCoalescer({
    timer: clock.timer,
    flush: () => {
      const { rebuild } = state.take();
      finish(rebuild);
    },
  });
  const vaultEvent = () => {
    void submitVaultWork((w) => vaultChanges.submit(w), state, async () => undefined);
  };
  const metadataEvent = () => {
    log.push("install"); // onMetadataEvent installs a fresh lazy snapshot per event
    const route = metadataNotifyRoute(opts.spaceWatchesMetadata ?? false, hub.size);
    if (route === "none") return;
    if (route === "picker-flush") void vaultChanges.submit(async () => undefined);
    else void submitMetadataWork((w) => vaultChanges.submit(w), state);
    state.noteSnapshotInstalled();
  };
  return {
    log,
    subscribePropertyRefresh: (onChange: () => void) => hub.subscribe(onChange),
    emitMetadataChanged: metadataEvent,
    emitResolved: metadataEvent,
    emitVaultEvent: vaultEvent,
    settle: () => clock.advance(10_000),
    unload: () => {
      hub.clear();
      vaultChanges.cancel();
    },
  };
};

describe("an open picker is its own metadata consumer", () => {
  it("is notified for metadata, resolved and vault events with no space watching", async () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    plugin.subscribePropertyRefresh(onChange);
    for (const emit of [plugin.emitVaultEvent, plugin.emitMetadataChanged, plugin.emitResolved]) {
      emit();
      await tick();
      plugin.settle();
    }
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("delivers nothing after the returned unsubscribe runs", async () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    const release = plugin.subscribePropertyRefresh(onChange);
    plugin.emitMetadataChanged();
    await tick();
    plugin.settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    plugin.emitMetadataChanged();
    plugin.emitVaultEvent();
    await tick();
    plugin.settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops every subscription on unload", async () => {
    const plugin = fakePlugin();
    const a = vi.fn();
    plugin.subscribePropertyRefresh(a);
    plugin.emitMetadataChanged();
    plugin.unload();
    await tick();
    plugin.settle();
    expect(a).not.toHaveBeenCalled();
  });
});

describe("one notification per burst", () => {
  it("notifies once for a burst of metadata events", async () => {
    const plugin = fakePlugin();
    const onChange = vi.fn();
    plugin.subscribePropertyRefresh(onChange);
    for (let i = 0; i < 50; i++) plugin.emitMetadataChanged();
    await tick();
    plugin.settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("notifies once, from the vault flush, when the space watches metadata", async () => {
    const plugin = fakePlugin({ spaceWatchesMetadata: true });
    const onChange = vi.fn();
    plugin.subscribePropertyRefresh(onChange);
    plugin.emitMetadataChanged();
    await tick();
    expect(onChange).not.toHaveBeenCalled(); // no direct call ahead of the flush
    plugin.settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(plugin.log).toEqual(["install", "notify"]); // one rebuild, not two
  });
});

describe("metadataNotifyRoute", () => {
  it("rides the vault flush whenever the space watches metadata", () => {
    expect(metadataNotifyRoute(true, 0)).toBe("vault-flush");
    expect(metadataNotifyRoute(true, 2)).toBe("vault-flush");
  });
  it("schedules a picker-only flush only while a picker is open", () => {
    expect(metadataNotifyRoute(false, 1)).toBe("picker-flush");
    expect(metadataNotifyRoute(false, 0)).toBe("none");
  });
});

describe("installThenNotify", () => {
  it("installs the snapshot before the notify fires", () => {
    const order: string[] = [];
    installThenNotify(
      () => order.push("install"),
      () => order.push("notify")
    );
    expect(order).toEqual(["install", "notify"]);
  });

  it("tells nobody when the install throws", () => {
    const notify = vi.fn();
    expect(() =>
      installThenNotify(() => {
        throw new Error("no snapshot");
      }, notify)
    ).toThrow("no snapshot");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("PropertyRefreshHub", () => {
  it("releases only its own subscription, even for the same function", () => {
    const hub = new PropertyRefreshHub();
    const onChange = vi.fn();
    const first = hub.subscribe(onChange);
    hub.subscribe(onChange);
    first();
    hub.notify();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("is safe to release twice", () => {
    const hub = new PropertyRefreshHub();
    const onChange = vi.fn();
    const release = hub.subscribe(onChange);
    release();
    release();
    hub.notify();
    expect(onChange).not.toHaveBeenCalled();
    expect(hub.size).toBe(0);
  });

  it("does not call a watcher released mid-notify, and survives one that throws", () => {
    const hub = new PropertyRefreshHub();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const later = vi.fn();
    let releaseLater = () => {};
    hub.subscribe(() => {
      releaseLater();
      throw new Error("boom");
    });
    releaseLater = hub.subscribe(later);
    const survivor = vi.fn();
    hub.subscribe(survivor);
    hub.notify();
    expect(later).not.toHaveBeenCalled();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("a mixed burst", () => {
  it("creating a note (vault event plus metadata event) notifies once and rebuilds once", async () => {
    // No space watches metadata and a picker is open: the case that used to
    // reach two coalescers, so two flushes, so two notifies and two walks.
    const plugin = fakePlugin();
    const onChange = vi.fn();
    plugin.subscribePropertyRefresh(onChange);
    plugin.emitVaultEvent(); // create
    plugin.emitMetadataChanged(); // changed
    await tick();
    plugin.settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(plugin.log).toEqual(["install", "notify"]); // one rebuild, one generation bump
  });
});

describe("RefreshFlushState", () => {
  it("rebuilds on a full flush when no snapshot was installed after the vault event", () => {
    const state = new RefreshFlushState();
    state.noteSnapshotInstalled();
    state.noteVaultEvent(); // arrived after the install: a picker may have read it
    state.markFull();
    expect(state.take()).toEqual({ full: true, recompute: true, rebuild: true });
  });
  it("does not rebuild when the install postdates the vault event", () => {
    const state = new RefreshFlushState();
    state.noteVaultEvent();
    state.markFull();
    state.noteSnapshotInstalled();
    expect(state.take()).toEqual({ full: true, recompute: true, rebuild: false });
  });
  it("recomputes without a re-index for a metadata burst, and never rebuilds", () => {
    const state = new RefreshFlushState();
    state.markRecompute();
    state.noteSnapshotInstalled();
    expect(state.take()).toEqual({ full: false, recompute: true, rebuild: false });
    state.markRecompute();
    expect(state.take()).toEqual({ full: false, recompute: true, rebuild: false });
  });
  it("is not full for a metadata-only burst, and resets after take", () => {
    const state = new RefreshFlushState();
    state.noteSnapshotInstalled();
    expect(state.take()).toEqual({ full: false, recompute: false, rebuild: false });
    state.noteVaultEvent();
    state.markFull();
    expect(state.take()).toEqual({ full: true, recompute: true, rebuild: true });
    expect(state.take()).toEqual({ full: false, recompute: false, rebuild: false });
  });
});

describe("a slow repair overlapping an earlier burst's timer", () => {
  it("still gets its own full flush", async () => {
    const clock = manualTimer();
    const state = new RefreshFlushState();
    const flushes: boolean[] = [];
    const coalescer = createVaultChangeCoalescer({
      timer: clock.timer,
      flush: () => flushes.push(state.take().full),
    });
    const submit = (w: () => Promise<unknown>) => coalescer.submit(w);

    void submitVaultWork(submit, state, async () => undefined); // event A at t0
    await tick();
    clock.advance(VAULT_COALESCE_WINDOW_MS - 10); // t40
    let finish = () => {};
    const slow = submitVaultWork(
      submit,
      state,
      () => new Promise<void>((resolve) => (finish = resolve))
    ); // event B: a slow repair still running
    await tick(); // B's work has started
    clock.advance(10); // A's timer fires while B's work is in flight
    expect(flushes).toEqual([true]);
    finish();
    await slow;
    clock.advance(10_000);
    // B's own flush must also be a full one, not an empty leftover.
    expect(flushes).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------
// The Properties body of the create panel.
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetPanelDom();
  noticeLog.length = 0;
});

type Notes = Record<string, Record<string, unknown>>;

const indexOf = (notes: Notes): PropertyIndex =>
  createPropertyIndex(
    Object.entries(notes).map(([path, frontmatter]) => ({ path, frontmatter })),
    1
  );

/** An index that records every key `listValues` was asked about. */
function counting(index: PropertyIndex): { index: PropertyIndex; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    index: {
      ...index,
      listValues: (key) => {
        asked.push(key);
        return index.listValues(key);
      },
    },
  };
}

const ready = (index: PropertyIndex) => (): PropertyIndex => index;

function openProperties(over: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(over);
  byKey("mode-curate").click();
  byKey("body-properties").click();
  return h;
}

const keyRows = (): HTMLElement[] =>
  Array.from(panelEl().querySelectorAll<HTMLElement>("[data-property-key]"));
const offered = (): Array<string | undefined> => keyRows().map((r) => r.dataset.propertyKey);
const keyRow = (key: string): HTMLElement => {
  const row = keyRows().find((r) => r.dataset.propertyKey === key);
  if (!row) throw new Error(`no row for key ${JSON.stringify(key)}; have ${JSON.stringify(offered())}`);
  return row;
};
const expandBtn = (key: string): HTMLElement =>
  keyRow(key).querySelector<HTMLElement>(".spaces-create-property-disclose")!;
const selectBtn = (key: string): HTMLElement =>
  keyRow(key).querySelector<HTMLElement>(".spaces-create-property-select")!;
const valueBtns = (): HTMLElement[] =>
  Array.from(panelEl().querySelectorAll<HTMLElement>(".spaces-create-property-value"));
const labelOf = (b: HTMLElement): string =>
  b.querySelector(".spaces-create-tree-name")?.textContent ?? "";
const valueLabels = (): string[] => valueBtns().map(labelOf);
const valueBtn = (label: string): HTMLElement => {
  const b = valueBtns().find((x) => labelOf(x) === label);
  if (!b) throw new Error(`no value row ${JSON.stringify(label)}; have ${JSON.stringify(valueLabels())}`);
  return b;
};
/** The key's own name cell, which is what a person reading the row clicks. */
const keyName = (key: string): HTMLElement =>
  keyRow(key).querySelector<HTMLElement>(".spaces-create-tree-name")!;
/** The row a value button sits in, including the indent gutter left of it. */
const valueRow = (label: string): HTMLElement => valueBtn(label).parentElement as HTMLElement;
const valueName = (label: string): HTMLElement =>
  valueBtn(label).querySelector<HTMLElement>(".spaces-create-tree-name")!;
const summary = (): string => panelEl().querySelector(".spaces-create-summary")?.textContent ?? "";
const emptyMessage = (): string =>
  panelEl().querySelector(".spaces-create-tree-empty")?.textContent ?? "";

/** What Create would store, read from the real submit rather than from state. */
async function storedMembers(h: Harness): Promise<unknown> {
  const input = byKey("name") as HTMLInputElement;
  input.value = "S";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  byKey("create").click();
  await vi.waitFor(() => expect(h.submitted).toHaveLength(1));
  return h.submitted[0].opts.members;
}

describe("which keys the properties body offers", () => {
  it("never offers tags or tag, and offers the rest by name", () => {
    const index = indexOf({
      "a.md": { status: "x", tags: ["t"], tag: "t", due: "d" },
    });
    openProperties({ properties: ready(index) });
    expect(offered()).toEqual(["due", "status"]);
  });

  it("never offers a key the schema would reject, and offers a padded one as spelled", () => {
    const index = indexOf({ "a.md": { "": 1, "   ": 2, " status ": 3 } });
    openProperties({ properties: ready(index) });
    expect(offered()).toEqual([" status "]);
  });

  it("agrees with the loader: nothing the loader rejects is pickable", () => {
    const doc = (key: string): unknown => ({
      schemaVersion: 3,
      spaces: [
        { id: "s", name: "S", icon: "box", color: "#808080", members: [{ kind: "property", key }] },
      ],
      settings: {},
    });
    for (const key of ["", " ", "   ", "\t", " status ", "a=b", "tags", "tag"]) {
      const loads = validateDefinitions(doc(key)).ok;
      if (!loads) expect(isPickableKey(key), JSON.stringify(key)).toBe(false);
    }
    // The two hidden aliases DO load. The matcher stays honest about a stored
    // member naming them; hiding them is the picker's decision alone.
    expect(validateDefinitions(doc("tags")).ok).toBe(true);
    expect(validateDefinitions(doc("tag")).ok).toBe(true);
    expect(isPickableKey("tags")).toBe(false);
    expect(isPickableKey("tag")).toBe(false);
  });

  it("never offers tags or tag in any case, because Obsidian reads them all as the alias", () => {
    const index = indexOf({ "a.md": { Tags: ["t"], TAG: "t", Tag: "t", status: "x" } });
    openProperties({ properties: ready(index) });
    expect(offered()).toEqual(["status"]);
  });

  it("lists keys in alphabet order, not code-unit order", () => {
    const index = indexOf({ "a.md": { zeta: 1, Beta: 2, alpha: 3, Alpha: 4 } });
    openProperties({ properties: ready(index) });
    // Code-unit order would put both capitals first: Alpha, Beta, alpha, zeta.
    expect(offered()).toEqual(["Alpha", "alpha", "Beta", "zeta"]);
  });

  it("narrows by key name only", () => {
    const index = indexOf({ "a.md": { status: "start", due: "x", owner: "stan" } });
    openProperties({ properties: ready(index) });
    const filter = byKey("item-filter") as HTMLInputElement;
    filter.value = "st";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    // `owner` has the value "stan" and does not match: values are not searched.
    expect(offered()).toEqual(["status"]);
  });
});

describe("expanding and selecting are separate actions", () => {
  const notes: Notes = { "a.md": { status: "active" }, "b.md": { status: "done" } };

  it("expanding a key shows its values and selects nothing", () => {
    openProperties({ properties: ready(indexOf(notes)) });
    expandBtn("status").click();
    expect(valueLabels()).toEqual(["active", "done"]);
    expect(summary()).toBe("Nothing selected");
    // Read back from the redraw, which draws held members as pressed.
    expect(selectBtn("status").getAttribute("aria-pressed")).toBe("false");
    expect(valueBtns().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
  });

  it("selecting a key adds the existence shape and expands nothing", async () => {
    const h = openProperties({ properties: ready(indexOf(notes)) });
    selectBtn("status").click();
    expect(valueBtns()).toHaveLength(0);
    expect(expandBtn("status").getAttribute("aria-expanded")).toBe("false");
    expect(await storedMembers(h)).toEqual([{ kind: "property", key: "status" }]);
  });

  it("each control is its own button inside the key row", () => {
    openProperties({ properties: ready(indexOf(notes)) });
    expect(expandBtn("status").tagName).toBe("BUTTON");
    expect(selectBtn("status").tagName).toBe("BUTTON");
    expect(expandBtn("status")).not.toBe(selectBtn("status"));
    expect(keyRow("status").contains(expandBtn("status"))).toBe(true);
    expect(keyRow("status").contains(selectBtn("status"))).toBe(true);
  });

  it("the key select control reads Has property", () => {
    openProperties({ properties: ready(indexOf(notes)) });
    expect(selectBtn("status").textContent).toBe("Has property");
  });

  it("selecting a value adds the equality shape in the authored spelling", async () => {
    const h = openProperties({
      properties: ready(indexOf({ "a.md": { status: " active " } })),
    });
    expandBtn("status").click();
    valueBtn(" active ").click();
    expect(await storedMembers(h)).toEqual([
      { kind: "property", key: "status", value: " active " },
    ]);
  });

  it("labels the empty-string value so it is not an empty row", async () => {
    const h = openProperties({ properties: ready(indexOf({ "a.md": { x: "" } })) });
    expandBtn("x").click();
    expect(valueLabels()).toEqual(["Empty string"]);
    expect(selectBtn("x").textContent).toBe("Has property");
    valueBtn("Empty string").click();
    expect(await storedMembers(h)).toEqual([{ kind: "property", key: "x", value: "" }]);
  });

  it("a value row names its key and its count, so two keys sharing a value are told apart", () => {
    // The count span is a CHILD of this button and `aria-label` replaces the
    // accessible name, so a count left out of the label is a count a screen
    // reader can never reach. The key row announces its own, because there
    // the count is a sibling.
    const index = indexOf({ "a.md": { status: "done", phase: "done" } });
    openProperties({ properties: ready(index) });
    expandBtn("status").click();
    expandBtn("phase").click();
    expect(valueBtns().map((b) => b.getAttribute("aria-label")).sort()).toEqual([
      "phase equals done, 1 note",
      "status equals done, 1 note",
    ]);
  });

  it("the disclosure OWNS the rows it reveals, and owns nothing while closed", () => {
    // `aria-expanded` with no `aria-controls` names a state with no subject:
    // the value rows are SIBLINGS of their key row, so the indentation that
    // carries the nesting for the eye carried nothing for anyone else.
    openProperties({ properties: ready(indexOf({ "a.md": { status: "done" }, "b.md": { status: "live" } })) });
    expect(expandBtn("status").getAttribute("aria-controls")).toBeNull();
    expandBtn("status").click();
    const owned = expandBtn("status").getAttribute("aria-controls")!.split(" ");
    expect(owned).toHaveLength(2);
    expect(owned.map((id) => panelEl().querySelector(`#${id}`)).map((el) => el !== null)).toEqual([
      true,
      true,
    ]);
    expect(owned.map((id) => labelOf(panelEl().querySelector(`#${id}`) as HTMLElement))).toEqual([
      "done",
      "live",
    ]);
    expandBtn("status").click();
    expect(expandBtn("status").getAttribute("aria-controls")).toBeNull();
  });

  it("a value with a slash is one row", () => {
    const index = indexOf({ "a.md": { path: "Work/Notes" }, "b.md": { path: "a/b/c" } });
    openProperties({ properties: ready(index) });
    expandBtn("path").click();
    expect(valueLabels().sort()).toEqual(["Work/Notes", "a/b/c"]);
  });
});

/**
 * The ROW is the target, not one button inside it.
 *
 * A picker row advertises a click across its whole width: `cursor: pointer`
 * and a row-wide hover, both inherited from `.spaces-create-tree-row`. The
 * key row used to take one only on the "Has property" button at its right
 * edge, so clicking the key's own NAME did nothing and said nothing, and a
 * value row left an inert gutter under its indent. The Vault and Tags bodies
 * have always made the whole row the target; these say the Properties body
 * does too, with the caret still the one control that opens without choosing.
 */
describe("the whole property row is the target", () => {
  const notes: Notes = {
    "a.md": { status: "active", due: "2026-01-01" },
    "b.md": { status: "done" },
  };

  it("selects the key's existence member when its NAME is clicked", async () => {
    const h = openProperties({ properties: ready(indexOf(notes)) });
    keyName("status").click();
    expect(selectBtn("status").getAttribute("aria-pressed")).toBe("true");
    expect(keyRow("status").classList.contains("is-selected")).toBe(true);
    expect(await storedMembers(h)).toEqual([{ kind: "property", key: "status" }]);
  });

  it("selects it from the row itself, left of every control", async () => {
    const h = openProperties({ properties: ready(indexOf(notes)) });
    keyRow("status").click();
    expect(await storedMembers(h)).toEqual([{ kind: "property", key: "status" }]);
  });

  it("opens on the caret and selects nothing, opening or closing", () => {
    openProperties({ properties: ready(indexOf(notes)) });
    expandBtn("status").click();
    expect(valueLabels()).toEqual(["active", "done"]);
    expect(summary()).toBe("Nothing selected");
    expect(keyRow("status").classList.contains("is-selected")).toBe(false);
    expandBtn("status").click();
    expect(valueBtns()).toHaveLength(0);
    expect(summary()).toBe("Nothing selected");
  });

  it("selects a value member from the value row, not only from its button", async () => {
    const h = openProperties({ properties: ready(indexOf(notes)) });
    expandBtn("status").click();
    valueRow("active").click();
    expect(await storedMembers(h)).toEqual([
      { kind: "property", key: "status", value: "active" },
    ]);
  });

  it("selects a value member when its NAME is clicked", async () => {
    const h = openProperties({ properties: ready(indexOf(notes)) });
    expandBtn("status").click();
    valueName("done").click();
    expect(await storedMembers(h)).toEqual([
      { kind: "property", key: "status", value: "done" },
    ]);
  });

  it("holds BOTH when two different keys are picked in one sitting", async () => {
    const h = openProperties({ properties: ready(indexOf(notes)) });
    keyName("status").click();
    keyName("due").click();
    expect(selectBtn("status").getAttribute("aria-pressed")).toBe("true");
    expect(selectBtn("due").getAttribute("aria-pressed")).toBe("true");
    expect(summary()).toContain("2 properties");
    expect(await storedMembers(h)).toEqual([
      { kind: "property", key: "status" },
      { kind: "property", key: "due" },
    ]);
  });

  it("holds BOTH when a key and another key's value are picked in one sitting", async () => {
    const h = openProperties({ properties: ready(indexOf(notes)) });
    keyName("due").click();
    expandBtn("status").click();
    valueRow("done").click();
    expect(await storedMembers(h)).toEqual([
      { kind: "property", key: "due" },
      { kind: "property", key: "status", value: "done" },
    ]);
  });
});

describe("a member already held", () => {
  it("comes off on a second click, for a key, from either way in", async () => {
    const h = openProperties({ properties: ready(indexOf({ "a.md": { status: "x" } })) });
    selectBtn("status").click();
    expect(selectBtn("status").getAttribute("aria-pressed")).toBe("true");
    selectBtn("status").click();
    expect(selectBtn("status").getAttribute("aria-pressed")).toBe("false");
    expect(summary()).toBe("Nothing selected");
    // The row is a way out as well as a way in, the same as the button.
    keyName("status").click();
    expect(selectBtn("status").getAttribute("aria-pressed")).toBe("true");
    keyRow("status").click();
    expect(selectBtn("status").getAttribute("aria-pressed")).toBe("false");
    // Never a notice: a toggle has nothing to report that the row is not
    // already showing.
    expect(noticeLog).toHaveLength(0);
    expect(await storedMembers(h)).toEqual([]);
  });

  it("comes off on a second click, for a value, leaving the key alone", async () => {
    const h = openProperties({ properties: ready(indexOf({ "a.md": { status: "x" } })) });
    selectBtn("status").click();
    expandBtn("status").click();
    valueBtn("x").click();
    expect(valueBtn("x").getAttribute("aria-pressed")).toBe("true");
    valueBtn("x").click();
    expect(valueBtn("x").getAttribute("aria-pressed")).toBe("false");
    expect(noticeLog).toHaveLength(0);
    expect(await storedMembers(h)).toEqual([{ kind: "property", key: "status" }]);
  });

  it("is judged by memberIdentity, so the spelling of a value does not make a second member", () => {
    const held = [{ kind: "property", key: "status", value: "Active" }] as const;
    expect(holdsProperty(held, { kind: "property", key: "status", value: " active " })).toBe(true);
    // The existence shape and the equality shape are different members.
    expect(holdsProperty(held, { kind: "property", key: "status" })).toBe(false);
    // A key is exact, unlike a value.
    expect(holdsProperty(held, { kind: "property", key: "Status", value: "Active" })).toBe(false);
  });
});

describe("what the body says while it has no rows", () => {
  it("says properties are loading, not absent, while no index has been ready", () => {
    openProperties({ properties: () => null });
    expect(emptyMessage()).toBe("Loading this vault's properties…");
    expect(keyRows()).toHaveLength(0);
  });

  it("says there are none once the snapshot is ready and empty", () => {
    openProperties({ properties: ready(indexOf({})) });
    expect(emptyMessage()).toBe("No properties in this vault yet");
  });
});

describe("the counts on picker rows", () => {
  it("are the index's own bucket counts, with nothing taken off", () => {
    const index = indexOf({
      "a.md": { status: "active" },
      "b.md": { status: "active" },
      "c.md": { status: "done" },
    });
    openProperties({ properties: ready(index) });
    expect(keyRow("status").textContent).toContain("3 notes");
    expandBtn("status").click();
    expect(valueBtn("active").textContent).toContain("2 notes");
    expect(valueBtn("done").textContent).toContain("1 note");
  });
});

describe("the picker reads the drawn index, the same picture as the summary row", () => {
  const index = indexOf({ "a.md": { status: "active" } });

  /** A REAL controller behind the accessor the plugin hands the panel. */
  function controllerAnswering(initial: PropertySnapshot) {
    const defs = new DefinitionStore({ read: async () => undefined, write: async () => undefined });
    const runtime = new RuntimeStateStore({ get: () => null, set: () => undefined });
    runtime.load();
    let answer = initial;
    const controller = new SpaceController(
      defs,
      runtime,
      buildFakeVault({}),
      { apply: () => undefined, livePaths: () => new Set<string>() },
      createMapTagIndex(new Map()),
      () => answer
    );
    return { controller, set: (s: PropertySnapshot) => void (answer = s) };
  }

  function openOver(controller: SpaceController): Array<() => void> {
    const callbacks: Array<() => void> = [];
    openProperties({
      properties: () => controller.drawnPropertyIndex(),
      subscribePropertyRefresh: (cb) => {
        callbacks.push(cb);
        return () => undefined;
      },
    });
    return callbacks;
  }

  it("keeps its rows when the cache goes cold after a ready answer", () => {
    const { controller, set } = controllerAnswering({ status: "ready", index });
    const callbacks = openOver(controller);
    expect(offered()).toEqual(["status"]);
    set({ status: "unavailable" }); // a metadata change replaced the snapshot with a cold one
    callbacks[0]();
    expect(offered()).toEqual(["status"]);
    expect(emptyMessage()).toBe("");
  });

  it("says loading on a genuine first start, and fills in when the first answer arrives", () => {
    const { controller, set } = controllerAnswering({ status: "unavailable" });
    const callbacks = openOver(controller);
    expect(emptyMessage()).toBe("Loading this vault's properties…");
    set({ status: "ready", index });
    callbacks[0]();
    expect(offered()).toEqual(["status"]);
  });
});

describe("the work budget of the picker", () => {
  const notes: Notes = {
    "a.md": { status: "active", due: "2026-01-01", owner: "me" },
    "b.md": { status: "done", due: "2026-02-01" },
  };

  it("opening the body calls listValues zero times", () => {
    const spy = counting(indexOf(notes));
    openProperties({ properties: ready(spy.index) });
    expect(offered()).toEqual(["due", "owner", "status"]);
    expect(spy.asked).toEqual([]);
  });

  it("filtering and choosing a key still list no values", () => {
    const spy = counting(indexOf(notes));
    openProperties({ properties: ready(spy.index) });
    const filter = byKey("item-filter") as HTMLInputElement;
    filter.value = "s";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    selectBtn("status").click();
    expect(spy.asked).toEqual([]);
  });

  it("expanding one key lists the values of that key and no other", () => {
    const spy = counting(indexOf(notes));
    openProperties({ properties: ready(spy.index) });
    expandBtn("status").click();
    selectBtn("owner").click(); // a redraw with status still open
    expect(new Set(spy.asked)).toEqual(new Set(["status"]));
  });
});

describe("the picker owns a metadata subscription", () => {
  /** A source that counts live subscriptions and keeps every callback it handed out. */
  function source() {
    const callbacks: Array<() => void> = [];
    let active = 0;
    return {
      subscribe: (onChange: () => void) => {
        callbacks.push(onChange);
        active += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          active -= 1;
        };
      },
      callbacks,
      get active() {
        return active;
      },
    };
  }

  it("subscribes when the PROPERTIES body is shown, and not merely when the picker opens", () => {
    // The body, not the window. A picker open on Vault reads nothing from the
    // snapshot, and subscribing for it made every metadata event in the vault
    // schedule a flush whose only action was a notify this panel threw away.
    const s = source();
    makeHarness({ subscribePropertyRefresh: s.subscribe });
    expect(s.active).toBe(0);
    byKey("mode-curate").click();
    expect(s.active).toBe(0);
    byKey("body-properties").click();
    expect(s.active).toBe(1);
    // A redraw while the body stays on screen does not stack a second one.
    byKey("body-properties").click();
    expect(s.active).toBe(1);
  });

  it("releases when the picker switches to another body", () => {
    const s = source();
    makeHarness({ subscribePropertyRefresh: s.subscribe });
    byKey("mode-curate").click();
    byKey("body-properties").click();
    expect(s.active).toBe(1);
    byKey("body-items").click();
    expect(s.active).toBe(0);
  });

  it("releases when the picker is closed", () => {
    const s = source();
    makeHarness({ subscribePropertyRefresh: s.subscribe });
    byKey("mode-curate").click();
    byKey("body-properties").click();
    expect(s.active).toBe(1);
    byKey("mode-curate").click(); // the same button collapses the picker
    expect(s.active).toBe(0);
  });

  it("releases when the panel closes", () => {
    const s = source();
    const h = makeHarness({ subscribePropertyRefresh: s.subscribe });
    byKey("mode-curate").click();
    byKey("body-properties").click();
    expect(s.active).toBe(1);
    byKey("cancel").click();
    expect(h.closes).toBe(1);
    expect(s.active).toBe(0);
  });

  it("releases when the panel is destroyed", () => {
    const s = source();
    const h = makeHarness({ subscribePropertyRefresh: s.subscribe });
    byKey("mode-curate").click();
    byKey("body-properties").click();
    expect(s.active).toBe(1);
    h.panel.destroy();
    expect(s.active).toBe(0);
  });

  it("redraws the key list when told the snapshot changed", () => {
    const s = source();
    let snapshot: PropertyIndex | null = null;
    openProperties({ properties: () => snapshot, subscribePropertyRefresh: s.subscribe });
    expect(keyRows()).toHaveLength(0);
    snapshot = indexOf({ "a.md": { status: "x" } });
    s.callbacks[0]();
    expect(offered()).toEqual(["status"]);
  });

  it("redraws the SUMMARY ROW too, so the two numbers come from one snapshot", () => {
    // The body's per-key counts came from the new snapshot while the "N notes"
    // line pinned under them still showed the figure computed at the last
    // pick. The preview here answers from a value the notification moves, so
    // a summary that was not redrawn keeps the old one.
    const s = source();
    let notes = 1;
    openProperties({
      properties: ready(indexOf({ "a.md": { status: "x" } })),
      subscribePropertyRefresh: s.subscribe,
      preview: () => ({ paths: new Set<string>(), notes }),
    });
    selectBtn("status").click();
    expect(summary()).toContain("1 note");
    notes = 4;
    s.callbacks[0]();
    expect(summary()).toContain("4 notes");
  });

  it("keeps a key open across a refresh", () => {
    const s = source();
    openProperties({
      properties: ready(indexOf({ "a.md": { status: "x" } })),
      subscribePropertyRefresh: s.subscribe,
    });
    expandBtn("status").click();
    s.callbacks[0]();
    expect(valueLabels()).toEqual(["x"]);
  });

  it("ignores a notification from a subscription it has released", () => {
    const s = source();
    let asks = 0;
    const index = indexOf({ "a.md": { status: "x" } });
    openProperties({
      properties: () => {
        asks += 1;
        return index;
      },
      subscribePropertyRefresh: s.subscribe,
    });
    byKey("mode-curate").click(); // close: releases the first subscription
    byKey("mode-curate").click(); // reopen: a second one
    byKey("body-properties").click();
    expect(s.callbacks).toHaveLength(2);
    const before = asks;
    s.callbacks[0](); // the released one, delivered late by a careless source
    expect(asks).toBe(before);
    s.callbacks[1]();
    expect(asks).toBe(before + 1);
  });
});
