import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { RuntimeStateStore } from "../runtime/RuntimeStateStore";
import type { VaultIndex } from "../visibility/VaultIndex";
import type { VisibilitySnapshot } from "../visibility/VisibilityEngine";
import { buildVisibilitySnapshot } from "../visibility/VisibilityEngine";
import { compileIgnore, canonicalPath, type IgnoreMatcher } from "../visibility/glob";
import { RevealedSet } from "../visibility/RevealedSet";
import { sameSelection } from "../order/sortOverride";
import { hasRoot, rootOf } from "../visibility/folderSpace";
import { holdsPropertyMember, watchesMetadata } from "../definitions/membership";
import { resolveMembers } from "./resolveMembers";
import type { TagIndex } from "../visibility/TagIndex";
import type { PropertyIndex, PropertySnapshot } from "../visibility/PropertyIndex";
import type { ActiveSelection, PathMember, SpaceDefinition, SwitchOutcome } from "../types";
import { isArchived } from "../definitions/archived";

/**
 * The property accessor a disposed controller is left with.
 *
 * A constant, so teardown does not mint a closure, and an accessor rather than
 * a flag so `drawnPropertyIndex` and the recompute arm keep their one way of
 * asking. See `dispose`.
 */
const UNAVAILABLE_PROPERTIES = (): PropertySnapshot => ({ status: "unavailable", unparsed: [] });

interface ControllerHost {
  apply(snapshot: VisibilitySnapshot | null): void;
  /**
   * The paths backing open main-window file leaves RIGHT NOW — not the
   * visitor set. The host reports what is live; the controller decides what is
   * revealed.
   */
  livePaths(): Set<string>;
  /**
   * Whether Obsidian's metadata cache has finished its initial parse.
   *
   * False means "ask again later", NOT "the answer is no". `getAllTags`
   * returns null for every file the cache has not reached yet, so a tag space
   * asked too early resolves to zero members. See `recompute`.
   *
   * Optional, and ABSENT MEANS READY. A host that cannot report readiness
   * must filter rather than fall open forever, and that is also exactly the
   * behaviour every caller had before this existed.
   */
  metadataReady?(): boolean;
}

/**
 * The transition itself rejected: nothing was applied and the switch did not
 * happen, so there is no `SwitchOutcome` to report. Synthesized HERE rather
 * than added to `SwitchOutcome` in types.ts, which is the LayoutCoordinator's
 * vocabulary for transitions it actually ran.
 *
 * It exists so a rejected transition is still reported: the selection does not
 * commit on this path, so without a report the switch is an invisible no-op.
 * Degrade and TELL the user, never degrade silently.
 */
export type TransitionAborted = { kind: "aborted"; reason: string };

interface LayoutHooks {
  transition(from: ActiveSelection, to: ActiveSelection): Promise<SwitchOutcome>;
  onOutcome?(outcome: SwitchOutcome | TransitionAborted): void;
}

/**
 * Whether this space's membership actually depends on the property index.
 *
 * Holding a property member is not enough: a FOLDER SPACE renders from its
 * root and never reads its member list, so a leftover property member in one
 * changes nothing, and it must neither wait for an index nor pay for the walk
 * that builds one. `membersForSnapshot` makes the same distinction, in the
 * same order.
 */
function resolvesPropertyMembers(space: SpaceDefinition): boolean {
  return !hasRoot(space) && holdsPropertyMember(space);
}

export class SpaceController {
  private snapshot: VisibilitySnapshot | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  // Set the guard, suppressing reentrant layout-change and visitor
  // recomputation, then await changeLayout(), which restores leaves one at a
  // time — each firing file-open against the OLD selection, since the new one
  // commits only after transition() resolves below. Without it, main.ts's
  // handlers classify the incoming space's restored tabs as visitors inside
  // the outgoing space's tree: a full snapshot rebuild per restored leaf. It
  // converges either way — this guards against wasted work, not wrong output.
  private switching = false;

  /**
   * Set once by `dispose()` when the plugin unloads, and never cleared — a
   * disposed controller is dead, not paused.
   *
   * Deliberately NOT `switching`: that flag guards against *wasted* work and
   * is cleared in a `finally`; this one guards against *harmful* work after
   * teardown and must survive every `finally` in the class.
   *
   * The hazard is specific: `switchTo` parks on `layout.transition()`, and
   * everything downstream of that await re-installs what teardown has just
   * removed — leaving a filtered explorer owned by a disabled plugin.
   */
  private disposed = false;

