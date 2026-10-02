import { validateDefinitions } from "./schema";
import {
  DEFAULT_DEFINITIONS,
  type OrderMap,
  type SpaceOrders,
  type SpacesDefinitions,
} from "../types";

/** Named in every user-facing message, so the file to fix is never a guess. */
const DATA_FILE = "data.json";

interface DefinitionsBacking {
  read(): Promise<unknown>;
  write(data: unknown): Promise<void>;
  /**
   * Optional. Copy a document aside before this session's first write, so a
   * bad write or a bad merge is recoverable — the original file is kept,
   * but only until we ourselves overwrite it. Obsidian's File Recovery core
   * plugin snapshots Markdown only, so `data.json` is otherwise the one copy.
   */
  backup?(data: unknown): Promise<void>;
}

/** How the store reaches the user. Injected so this module stays pure. */
type WarnFn = (message: string) => void;

type LoadOutcome =
  | { ok: true }
  | { ok: false; error: string; futureSchema: boolean };

type Subscriber = (defs: SpacesDefinitions) => void;

/**
 * Order maps are rebuilt with a null prototype. Keys are space
 * ids and folder paths, both of which can legitimately be the string
 * `__proto__`; on a plain object `map[id] ??= {}` reads the inherited accessor
 * — truthy, so no assignment happens — and the next write lands on
 * `Object.prototype` itself, for every object in the renderer.
 */
function nullProtoOrders(orders: SpaceOrders): SpaceOrders {
  const out: SpaceOrders = {};
  if (orders.all) out.all = Object.assign(Object.create(null) as OrderMap, orders.all);
  if (orders.bySpaceId) {
    const by = Object.create(null) as Record<string, OrderMap>;
    for (const [id, m] of Object.entries(orders.bySpaceId)) {
      by[id] = Object.assign(Object.create(null) as OrderMap, m);
    }
    out.bySpaceId = by;
  }
  return out;
}

/**
 * The JSON round-trip resurrects `Object.prototype` on every object it
 * rebuilds, including the order maps the schema deliberately gave a null
 * prototype — and the clone is what a `mutate()` callback writes into. Harden
 * it again on the way out.
 */
function clone(d: SpacesDefinitions): SpacesDefinitions {
  const out = JSON.parse(JSON.stringify(d)) as SpacesDefinitions;
  if (out.orders) out.orders = nullProtoOrders(out.orders);
  return out;
}

