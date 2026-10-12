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

  /** Drops every watcher. For unload, when no picker can still be open. */
  clear(): void {
    this.watchers.clear();
  }
}
