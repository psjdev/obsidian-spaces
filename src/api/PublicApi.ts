import { inheritedFromFolder } from "../actions/membershipMenu";
import { pathMembers } from "../definitions/membership";
import { canonicalPath } from "../visibility/glob";
import type {
  ActiveSelection,
  SpaceDefinition,
  SpacesApi,
  SpaceSummary,
} from "../types";

/**
 * The surface other plugins are allowed to touch, and the subscriber list
 * behind it.
 *
 * Kept apart from the plugin class because it is the one part of spaces with
 * consumers outside this repo: a reader asking "what may I depend on?" should
 * find the answer in one file rather than assembled out of a much larger one.
 * The types themselves stay in `types.ts`, which is where the declared shape
 * lives.
 */

/**
 * What the API reads.
 *
 * Every field is a FUNCTION, and that is load-bearing rather than stylistic.
 * The plugin publishes `api` from a field initialiser, which runs before the
 * stores exist, so anything captured by value here would be captured as
 * `undefined` and stay that way. Resolving per call is what lets the surface be
 * handed out immediately and answer correctly later.
 */
interface PublicApiDeps {
  /** Every stored space; empty before the definitions store is loaded. */
  spaces: () => readonly SpaceDefinition[];
  /** The active selection, or null before the runtime store is loaded. */
  selection: () => ActiveSelection | null;
  /** Whether filtering is paused — a paused tree has no marked space. */
  filteringPaused: () => boolean;
}

export class PublicApi {
  private readonly listeners = new Set<(space: SpaceSummary | null) => void>();

  /**
   * The id last announced, so the event fires once per actual change.
   * `undefined` means nothing has been announced yet, which is distinct from
   * `null` — All, announced.
   */
  private announced: string | null | undefined = undefined;

  constructor(private readonly deps: PublicApiDeps) {}

  /** Every stored space, or none before the store has loaded. */
  allSpaces(): readonly SpaceDefinition[] {
    return this.deps.spaces();
  }

  spaceById(id: string): SpaceDefinition | null {
    return this.allSpaces().find((s) => s.id === id) ?? null;
  }

  /** The space the user has selected, or null in All. */
  activeSpace(): SpaceDefinition | null {
    const sel = this.deps.selection();
    if (!sel || sel.kind === "all") return null;
    return this.spaceById(sel.id);
  }

  /**
   * The space the TREE is filtered to. Null while filtering is paused, even
   * though a space is still selected — the body marker and the API must agree
   * with what the user can actually see.
   */
  markedSpace(): SpaceDefinition | null {
    return this.deps.filteringPaused() ? null : this.activeSpace();
  }

  /**
   * Fires `onSpaceChange` if the marked space has changed since the last call.
   *
   * Idempotent on purpose: the caller runs on every file open as well as every
   * switch, and the body marker it sets alongside is idempotent too — but an
   * event is not, so the comparison lives here.
   */
  announce(): void {
    const space = this.markedSpace();
    const id = space?.id ?? null;
    if (id === this.announced) return;
    this.announced = id;
    const summary = space ? summarise(space) : null;
    // Over a copy: a listener may unsubscribe — or subscribe — from inside its
    // own callback.
    for (const listener of [...this.listeners]) {
      try {
        listener(summary);
      } catch (e) {
        // One bad subscriber must not stop the others being told.
        console.error("Spaces: an onSpaceChange subscriber threw", e);
      }
    }
  }

  /** Drops every subscriber and forgets what was announced. */
  dispose(): void {
    this.listeners.clear();
    this.announced = undefined;
  }

  /**
   * The object handed to consumers.
   *
   * Arrow functions throughout, so it survives destructuring: a plain method
   * would lose `this` the moment anyone wrote `const { isMember } = api`, which
   * is exactly the breakage a declared surface exists to prevent.
   */
  readonly surface: SpacesApi = {
    getActiveSpace: () => {
      const space = this.markedSpace();
      return space ? summarise(space) : null;
    },
    listSpaces: () => this.allSpaces().map(summarise),
    isMember: (path, spaceId) => {
      const space = spaceId === undefined ? this.activeSpace() : this.spaceById(spaceId);
      if (!space) return false;
      if (pathMembers(space).some((m) => canonicalPath(m.path) === canonicalPath(path))) return true;
      // Membership is not ownership. A path under a member FOLDER is a member
      // without a stored entry of its own, and answering from `members` alone
      // would call it a non-member.
      return inheritedFromFolder(space, path) !== null;
    },
    memberPaths: (spaceId) => {
      const space = spaceId === undefined ? this.activeSpace() : this.spaceById(spaceId);
      return space ? pathMembers(space).map((m) => m.path) : [];
    },
    onSpaceChange: (listener) => {
      this.listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        this.listeners.delete(listener);
      };
    },
  };
}

/** The API hands out this, never the stored `SpaceDefinition`. */
function summarise(space: SpaceDefinition): SpaceSummary {
  return { id: space.id, name: space.name, icon: space.icon, color: space.color };
}
