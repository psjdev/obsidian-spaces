/**
 * The set of open property pickers waiting to hear that the snapshot they
 * are showing has been replaced.
 *
 * It exists apart from the plugin class so the subscribe, release and notify
 * behaviour can be tested without an Obsidian runtime. It knows nothing about
 * which events call `notify`; that choice, and the reason for it, is in
 * `main.ts`.
 */
export class PropertyRefreshHub {
  private readonly watchers = new Set<() => void>();

  /**
   * Registers a watcher and returns its own release. Each call gets its own
   * entry, so subscribing the same function twice and releasing one handle
   * leaves the other subscription live.
   */
  subscribe(onChange: () => void): () => void {
    const entry = () => onChange();
    this.watchers.add(entry);
    return () => {
      this.watchers.delete(entry);
    };
  }

  /**
   * Calls every current watcher. Iterates a copy, so a watcher that releases
   * itself, or another, mid-notify neither skips nor re-enters. A throwing
   * watcher is logged and does not stop the rest.
   */
  notify(): void {
    for (const watcher of [...this.watchers]) {
      // A watcher released earlier in this same pass must not be called.
      if (!this.watchers.has(watcher)) continue;
      try {
        watcher();
      } catch (e) {
        console.error("Spaces: a property picker refresh failed", e);
      }
    }
  }

  /** How many pickers are subscribed. Lets a caller skip work nobody awaits. */
  get size(): number {
    return this.watchers.size;
  }

  /** Drops every watcher. For unload, when no picker can still be open. */
  clear(): void {
    this.watchers.clear();
  }
}

/**
 * Installs a replacement snapshot, THEN tells the pickers. The order is the
 * whole point and the reason this is a function: a picker that re-reads when
 * told must find the replacement, not the picture it replaces. If `install`
 * throws, nobody is told, because nothing was replaced.
 */
export function installThenNotify(install: () => void, notify: () => void): void {
  install();
  notify();
}

/**
 * Which coalescer a metadata event's picker notification rides.
 *
 * - "vault-flush": the active space watches metadata, so the vault flush is
 *   already scheduled, rebuilds the snapshot and notifies. Notifying here too
 *   would walk the vault twice per event, the second walk discarding the
 *   first's snapshot.
 * - "picker-flush": nothing else will flush, but a picker is open, so a
 *   notify-only flush (no re-index, no re-sort; the snapshot is already
 *   installed by the event handler) is scheduled on the shared coalescer
 *   without marking a vault event.
 * - "none": no flush runs and nobody is listening.
 */
export type MetadataNotifyRoute = "vault-flush" | "picker-flush" | "none";

export function metadataNotifyRoute(spaceWatchesMetadata: boolean, pickers: number): MetadataNotifyRoute {
  if (spaceWatchesMetadata) return "vault-flush";
  return pickers > 0 ? "picker-flush" : "none";
}

/**
 * What the next coalesced flush has to do, accumulated over one burst.
 *
 * ONE coalescer serves vault events and metadata events, because two timers
 * mean a note creation (a vault `create` plus a metadata `changed`) flushes
 * twice and notifies twice. This is the state that lets one flush express
 * either shape.
 *
 * - `full`: a vault event's work has finished, so the flush must re-index and
 *   refresh. A metadata-only burst leaves it false and the flush only
 *   notifies. It is set by `markFull`, which must run INSIDE the queued work,
 *   after the work and before the coalescer schedules the flush (see
 *   `submitVaultWork`). Setting it when the event ARRIVES is wrong: an earlier
 *   burst's timer can fire while this event's work is still running, consume
 *   the flag, and leave this event's own flush with nothing to do.
 * - `fresh`: a snapshot was installed AFTER the burst's last vault event
 *   arrived, so the flush need not install another. Sound because the
 *   snapshot is lazy and is read from the metadata cache, not the vault index:
 *   one installed after the vault event arrived is built from state at least
 *   as new. A vault event arriving AFTER the install clears it, since a
 *   picker may have read the snapshot in between. This one is set on arrival,
 *   not in the work, because it is about ordering against the install.
 *
 * KNOWN LIMIT, accepted. When a metadata event arrives BEFORE a vault event in
 * the same burst, `fresh` is cleared and the flush installs a second snapshot,
 * so the generation is bumped twice. A create is vault-then-metadata and a
 * save is metadata-only, so single actions do not do this; a multi-file sync
 * or import interleaves the two and hits it regularly. It is accepted because
 * the extra install is a lazy closure and a counter bump, not a vault walk:
 * nothing walks until a picker or property member reads, and it reads once.
 * Skipping it would be unsound, since a picker may have read in between.
 */
export class RefreshFlushState {
  private full = false;
  private fresh = false;

  /** A vault event has arrived. Clears `fresh` only; see `markFull`. */
  noteVaultEvent(): void {
    this.fresh = false;
  }

  /** The flush must re-index and refresh. Call from inside queued work. */
  markFull(): void {
    this.full = true;
  }

  noteSnapshotInstalled(): void {
    this.fresh = true;
  }

  /** Reads and resets. `rebuild` is only ever true on a full flush. */
  take(): { full: boolean; rebuild: boolean } {
    const result = { full: this.full, rebuild: this.full && !this.fresh };
    this.full = false;
    this.fresh = false;
    return result;
  }
}

/**
 * Queues vault work on the shared coalescer and arranges for the flush behind
 * it to be a full one. `markFull` runs in the work's `finally`, so it lands
 * after the work and before the coalescer's own `schedule()`, which only runs
 * once the work settles. A failed repair still marks it: the vault changed
 * whether or not the repair succeeded.
 */
export function submitVaultWork(
  submit: (work: () => Promise<unknown>) => Promise<void>,
  state: RefreshFlushState,
  fn: () => Promise<unknown>
): Promise<void> {
  state.noteVaultEvent();
  return submit(async () => {
    try {
      return await fn();
    } finally {
      state.markFull();
    }
  });
}
