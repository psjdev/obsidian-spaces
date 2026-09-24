import { describe, expect, it } from "vitest";
import {
  VAULT_COALESCE_MAX_WAIT_MS,
  VAULT_COALESCE_WINDOW_MS,
  createVaultChangeCoalescer,
  type CoalescerTimer,
} from "../src/lifecycle/eventCoalescer";

/**
 * Injected clock (no `setTimeout`, no sleeping).
 * Same shape as `nativeMenuInjection.ts`'s injected `defer`, extended with `now`
 * and cancellation because a debounce needs both.
 */
function fakeTimer(): CoalescerTimer & {
  advance: (ms: number) => void;
  at: () => number;
  live: () => number;
} {
  let clock = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();

  return {
    set(fn, ms) {
      const handle = ++seq;
      pending.set(handle, { at: clock + ms, fn });
      return handle;
    },
    clear(handle) {
      pending.delete(handle);
    },
    now: () => clock,
    at: () => clock,
    live: () => pending.size,
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of pending) {
          if (entry[1].at > target) continue;
          if (due === null || entry[1].at < due[1].at) due = entry;
        }
        if (due === null) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = target;
    },
  };
}

/**
 * The pre-fix shape of `main.ts`'s `onVaultChange`: the expensive tail runs
 * once per event. Kept in the test as the baseline the coalesced counts are
 * measured against, so the "N before / 1 after" claim is checked, not asserted.
 */
function uncoalesced(flush: () => void) {
  return async (work: () => Promise<unknown>): Promise<void> => {
    await work();
    flush();
  };
}

describe("vault event coalescer: burst collapsing", () => {
  it("baseline — the uncoalesced path runs the tail once per event", async () => {
    let flushes = 0;
    const onVaultChange = uncoalesced(() => flushes++);
    for (let i = 0; i < 500; i++) await onVaultChange(async () => undefined);
    expect(flushes).toBe(500);
  });

  it("collapses a 500-event burst into ONE re-index + snapshot + re-sort", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    for (let i = 0; i < 500; i++) await c.submit(async () => undefined);
    expect(flushes).toBe(0);

    timer.advance(VAULT_COALESCE_WINDOW_MS);
    expect(flushes).toBe(1);
  });

  it("runs every submitted repair exactly once, in order, across the burst", async () => {
    const timer = fakeTimer();
    const ran: number[] = [];
    const c = createVaultChangeCoalescer({ timer, flush: () => undefined });

    for (let i = 0; i < 500; i++) await c.submit(async () => void ran.push(i));

    expect(ran).toHaveLength(500);
    expect(ran).toEqual([...Array(500).keys()]);
  });
});

describe("vault event coalescer: the single-event path stays prompt", () => {
  it("repairs membership immediately — the repair itself is never deferred", async () => {
    const timer = fakeTimer();
    const members = ["Notes/old.md"];
    const c = createVaultChangeCoalescer({ timer, flush: () => undefined });

    await c.submit(async () => {
      members[0] = "Notes/new.md";
    });

    // Clock has not moved. The repair has already landed.
    expect(timer.at()).toBe(0);
    expect(members).toEqual(["Notes/new.md"]);
  });

  it("re-sorts one window after a lone rename, not one window after the last of a burst", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    await c.submit(async () => undefined);
    timer.advance(VAULT_COALESCE_WINDOW_MS - 1);
    expect(flushes).toBe(0);
    timer.advance(1);
    expect(flushes).toBe(1);
    expect(c.isPending()).toBe(false);
  });

  it("chose a window a user cannot perceive as lag", () => {
    // Justified in the module comment: under the 100 ms "instantaneous"
    // threshold, so a user's own rename never reads as delayed.
    expect(VAULT_COALESCE_WINDOW_MS).toBeLessThan(100);
    expect(VAULT_COALESCE_MAX_WAIT_MS).toBeGreaterThan(VAULT_COALESCE_WINDOW_MS);
  });
});

