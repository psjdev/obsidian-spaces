import { describe, expect, it, vi } from "vitest";
import { createVaultChangeCoalescer } from "../src/lifecycle/eventCoalescer";
import {
  PropertyRefreshHub,
  installThenNotify,
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
  const log: string[] = [];
  const replace = () =>
    installThenNotify(
      () => log.push("install"),
      () => {
        log.push("notify");
        hub.notify();
      }
    );
  const vaultChanges = createVaultChangeCoalescer({ timer: clock.timer, flush: replace });
  const pickerRefreshes = createVaultChangeCoalescer({ timer: clock.timer, flush: replace });
  const metadataEvent = () => {
    const route = metadataNotifyRoute(opts.spaceWatchesMetadata ?? false, hub.size);
    if (route === "picker-flush") void pickerRefreshes.submit(async () => undefined);
    else if (route === "vault-flush") void vaultChanges.submit(async () => undefined);
  };
  return {
    log,
    subscribePropertyRefresh: (onChange: () => void) => hub.subscribe(onChange),
    emitMetadataChanged: metadataEvent,
    emitResolved: metadataEvent,
    emitVaultEvent: () => void vaultChanges.submit(async () => undefined),
    settle: () => clock.advance(10_000),
    unload: () => {
      hub.clear();
      vaultChanges.cancel();
      pickerRefreshes.cancel();
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