  /**
   * Owned here rather than derived per-recompute. Restoring a layout closes
   * leaves, so a derived set would make a tabs setting govern visibility.
   */
  private revealed = new RevealedSet();

  constructor(
    private defs: DefinitionStore,
    private runtime: RuntimeStateStore,
    private vault: VaultIndex,
    private host: ControllerHost,
    private tags: TagIndex,
    private properties: () => PropertySnapshot,
    private layout?: LayoutHooks
  ) {}

  /**
   * The vault index is a snapshot, so it is replaced wholesale when the vault
   * changes. Mutating in place keeps every captured controller reference valid.
   */
  setVaultIndex(index: VaultIndex): void {
    this.vault = index;
  }

  /**
   * The tag index is a snapshot, like the vault index, and is replaced
   * wholesale when a note's metadata changes.
   */
  setTagIndex(index: TagIndex): void {
    this.tags = index;
  }

  /**
   * The property snapshot accessor is replaced wholesale when a note's
   * metadata changes, for the reason the tag index is. It is a FUNCTION so a
   * lazy one costs nothing until a property member asks.
   */
  setPropertySnapshot(get: () => PropertySnapshot): void {
    this.properties = get;
  }

  /**
   * The property index the tree is drawn from: the ready one when the
   * snapshot is ready, otherwise the last one that WAS ready, and `null` only
   * when none ever has been (a true first start).
   *
   * Exposed, as `tagIndex()` is, so a membership question asked outside a
   * recompute answers from the same picture the tree was drawn from rather
   * than from a second one that may differ. Not the raw snapshot: while the
   * cache is cold that is `null`, which would make an add path refuse or
   * misjudge a note the tree is showing. Each call asks the accessor, which
   * answers from its own one build, so the cost of asking is a walk only for
   * the FIRST caller after a metadata event. A caller that needs it for
   * several spaces still reads it ONCE and passes it down, so every space it
   * answers for describes one picture.
   */
  drawnPropertyIndex(): PropertyIndex | null {
    const snapshot = this.properties();
    if (snapshot.status === "ready") this.lastReadyIndex = snapshot.index;
    return this.lastReadyIndex;
  }

  /**
   * The tag index the CURRENT snapshot was computed from.
   *
   * Exposed so a membership question asked outside a recompute answers from
   * the same picture the tree was drawn from, rather than taking a second,
   * possibly different one. *All*'s "Add to space" menu is the caller.
   */
  tagIndex(): TagIndex {
    return this.tags;
  }

  /** The vault index this controller computes against. */
  vaultIndex(): VaultIndex {
    return this.vault;
  }

  activeSpace(): SpaceDefinition | null {
    const sel = this.runtime.getSelection();
    if (sel.kind === "all") return null;
    const space = this.defs.get().spaces.find((s) => s.id === sel.id);
    // An archived space is away, which is the same state as one that is not in
    // the array: All. `recompute` then rewrites the stored selection to All on
    // the next refresh, so restoring the space does NOT put the user back in it.
    return space && !isArchived(space) ? space : null;
  }

  currentSnapshot(): VisibilitySnapshot | null {
    return this.snapshot;
  }