describe("vault event coalescer: correctness of the hard sequences", () => {
  /** A stand-in for the stored membership `repairOnRename` rewrites. */
  function store(initial: string[]) {
    const paths = [...initial];
    return {
      paths,
      rename(from: string, to: string) {
        for (let i = 0; i < paths.length; i++) if (paths[i] === from) paths[i] = to;
      },
    };
  }

  it("rename-then-rename inside one window applies BOTH, in order", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const s = store(["a.md"]);
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    await c.submit(async () => s.rename("a.md", "b.md"));
    await c.submit(async () => s.rename("b.md", "c.md"));
    timer.advance(VAULT_COALESCE_WINDOW_MS);

    // The second repair is computed from the first's result. Coalescing the
    // repairs (rather than only the tail) would leave "b.md" dangling.
    expect(s.paths).toEqual(["c.md"]);
    expect(flushes).toBe(1);
  });

  it("rename-then-delete inside one window keeps the rename's repair", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const s = store(["a.md"]);
    const seen: string[] = [];
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    await c.submit(async () => {
      seen.push("rename");
      s.rename("a.md", "b.md");
    });
    // A delete removes NO metadata, so the entry must still read "b.md".
    await c.submit(async () => void seen.push("delete"));
    timer.advance(VAULT_COALESCE_WINDOW_MS);

    expect(seen).toEqual(["rename", "delete"]);
    expect(s.paths).toEqual(["b.md"]);
    expect(flushes).toBe(1);
  });

  it("delete-then-create at the SAME path inside one window keeps both, ordered", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const seen: string[] = [];
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    await c.submit(async () => void seen.push("delete p.md"));
    await c.submit(async () => void seen.push("create p.md"));
    timer.advance(VAULT_COALESCE_WINDOW_MS);

    // Neither may be dropped as a same-path duplicate: the create is what
    // re-establishes the path the delete's correlation may still be pairing.
    expect(seen).toEqual(["delete p.md", "create p.md"]);
    expect(flushes).toBe(1);
  });

  it("serialises overlapping submissions so a slow repair cannot be overtaken", async () => {
    const timer = fakeTimer();
    const order: string[] = [];
    const c = createVaultChangeCoalescer({ timer, flush: () => undefined });

    let releaseFirst = (): void => undefined;
    const gate = new Promise<void>((r) => (releaseFirst = r));

    const first = c.submit(async () => {
      await gate;
      order.push("first");
    });
    const second = c.submit(async () => void order.push("second"));

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("still flushes when a repair throws — the vault changed regardless", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    await expect(c.submit(async () => Promise.reject(new Error("mutate failed")))).rejects.toThrow(
      "mutate failed"
    );
    timer.advance(VAULT_COALESCE_WINDOW_MS);
    expect(flushes).toBe(1);
  });

  it("a throw does not poison the chain for the next event", async () => {
    const timer = fakeTimer();
    const ran: string[] = [];
    const c = createVaultChangeCoalescer({ timer, flush: () => undefined });

    await c.submit(async () => Promise.reject(new Error("boom"))).catch(() => undefined);
    await c.submit(async () => void ran.push("after"));
    expect(ran).toEqual(["after"]);
  });
});

describe("vault event coalescer: a sustained stream cannot starve the tree", () => {
  it("flushes at the max-wait cap when events never stop for a whole window", async () => {
    const timer = fakeTimer();
    const flushedAt: number[] = [];
    const c = createVaultChangeCoalescer({ timer, flush: () => flushedAt.push(timer.at()) });

    // One event every 40 ms for a second: a plain restart-debounce with a
    // 50 ms window would never fire at all while this runs.
    for (let t = 0; t < 1000; t += 40) {
      await c.submit(async () => undefined);
      timer.advance(40);
    }

    expect(flushedAt.length).toBeGreaterThan(0);
    expect(flushedAt[0]).toBe(VAULT_COALESCE_MAX_WAIT_MS);
    // Still hugely coalesced: 25 events, far fewer flushes.
    expect(flushedAt.length).toBeLessThan(6);
  });

  it("starts a fresh window after the stream stops", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    await c.submit(async () => undefined);
    timer.advance(VAULT_COALESCE_MAX_WAIT_MS * 2);
    expect(flushes).toBe(1);

    await c.submit(async () => undefined);
    timer.advance(VAULT_COALESCE_WINDOW_MS);
    expect(flushes).toBe(2);
  });
});

describe("vault event coalescer: teardown", () => {
  it("cancel() drops the pending flush and leaves no live timer", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    await c.submit(async () => undefined);
    expect(c.isPending()).toBe(true);
    c.cancel();
    expect(timer.live()).toBe(0);

    timer.advance(VAULT_COALESCE_MAX_WAIT_MS * 4);
    expect(flushes).toBe(0);
    expect(c.isPending()).toBe(false);
  });

  it("a submission after cancel() never schedules a flush", async () => {
    const timer = fakeTimer();
    let flushes = 0;
    let ran = false;
    const c = createVaultChangeCoalescer({ timer, flush: () => flushes++ });

    c.cancel();
    await c.submit(async () => void (ran = true));
    timer.advance(VAULT_COALESCE_MAX_WAIT_MS * 4);

    // The work still runs — a caller mid-unload must not silently lose a
    // membership write — but nothing is scheduled against a dead plugin.
    expect(ran).toBe(true);
    expect(flushes).toBe(0);
  });
});
