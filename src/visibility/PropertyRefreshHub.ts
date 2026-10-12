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
 *   picker-only flush (rebuild and notify, no re-index or re-sort) is
 *   scheduled instead.
 * - "none": no flush runs and nobody is listening.
 */
export type MetadataNotifyRoute = "vault-flush" | "picker-flush" | "none";

export function metadataNotifyRoute(spaceWatchesMetadata: boolean, pickers: number): MetadataNotifyRoute {
  if (spaceWatchesMetadata) return "vault-flush";
  return pickers > 0 ? "picker-flush" : "none";
}