/**
 * Structural equality over JSON-shaped values. Used to compare what came back
 * off disk with what was written; `JSON.stringify` would not do, because a map
 * keyed by a folder named "2" round-trips with integer keys reordered.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  const ax = a as Record<string, unknown>;
  const bx = b as Record<string, unknown>;
  const keys = Object.keys(ax);
  if (keys.length !== Object.keys(bx).length) return false;
  return keys.every(
    (k) => Object.prototype.hasOwnProperty.call(bx, k) && deepEqual(ax[k], bx[k])
  );
}

export class DefinitionStore {
  private defs: SpacesDefinitions = clone(DEFAULT_DEFINITIONS);
  private queue: Promise<unknown> = Promise.resolve();
  private subscribers = new Set<Subscriber>();
  /**
   * The load outcome, made STICKY. `load()` refuses to overwrite a file it
   * could not understand, and that refusal must hold beyond the moment
   * `load()` returns — `mutate()` has to consult it too, or the very next
   * ordinary action (a settings toggle, a blur, one drag) would persist the
   * defaults over the user's spaces. While this is set, nothing writes.
   */
  private loadFailure: string | null = null;
  /** The document as it sat on disk before this session wrote anything. */
  private pristine: unknown = null;
  /** One backup attempt per session, whether or not it succeeded. */
  private backedUp = false;
  /** Bumped on every write that reached the backing. See `writeToken`. */
  private writes = 0;
  /** So a locked volume produces one Notice, not one per mutation. */
  private saveFailureWarned = false;

  constructor(
    private backing: DefinitionsBacking,
    private warn: WarnFn = () => undefined
  ) {}

  get(): SpacesDefinitions {
    return this.defs;
  }

  /**
   * A caller that is about to capture the external bytes
   * takes this token FIRST, and hands it back to `onExternalChange`. Any write
   * that lands in between is then detectable, so the reconciliation can be
   * conditioned on that.
   */
  writeToken(): number {
    return this.writes;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private notify(): void {
    // A subscriber's failure must not surface as a failure of the mutate()
    // that is notifying it — the write already landed on disk. Isolate each
    // subscriber so one throw cannot mask that, or block the rest.
    for (const fn of this.subscribers) {
      try {
        fn(this.defs);
      } catch (e) {
        console.error("Spaces: a definitions subscriber threw", e);
      }
    }
  }

  /** All state changes funnel through here, so writes never interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<LoadOutcome> {
    return this.enqueue(async () => {
      let raw: unknown;
      try {
        raw = await this.backing.read();
      } catch (e) {
        return this.refuseWrites(String(e), false);
      }
      // `Vault.readJson` never throws. It returns null for a MISSING file and
      // undefined for one it could not parse (it console.errors and carries
      // on). Collapsing the two would let a truncated data.json load as a
      // brand-new vault: no Notice, layouts reconciled against an empty space
      // list and that deletion persisted, then the defaults written over the
      // file by the next click.
      if (raw === null) {
        this.defs = clone(DEFAULT_DEFINITIONS);
        this.pristine = null;
        this.loadFailure = null;
        return { ok: true as const };
      }
      if (raw === undefined) {
        return this.refuseWrites(`${DATA_FILE} could not be parsed`, false);
      }
      const result = validateDefinitions(raw);
      if (!result.ok) {
        // Never overwrite a file we could not understand.
        return this.refuseWrites(result.error, result.futureSchema);
      }
      this.defs = result.value;
      this.pristine = raw;
      this.loadFailure = null;
      return { ok: true as const };
    });
  }

  /**
   * Fail OPEN in memory (the tree still renders, out of All) but
   * CLOSED on disk — the file stays exactly as the user left it, and so does
   * every later write, until a document we can read arrives.
   */
  private refuseWrites(error: string, futureSchema: boolean): LoadOutcome {
    this.defs = clone(DEFAULT_DEFINITIONS);
    this.loadFailure = error;
    return { ok: false as const, error, futureSchema };
  }

  async mutate(fn: (draft: SpacesDefinitions) => void): Promise<void> {
    await this.enqueue(async () => {
      if (this.loadFailure !== null) {
        // In-memory definitions are the DEFAULTS here, not the user's
        // spaces; writing them would destroy a file we were unable to read but
        // which is very probably still intact. Both signals matter: the throw
        // tells the caller its action did not happen, the Notice tells the
        // user, because most of the 25 call sites do not catch.
        const message =
          `Spaces: not saving. ${DATA_FILE} in the spaces plugin folder ` +
          `could not be read (${this.loadFailure}). Your spaces are still in ` +
          `that file. Fix or move it, then reload the plugin.`;
        this.warn(message);
        throw new Error(message);
      }
      const draft = clone(this.defs);
      fn(draft);
      const result = validateDefinitions(draft);
      if (!result.ok) throw new Error(`invalid mutation: ${result.error}`);
      this.defs = result.value;
      await this.persist();
      this.notify();
    });
  }

  /** Back up once, write, then check the write actually landed. */
  private async persist(): Promise<void> {
    await this.backUpOnce();
    await this.backing.write(this.defs);
    this.writes += 1;
    await this.verifyWrite();
  }

  private async backUpOnce(): Promise<void> {
    if (this.backedUp) return;
    const copy = this.pristine;
    // A fresh install has nothing to lose, and a failed load never gets here.
    if (copy === null || copy === undefined) return;
    this.backedUp = true;
    this.pristine = null;
    if (!this.backing.backup) return;
    try {
      await this.backing.backup(copy);
    } catch (e) {
      // Insurance, not a gate: a backup we could not write must not cancel the
      // save the user just asked for.
      console.error(`Spaces: could not write the ${DATA_FILE} backup`, e);
    }
  }

  /**
   * `Vault.writeJson` swallows the adapter error outright — it does not
   * even log, unlike `readJson` — so `Plugin.saveData` resolves whether or not
   * a byte reached disk, and there is nothing to catch. On a locked, full or
   * read-only volume every mutation used to repaint as saved, indefinitely,
   * with no signal anywhere. Reading the file back is the only detection
   * available: one small read of the file just written, still in the OS cache,
   * per mutation — proportionate against silently losing a curation session.
   */
  private async verifyWrite(): Promise<void> {
    let readBack: unknown;
    try {
      readBack = await this.backing.read();
    } catch {
      // A failed READ is not evidence that the WRITE failed; claiming it was
      // would train the user to ignore the Notice.
      return;
    }
    if (deepEqual(readBack, this.defs)) {
      this.saveFailureWarned = false;
      return;
    }
    if (this.saveFailureWarned) return;
    this.saveFailureWarned = true;
    this.warn(
      `Spaces: your change may not have been saved. ${DATA_FILE} on disk ` +
        `does not match what was just written. Check that the plugin folder ` +
        `is writable and not locked by a sync client.`
    );
  }

  /**
   * External-wins (spec section 4.5). The caller captures the external
   * snapshot BEFORE calling, so a queued local write cannot clobber it, and
   * passes the `writeToken()` it took before that read so steps 5 and 6 can
   * tell whether a local write slipped in behind the capture.
   */
  async onExternalChange(snapshot: unknown, capturedAt: number = this.writes): Promise<void> {
    await this.enqueue(async () => {
      const result = validateDefinitions(snapshot);
      // Step 7: invalid external data never replaces last-known-good.
      if (!result.ok) return; // keep last-known-good
      // Step 5. A local write that landed after the capture is on disk but is
      // not in these bytes, so disk and memory now disagree — and which of the
      // two survives would be decided by whether the user's next action is a
      // click or a quit. Re-persist what we are applying so they agree.
      const superseded =
        this.writes !== capturedAt && !deepEqual(this.defs, result.value);
      this.defs = result.value;
      // A readable external document is also the way out of a sticky load
      // failure without a plugin reload: the user repaired data.json and
      // Obsidian told us.
      this.loadFailure = null;
      if (!this.backedUp && this.pristine === null) this.pristine = snapshot;
      if (superseded) {
        await this.persist();
        // Step 6. The local edit is gone under the external-wins policy; the
        // user made it deliberately and is owed the news.
        this.warn(
          `Spaces: a local change was superseded by a newer ${DATA_FILE} ` +
            `from another device.`
        );
      }
      this.notify();
    });
  }
}
