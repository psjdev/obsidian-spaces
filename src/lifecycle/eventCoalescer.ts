/**
 * A coalescing window for vault events. Pure — no DOM, no `"obsidian"`
 * import, so it tests in plain node.
 *
 * Before this, every `create`/`delete`/`rename` ran a full vault re-index, a
 * full visibility snapshot and a forced full explorer re-sort. Measured per
 * event at V ~= 30k: ~2-9 ms in *All* (index + sort, no snapshot is built
 * there at all), up to ~1,630 ms for a space of five real project folders. A
 * 500-file sync, `git pull`, backup restore or importer therefore costs that
 * many times over in aggregate main-thread CPU. (The review's earlier "18 s
 * blocked" framing is NOT what this fixes against — the handlers `await`, so
 * whether the burst freezes or merely janks depends on Obsidian's delivery,
 * which was never settled. The cost being removed is aggregate CPU.)
 *
 * **Only the tail is coalesced.** `submit` runs the caller's work — the
 * membership repair — eagerly and in FIFO order; the re-index/snapshot/re-sort
 * behind it is what collapses. That split is the whole correctness argument:
 *
 *  - A repair can never be "coalesced away", because repairs are not
 *    coalesced. rename a->b then b->c both run, in that order, so the second
 *    reads the first's result; drop or reorder either and the member dangles.
 *  - A delete removes no metadata and a create at the same path is a
 *    separate event, so neither may be collapsed into the other as a
 *    same-path duplicate.
 *  - The tail is idempotent and reads live state at flush time
 *    (`SpaceController.refresh` recomputes from current definitions, and the
 *    index is rebuilt from the vault when the flush fires), so running it once
 *    at the end of a burst yields exactly the state N runs would have ended
 *    at — never an intermediate one.
 *
 * The scheduling shape is `ExplorerAdapter.schedule()`'s: one in-flight handle,
 * guarded, cleared inside the callback, cancellable at teardown. The timer is
 * injected rather than closed over `setTimeout` so tests can drive it without
 * sleeping, the same way `nativeMenuInjection.ts` injects
 * `defer`. Two deliberate differences from the rAF version: the window
 * restarts on each event (a rAF tick is far too short to span an event burst),
 * and a max-wait caps the restarts.
 */

/**
 * 50 ms. Chosen against the 100 ms limit at which a response stops reading as
 * instantaneous: a user renaming one file sees the tree settle inside half of
 * that budget, so their own gesture never appears to lag. Shorter and a burst
 * spills across several windows for no gain; longer and the tree visibly
 * trails the rename.
 */
export const VAULT_COALESCE_WINDOW_MS = 50;

/**
 * 250 ms. A restart-only debounce starves: a sync or importer that emits an
 * event more often than every 50 ms would defer the re-sort for as long as it
 * ran, leaving the tree stale for the whole import. This caps how far the
 * window may be pushed out from the first event of a burst, so staleness is
 * bounded at a quarter second while a dense stream still collapses five
 * windows' worth of events into one flush.
 */
export const VAULT_COALESCE_MAX_WAIT_MS = 250;

/** The injected clock. `set`/`clear` are `window.setTimeout`/`clearTimeout`. */
export interface CoalescerTimer {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
  now(): number;
}

interface VaultChangeCoalescer {
  /**
   * Run one vault event's membership work now, and schedule the coalesced
   * re-index/snapshot/re-sort behind it.
   *
   * Rejects with whatever `work` rejected with — the caller's existing error
   * handling is unchanged — but the flush is still scheduled, because the
   * vault changed whether or not spaces's own write succeeded.
   */
  submit(work: () => Promise<unknown>): Promise<void>;
  /** True while a flush is scheduled. */
  isPending(): boolean;
  /** Drop the pending flush at unload so no timer outlives the plugin. */
  cancel(): void;
}

export function createVaultChangeCoalescer(args: {
  timer: CoalescerTimer;
  flush: () => void;
  windowMs?: number;
  maxWaitMs?: number;
}): VaultChangeCoalescer {
  const { timer, flush } = args;
  const windowMs = args.windowMs ?? VAULT_COALESCE_WINDOW_MS;
  const maxWaitMs = args.maxWaitMs ?? VAULT_COALESCE_MAX_WAIT_MS;

  let handle: number | null = null;
  let burstStart: number | null = null;
  let cancelled = false;
  // FIFO. Repairs must not interleave: rename a->b then b->c is order-
  // dependent, and `submit`'s callers do not await one another.
  let chain: Promise<unknown> = Promise.resolve();

  const fire = (): void => {
    handle = null;
    burstStart = null;
    flush();
  };

  const schedule = (): void => {
    if (cancelled) return;
    const now = timer.now();
    if (burstStart === null) burstStart = now;
    if (handle !== null) timer.clear(handle);
    // Never later than `maxWaitMs` after the burst's first event.
    const remaining = maxWaitMs - (now - burstStart);
    handle = timer.set(fire, Math.max(0, Math.min(windowMs, remaining)));
  };

  return {
    async submit(work) {
      const run = chain.then(work);
      // Swallowed on the chain only, so one failed repair cannot poison the
      // next event's; the caller still sees the rejection through `run`.
      chain = run.then(
        () => undefined,
        () => undefined
      );
      try {
        await run;
      } finally {
        schedule();
      }
    },
    isPending: () => handle !== null,
    cancel() {
      cancelled = true;
      if (handle !== null) timer.clear(handle);
      handle = null;
      burstStart = null;
    },
  };
}
