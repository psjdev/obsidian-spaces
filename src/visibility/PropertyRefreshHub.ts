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
 * - "vault-flush": the active space watches metadata, so the shared flush must
 *   recompute it, and it notifies too. Notifying here as well would walk the
 *   vault twice per event, the second walk discarding the first's snapshot.
 *   Despite the name this does not re-index the vault TREE: a metadata event
 *   queues a recompute (`submitMetadataWork`), not vault work.
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
  private recompute = false;
  private fresh = false;

  /** A vault event has arrived. Clears `fresh` only; see `markFull`. */
  noteVaultEvent(): void {
    this.fresh = false;
  }

  /** The flush must re-index and refresh. Call from inside queued work. */
  markFull(): void {
    this.full = true;
  }

  /**
   * The active space's contents may have changed, but the vault did not: a
   * note's metadata changed. The flush recomputes and notifies and does NOT
   * re-index the vault tree. Call from inside queued work, for the reason
   * `markFull` gives.
   */
  markRecompute(): void {
    this.recompute = true;
  }

  noteSnapshotInstalled(): void {
    this.fresh = true;
  }

  /**
   * Reads and resets.
   *
   * - `full`: a vault event happened, so the vault tree is stale.
   * - `recompute`: the active space must be recomputed. True whenever `full`
   *   is, and also for a metadata burst in a space that watches metadata.
   * - `rebuild`: install a second property snapshot. Only ever true on a full
   *   flush; a metadata event installs its own.
   */
  take(): { full: boolean; recompute: boolean; rebuild: boolean } {
    const result = {
      full: this.full,
      recompute: this.full || this.recompute,
      rebuild: this.full && !this.fresh,
    };
    this.full = false;
    this.recompute = false;
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

/**
 * Queues a metadata event's recompute on the shared coalescer. The metadata
 * counterpart of `submitVaultWork`, and the reason a metadata event no longer
 * walks the vault TREE: it marks the burst for a recompute, not for a
 * re-index. `markRecompute` runs inside the queued work for the reason
 * `submitVaultWork` marks `full` there.
 */
export function submitMetadataWork(
  submit: (work: () => Promise<unknown>) => Promise<void>,
  state: RefreshFlushState
): Promise<void> {
  return submit(async () => {
    state.markRecompute();
  });
}

/** What a flush can do to the world. Each is one decision `runFlush` makes. */
export interface FlushActions {
  /** Replace the vault tree index. O(vault); only when the tree changed. */
  replaceVaultIndex(): void;
  /** Replace the lazy tag index. One closure until something asks. */
  replaceTagIndex(): void;
  /** Install a fresh lazy property snapshot. One closure until something asks. */
  installPropertySnapshot(): void;
  /** Tell open pickers. */
  notifyPickers(): void;
  /** Recompute the active space and re-apply it. */
  refresh(): void;
}

/**
 * What the coalescer's flush does, decided in one place so main.ts and the
 * work-budget tests run the same code.
 *
 * - A VAULT burst re-indexes the tree, replaces the tag index and a property
 *   snapshot not already installed after it, tells pickers, recomputes.
 * - A METADATA burst in a space that watches metadata only tells pickers and
 *   recomputes. The tree did not move, and the tag index and snapshot were
 *   replaced by the event itself.
 * - A METADATA burst with nobody watching only tells pickers.
 *
 * Pickers are told AFTER the install and BEFORE the refresh: a throw from the
 * refresh must not leave them stale for the burst.
 */
export function runFlush(state: RefreshFlushState, actions: FlushActions): void {
  const { full, recompute, rebuild } = state.take();
  if (full) {
    // The vault index is a snapshot; built at flush time so it is the burst's
    // end state rather than any intermediate one. The tag index goes with it:
    // a fresh vault read against a stale tag index shows a note the vault has
    // and the tags do not (see `TagIndex.ts`).
    actions.replaceVaultIndex();
    actions.replaceTagIndex();
  }
  installThenNotify(
    () => {
      if (rebuild) actions.installPropertySnapshot();
    },
    () => actions.notifyPickers()
  );
  if (recompute) actions.refresh();
}