  /**
   * `target` may be a resolver instead of a fixed selection, so a caller whose
   * target is RELATIVE to the current one ("next space") computes it from the
   * committed selection inside the queue. Two rapid presses then advance two
   * spaces; reading the selection at call time made the second press resolve
   * to the same target as the first and run a self-transition.
   */
  async switchTo(
    target: ActiveSelection | ((current: ActiveSelection) => ActiveSelection)
  ): Promise<void> {
    const run = this.queue.then(async () => {
      // Cheap: a switch issued after teardown never starts.
      if (this.disposed) return;
      const from = this.runtime.getSelection();
      const selection = typeof target === "function" ? target(from) : target;
      // The idempotence check belongs HERE, beside the `from` read it is
      // about. Outside the queue it compared against a selection an in-flight
      // switch had not committed yet, so a click back to the space the user is
      // actually in was dropped as redundant and they landed in the wrong
      // space.
      if (sameSelection(from, selection)) return;
      // End the previous visit's restore-carry BEFORE the transition runs. A
      // reveal whose leaf spaces itself closed survives for the duration of
      // that space visit; a new switch ends the visit, so from here the path
      // prunes like any other closed tab. An indefinite carry made a reveal
      // from one space follow the user into spaces it was never opened in and
      // made "Remove from space" look broken. It must run before the await,
      // not after: the post-commit `recompute({ pruneClosed: false })` below
      // is what re-carries whatever THIS switch's restore closes.
      this.revealed.releaseCarried();
      // Set before the await, cleared in `finally` so it still comes down if
      // transition() rejects or onOutcome() throws: refresh() must resume
      // working on the very next call after a failed switch.
      this.switching = true;
      try {
        // The selection commits only when the transition left the TARGET's
        // workspace on screen. A rollback re-applied the outgoing one and a
        // rejection never got the target applied at all, so committing either
        // would make the next departure capture the outgoing workspace into
        // the target's slot. `restored`, `adopted` and `skipped` all mean the
        // switch happened.
        let commit = true;
        if (this.layout) {
          let outcome: SwitchOutcome | TransitionAborted;
          try {
            outcome = await this.layout.transition(from, selection);
          } catch (e) {
            // A layout failure must never block the tree filter — the
            // recompute below still runs, only against `from` — and must not
            // be silent: `aborted` is what reaches the host, so it can tell
            // the user the switch did not happen.
            console.error("[spaces] layout transition failed", e);
            outcome = { kind: "aborted", reason: String(e) };
          }
          // The load-bearing check: `transition` is the one await in this
          // method that can span a teardown, so a switch that outlived its
          // plugin stops here, before the host is asked to rebind and before
          // anything is committed.
          if (this.disposed) return;
          commit =
            outcome.kind !== "rolled-back" &&
            outcome.kind !== "failed-open" &&
            outcome.kind !== "aborted";
          // Separately caught: `onOutcome` runs AFTER a transition that
          // already reported its result, so a throw in it says nothing about
          // whether the layout landed and must not veto a switch that
          // succeeded.
          try {
            this.layout.onOutcome?.(outcome);
          } catch (e) {
            console.error("[spaces] layout outcome hook failed", e);
          }
        }
        if (commit) this.runtime.setSelection(selection);
        // pruneClosed: false — a switch is spaces closing tabs, never the
        // user. Pruning here would delete exactly the reveal the user is
        // switching in to look at.
        this.recompute({ pruneClosed: false });
      } finally {
        this.switching = false;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A file was opened in the main window. Recording it is separate from
   * recomputing, so this still lands correctly while a switch's guard is
   * suppressing refresh() — the post-commit recompute reads the set.
   *
   * A restore fires file-open for every leaf IT reopens, but `noteOpened`'s
   * dismissal wipe means "the user wants to see this again", so during a
   * switch it must not run: spaces's own actions must not mutate spaces's
   * own bookkeeping. `sync` re-adds live paths on the post-commit recompute.
   */
  onFileOpened(path: string, live: Set<string> = this.host.livePaths()): void {
    if (this.switching) return;
    this.revealed.noteOpened(path);
    // `live` is the leaf walk this call already needed. `onActiveFileChanged`
    // walks once and threads it here so a single `file-open` does not walk
    // three times; nothing awaits in between, so the set is current.
    this.refreshWith(live);
  }

  /**
   * The workspace's active-file signal, translated into revealed-set policy.
   * `null` means the newly active pane names no file: it recomputes with
   * pruning like an ordinary `refresh()`. A string path the walk can see is
   * additionally recorded as deliberately (re)opened via `onFileOpened`, which
   * is what clears a prior dismissal; one the walk cannot see recomputes like
   * `null` (see the gate below). This policy belongs here rather than in
   * main.ts's `file-open` listener, which has no tests.
   */
  onActiveFileChanged(path: string | null): void {
    if (path === null) {
      this.refresh();
      return;
    }
    // main.ts dispatches for EVERY `file-open`, while `livePaths()` is
    // deliberately narrower: it excludes sidebar and pop-out leaves, and
    // `livePathsFrom`'s per-leaf catch can drop a leaf that fails to identify
    // itself. For such a path `noteOpened` would clear its dismissal and
    // un-carry it, and the recompute would then prune it because it is not
    // live — a dimmed row vanishing with the user having closed nothing, and
    // an explicit "Stop showing here" silently erased. So an open counts as
    // deliberate only when the walk can actually see it; otherwise recompute
    // and mutate no bookkeeping.
    const live = this.host.livePaths();
    if (!live.has(path)) {
      this.refreshWith(live);
      return;
    }
    this.onFileOpened(path, live);
  }

  /** "Stop showing here" — drops a reveal without touching membership. */
  dismissRevealed(path: string): void {
    this.revealed.dismiss(path);
    this.refresh();
  }

  /**
   * Recompute from current definitions and re-apply. Cheap and idempotent —
   * except while a switch's layout transition is in flight, when it is a
   * no-op. Only this external entry point is guarded; the internal
   * post-commit recompute above still runs.
   */
  refresh(): void {
    this.refreshWith(this.host.livePaths());
  }

  /**
   * Call FIRST in the host's teardown, before anything is unpatched: from
   * here the controller does nothing that touches the host.
   *
   * Idempotent, and one-way. A switch already parked on an await still runs to
   * completion — a promise cannot be un-awaited — but it commits nothing,
   * rebinds nothing and applies nothing when it resumes.
   */
  dispose(): void {
    this.disposed = true;
    // The kept index is the one piece of state here that is large: a whole
    // vault's frontmatter keys, and the value buckets of everything anyone
    // expanded. Nothing asks after this, so holding it would keep megabytes
    // reachable from a torn-down controller for the rest of the session.
    //
    // BOTH REFERENCES TO IT, not just this one. `this.properties` is the
    // plugin's lazy snapshot accessor and it MEMOIZES: once anything has
    // asked, that closure holds the very index `lastReadyIndex` holds, so
    // dropping one of the two freed nothing in the common case, which is
    // every case where a property member was ever resolved. It is replaced
    // with the accessor a controller that has not been handed one starts
    // with, so a late caller gets the same "nothing available" answer it
    // would have got before teardown rather than a throw.
    this.lastReadyIndex = null;
    this.properties = UNAVAILABLE_PROPERTIES;
  }

  /**
   * `refresh()` for a caller that has already walked the leaves — the guard
   * stays in one place so it cannot be forgotten at a new call site.
   */
  private refreshWith(live: Set<string>): void {
    if (this.switching) return;
    this.recompute({ pruneClosed: true }, live);
  }

  /**
   * A folder space has no member list, but the visibility engine is written in
   * terms of one — and that engine is where `globalIgnore`, visitors and
   * precedence live. So a folder space presents itself as a space whose single
   * member is its root folder: everything under it is then an inherited member
   * by the existing rules, and the hoist (main.ts) stays a rendering concern
   * rather than a second visibility path.
   *
   * Two `rootOf`-null cases must not be conflated: `rootOf` returns null both
   * for a curated space (no root declared at all) and for a folder space
   * DECLARING an unusable root spelled as the vault root (`""`/`"/"` —
   * `hasRoot` true, the missing-root state). `hasRoot` tells those apart; only
   * the latter falls back to `members`.
   *
   * ANY missing-root shape must render the empty tree: a hand-edited
   * `root: ""` can still carry a leftover `members` list, and rendering those
   * would diverge from a root naming a folder gone from the vault, which
   * empties correctly by the existing mechanism.
   *
   * Storage is left alone — only what is handed to the engine changes.
   */
  private membersForSnapshot(
    space: SpaceDefinition,
    // Read ONCE per recompute by `propertiesFor` and handed down, because the
    // readiness gate above needs the same answer and two asks could differ.
    properties: PropertyIndex | null,
    // The SAME compiled ignore the engine below is handed, not a second
    // compile of the same settings. A rule member honours it during the
    // expansion, because by the time the engine sees the result every member
    // is a path member and the two kinds are no longer distinguishable; the
    // engine's own ignore step still applies to a folder member's
    // descendants. One matcher for both, so they cannot disagree.
    ignore: IgnoreMatcher
  ): readonly PathMember[] {
    if (hasRoot(space)) {
      const root = rootOf(space);
      return root === null ? [] : [{ path: root, kind: "folder" }];
    }
    // UNAVAILABLE IS NOT EMPTY. `drawnPropertyIndex` falls back to the last
    // READY index, because resolving property members against nothing would
    // blank a property space's rows whenever the cache is cold. EVERYTHING
    // ELSE resolves fresh against it: exclusions, file, folder and tag members
    // all still apply, so removing or adding a note while cold does what it
    // says instead of missing a cache and emptying the space. Nothing is keyed
    // on the definition for that reason. The property matches themselves may
    // be stale until the parse event that makes the snapshot ready recomputes
    // the space. With no ready index yet this is not reached at all for such a
    // space: `stillReading` holds the recompute back, because publishing
    // members resolved against nothing would publish "not known yet" as
    // "matches nothing".
    return resolveMembers(space, this.tags, properties, ignore);
  }

  /**
   * The property index this recompute resolves against, read ONCE and handed
   * to both readers, so the gate and the resolve cannot disagree.
   *
   * `null` without asking at all unless the space's membership actually
   * depends on it: the first ask after a metadata event is a frontmatter walk
   * of the whole vault, and neither a space with no property member nor a
   * folder space — which renders from its root and never reads its member
   * list — may pay for one.
   */
  private propertiesFor(space: SpaceDefinition): PropertyIndex | null {
    return resolvesPropertyMembers(space) ? this.drawnPropertyIndex() : null;
  }

  /**
   * Whether this space's membership is still unknown rather than empty.
   *
   * TWO signals, not one, because they measure different things.
   * `metadataReady` is the host's: resolved, and the layout ready. Snapshot
   * readiness is strictly stricter — ONE unparsed file makes the whole
   * property snapshot unavailable (`ObsidianPropertyIndex.ts` says why), and
   * that can outlast `resolved`. Reading only the host's signal let a space
   * pass this gate with no ready index behind it, so `resolveMembers` was
   * handed `properties = null`, every property member contributed nothing,
   * and the space published itself EMPTY. `resolveMembers.ts` states the
   * contract that breaks: null is "not known yet", not "matches nothing", and
   * a caller publishing the result as a membership must hold its previous
   * answer instead.
   *
   * Both arms are cheap in the case that matters. `metadataReady` answers on
   * its own and the index is never asked for, which is why `properties` is a
   * thunk: reading it before this point made a property space pay for a walk
   * at first paint that this gate was about to make pointless. A space that
   * resolves no property member never asks either.
   * `drawnPropertyIndex` keeps the last READY index, so this is false as soon
   * as one has EVER been ready: a cache going cold mid-session neither blanks
   * a space that already has a good answer nor re-opens the tree. Reachable
   * only before the first ready index of a session, which is why the
   * fall-open below is the right posture for it.
   */
  private stillReading(
    space: SpaceDefinition,
    properties: () => PropertyIndex | null
  ): boolean {
    if (this.host.metadataReady?.() === false) return true;
    return resolvesPropertyMembers(space) && properties() === null;
  }

  /**
   * The last READY property index this controller saw, used only while the
   * snapshot is unavailable. Never replaced by an unavailable answer.
   *
   * Held for the life of the controller, not for the life of the need: it is
   * not dropped when the last property member is removed, because the next
   * ready snapshot would replace it anyway and a space can regain one between
   * two recomputes. `dispose()` releases it, so teardown does not leave a
   * vault-sized structure reachable.
   */
  private lastReadyIndex: PropertyIndex | null = null;

  private recompute(
    opts: { pruneClosed: boolean },
    live: Set<string> = this.host.livePaths()
  ): void {
    // The single choke point every snapshot application reaches, so one guard
    // covers entry points a future one will not have to remember. It reads the
    // host, so it must not run after teardown.
    if (this.disposed) return;
    // Sync before the early return: the revealed set is global, so it must
    // track live leaves even while All is active and nothing is filtered.
    // ONE walk per recompute: the membership exit below needs the same set,
    // and two walks could disagree if a leaf closed between them.
    this.revealed.sync(live, opts);

    const space = this.activeSpace();
    if (!space) {
      // Either All, or an active space that no longer exists: fail to All.
      if (this.runtime.getSelection().kind === "space") {
        this.runtime.setSelection({ kind: "all" });
      }
      this.snapshot = null;
      this.host.apply(null);
      return;
    }
    // FALL OPEN WHILE THE METADATA CACHE IS STILL BUILDING.
    //
    // `onLayoutReady` fires long before Obsidian finishes parsing, and
    // `getAllTags` returns null for every file it has not reached, so a tag
    // space resolved to zero members at first paint: 0 folder rows, 1 file
    // row, no loading state, no explanation, for the ~3 s the cache takes to
    // settle on a 10,000 note vault. That is indistinguishable from data
    // loss, and the coalescer does not bound it — 6,550 `changed` events over
    // 2 s produced exactly one flush, because the 250 ms max-wait cannot fire
    // while the main thread is busy.
    //
    // Unfiltered rather than the previous snapshot, on purpose. At FIRST
    // PAINT — the only moment either arm of `stillReading` can be true —
    // there is no previous snapshot, so holding one degenerates to this
    // anyway for the case that matters; and showing everything is this
    // plugin's existing, stated failure posture ("Showing all files"),
    // whereas holding a frozen tree over a vault that has since changed on
    // disk is wrong in a way the user cannot see. It is self-correcting:
    // `resolved` fires, or the parse that makes the property snapshot ready
    // does, main.ts requests a recompute, and the tree filters.
    //
    // Gated on `watchesMetadata`, so a folder space and a curated space of
    // paths still filter normally at first paint — neither has anything to
    // wait for, and falling open for them would trade one wrong tree for
    // another.
    //
    // The hazard: a tag space that genuinely matches nothing MUST still
    // render empty. "No matches yet" and "no matches" are different answers,
    // which is why this reads a readiness signal and not the member count.
    // `stillReading` carries both signals and what each one knows.
    // At most one read per recompute, and none at all when the gate below can
    // answer without it: the gate and the snapshot further down must be handed
    // the same answer, or they can disagree about what this space holds.
    let asked: PropertyIndex | null | undefined;
    const properties = (): PropertyIndex | null =>
      (asked = asked === undefined ? this.propertiesFor(space) : asked);
    if (watchesMetadata(space) && this.stillReading(space, properties)) {
      this.snapshot = null;
      this.host.apply(null);
      return;
    }
    const settings = this.defs.get().settings;
    const ignore = compileIgnore(settings.globalIgnore);
    const revealed = this.revealed.paths();
    // Off means nothing is revealed, and nothing else changes.
    const visitors = settings.revealVisitors ? revealed : new Set<string>();
    this.snapshot = buildVisibilitySnapshot(
      this.vault,
      { ...space, members: [...this.membersForSnapshot(space, properties(), ignore)] },
      visitors,
      ignore,
      new Set((space.exclude ?? []).map(canonicalPath))
    );
    // The first exit condition: a path that has BECOME a member of the active
    // space leaves the revealed set. Nothing changes on screen — what changes
    // is that the bookkeeping stops outliving the membership: without this, a
    // carried reveal survived "Add to space" and then "Remove from space", and
    // the row came back as a `visitor` with no leaf open anywhere.
    //
    // Iterates `revealed`, NOT `visitors`: entry into the revealed set is
    // ungated by `revealVisitors`, so this exit must be too, or the setting
    // would change what a space CONTAINS and not merely what it shows.
    for (const p of revealed) {
      // LIVE PATHS ARE NEVER FORGOTTEN — but not because forgetting one would
      // change what THIS space shows: the precedence reports
      // `exact-member`/`inherited-member` either way, so ablating this gate
      // leaves the whole suite green.
      //
      // The reason is provenance. `forget()` clears `deliberate`, which is
      // what lets a reveal survive a restore in a LATER, DIFFERENT space (the
      // carry — see `RevealedSet.sync`). Forgetting a deliberately-opened path
      // here wipes that marking, and `sync` keeps re-adding it while it stays
      // live, so nothing looks wrong in THIS space — but the next switch to a
      // space where it is not live prunes it immediately. It costs nothing
      // when the path is NOT deliberate: `sync` re-adds every live path
      // anyway.
      if (live.has(p)) continue;
      const reason = this.snapshot.decisionFor(p).reason;
      if (reason === "exact-member" || reason === "inherited-member") {
        this.revealed.forget(p);
      }
    }
    this.host.apply(this.snapshot);
  }
}
