import { describe, expect, it, vi } from "vitest";
import { VAULT_COALESCE_WINDOW_MS, createVaultChangeCoalescer } from "../src/lifecycle/eventCoalescer";
import {
  PropertyRefreshHub,
  RefreshFlushState,
  installThenNotify,
  submitVaultWork,
  metadataNotifyRoute,
} from "../src/visibility/PropertyRefreshHub";

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
    else vaultEvent();
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
    expect(state.take()).toEqual({ full: true, rebuild: true });
  });
  it("does not rebuild when the install postdates the vault event", () => {
    const state = new RefreshFlushState();
    state.noteVaultEvent();
    state.markFull();
    state.noteSnapshotInstalled();
    expect(state.take()).toEqual({ full: true, rebuild: false });
  });
  it("is not full for a metadata-only burst, and resets after take", () => {
    const state = new RefreshFlushState();
    state.noteSnapshotInstalled();
    expect(state.take()).toEqual({ full: false, rebuild: false });
    state.noteVaultEvent();
    state.markFull();
    expect(state.take()).toEqual({ full: true, rebuild: true });
    expect(state.take()).toEqual({ full: false, rebuild: false });
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
