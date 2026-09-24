import type { OrderMap } from "./order/orderModel";

export type { OrderMap };

export type MemberKind = "file" | "folder";

export interface MemberEntry {
  path: string;
  kind: MemberKind;
}

export interface SpaceDefinition {
  id: string;
  name: string;
  icon: string;
  color: string;
  /**
   * A folder space's root: the one folder this space is a window onto.
   * Absent on a curated space, which uses `members` instead.
   *
   * Not enforced as mutually exclusive by `validateSpace` (schema.ts): a
   * `root` and non-empty `members` arriving together are stored as given.
   * `SpaceController.membersForSnapshot` decides at render time, preferring
   * `root` when it resolves to a real folder; `members` is never shown for
   * a space that declares a root.
   *
   * Never the vault root — that would show the whole vault with nothing
   * hidden, so the schema treats it as the missing-root state instead.
   *
   * Also the write target: creation in this space lands here, and the
   * folder itself is hidden.
   */
  root?: string;
  members: MemberEntry[];
}

/**
 * Where the space strip sits in the explorer pane.
 *
 * `"bottom"` is what the plugin has always done and stays the default: a
 * placement that moves on upgrade would rearrange a pane the user never asked
 * to have rearranged.
 */
export type StripPlacement = "bottom" | "top" | "left" | "right";

/**
 * How the strip marks the active space. Shaded is the theme's own selected
 * background and nothing else. Boxed adds a ring in the icon's colour over
 * that background. Bolded drops the background and draws the icon at a heavier
 * stroke. All three leave the active icon at full opacity while the rest stay
 * muted, so no look depends on a single cue.
 *
 * Stored documents from 0.4.0 to 0.6.0 hold `box` or `bold`; `schema.ts`
 * carries those across.
 */
export type ActiveSpaceStyle = "shaded" | "boxed" | "bolded";

interface SpacesSettings {
  globalIgnore: string[];
  /**
   * Governs the GESTURE, never the data: turning it off must not
   * delete a stored order, and turning it on must not synthesise one.
   */
  allowReordering: boolean;
  /**
   * Narrows `allowReordering` to spaces only. Off, *All* renders and
   * behaves as Obsidian's own tree; stored All orders are KEPT, not discarded.
   * Can only narrow the boolean above, never re-enable it.
   */
  allowReorderingAll: boolean;
  /**
   * Whether the space name sits above the file tree. Purely a display
   * choice — the switcher strip is the navigation, and for someone who reads
   * the strip fluently the header is a row of tree they would rather have.
   */
  showSpaceHeader: boolean;
  /**
   * Whether that header also carries a pin on the right when the space
   * is pinned to a folder, naming the folder on hover.
   *
   * Only meaningful while `showSpaceHeader` is on. Kept separate because it
   * answers a different question: WHICH space vs what that space IS.
   */
  showPinnedFolder: boolean;
  /**
   * Whether *All* sits pinned to the LEFT of the switcher strip, outside
   * the scrolling rail, the way the `+` control is pinned to the right. *All*
   * is already the first entry; pinning it means the other icons scroll past it
   * instead of taking it with them.
   */
  pinAllSpace: boolean;
  /**
   * Whether a new space is given the next colour in the palette, or
   * starts neutral for the user to colour themselves.
   *
   * On, consecutive spaces are told apart at a glance without anyone
   * deciding anything. Off, a new space looks like the rest of Obsidian's
   * chrome until its owner colours it — the popover then opens on the
   * first swatch, since that is the colour the space actually has.
   */
  autoAssignColor: boolean;
  /**
   * Whether every space icon is drawn in the theme's icon colour, ignoring
   * the colour the space stores.
   *
   * Drawing only. The stored colours are untouched, so turning this off
   * brings them all back exactly as they were. It is the blanket form of
   * what the neutral swatch does for a single space, for someone who wants
   * their theme to decide while keeping the colours they have set.
   *
   * Independent of `autoAssignColor`, which governs what a new space SAVES.
   * Both on means new spaces keep taking palette colours that nothing draws
   * until this goes off.
   */
  useThemeIconColor: boolean;
  /**
   * Custom colour chips, newest first, shared across spaces — a chip you
   * mix once is worth reusing on the next space, and keeping them per-space
   * would mean re-mixing the same colour to match two spaces.
   */
  customColors: string[];
  restoreLayouts: boolean;
  /**
   * Independent of restoreLayouts — one governs tabs, the other
   * governs which rows appear.
   */
  revealVisitors: boolean;
  /** Where the strip sits. See `StripPlacement`. */
  stripPlacement: StripPlacement;
  /** How the active space is marked. See `ActiveSpaceStyle`. */
  activeSpaceStyle: ActiveSpaceStyle;
}

/**
 * Per-space custom orders. The `all` / `bySpaceId` split mirrors
 * `RuntimeStateV1`'s `allLayout` / `layoutsBySpaceId` and exists for the same
 * reason: All is structural, never a magic id string, so no space id can
 * collide with it. Top-level rather than nested in `SpaceDefinition` because All
 * has no `SpaceDefinition` — the cost is that `deleteSpace` must drop its entry.
 */
export interface SpaceOrders {
  all?: OrderMap;
  bySpaceId?: Record<string, OrderMap>;
}

export interface SpacesDefinitions {
  schemaVersion: number;
  settings: SpacesSettings;
  spaces: SpaceDefinition[];
  orders?: SpaceOrders;
}

/** All is structural, never a magic id string. */
export type ActiveSelection =
  | { kind: "all" }
  | { kind: "space"; id: string };

export type VisibilityReason =
  | "exact-member"
  | "inherited-member"
  | "visitor"
  | "scaffold"
  | "hidden-ignore"
  | "hidden-nonmember";

export interface VisibilityDecision {
  visible: boolean;
  reason: VisibilityReason;
  canRemoveMembership: boolean;
  overridesIgnore: boolean;
}

/** Opaque. spaces stores and replays these; it never inspects or edits them. */
export type LayoutBlob = Record<string, unknown>;

export interface RuntimeStateV1 {
  activeSelection: ActiveSelection;
  /** All's own layout. Structurally separate so no space id can collide with it. */
  allLayout?: LayoutBlob;
  layoutsBySpaceId: Record<string, LayoutBlob>;
  /**
   * Which spaces render with Obsidian's own sort instead of their saved
   * order. View state, like a layout — not part of what a space IS, which is
   * why it lives here and not in the space definition.
   */
  nativeSortBySpaceId?: Record<string, boolean>;
  /** All's own flag, structurally separate so no space id can collide. */
  allNativeSort?: boolean;
}

export type SwitchOutcome =
  | { kind: "restored" }
  /** No stored layout for the target; the live layout became its layout. */
  | { kind: "adopted" }
  /** Restoration is off. Nothing captured, nothing restored. */
  | { kind: "skipped" }
  /** The target's layout produced an unusable workspace; outgoing re-applied. */
  | { kind: "rolled-back"; reason: string }
  /** Neither the target nor the rollback produced a usable workspace. */
  | { kind: "failed-open"; reason: string };

export const SCHEMA_VERSION = 1;

export const DEFAULT_DEFINITIONS: SpacesDefinitions = {
  schemaVersion: SCHEMA_VERSION,
  settings: {
    globalIgnore: [],
    // Off by default. Restoring tabs on every switch rearranges the workspace
    // the user was just looking at, which is a surprising thing for a tree
    // filter to do uninvited. The feature stays one toggle away.
    restoreLayouts: false,
    revealVisitors: true,
    // On by default: an additive interception (only between rows; folder
    // drops, drag-into-editor and drag-out-of-app are untouched), and a
    // feature defaulted off is a feature nobody finds.
    allowReordering: true,
    // On by default, so All behaves like a space until told otherwise.
    allowReorderingAll: true,
    // On by default: the orientation cue the feature exists for, which a
    // default of off would mean nobody discovers.
    showSpaceHeader: true,
    // OFF, unlike `showSpaceHeader`: this annotates a detail only some care
    // about, and adding chrome to an existing install unasked reads as a bug.
    showPinnedFolder: false,
    // OFF by default: this rearranges a strip every existing install already
    // reads fluently, and doing that unasked on an update reads as a bug.
    pinAllSpace: false,
    // ON, like its Appearance neighbours: colouring new spaces is what the
    // palette is for, and quietly stopping would read as the feature
    // breaking rather than a default being applied.
    autoAssignColor: true,
    // OFF: it changes how every existing install looks. Turning up after an
    // update with every icon the same colour reads as the colours having
    // been lost rather than as a default being applied.
    useThemeIconColor: false,
    customColors: [],
    stripPlacement: "bottom",
    activeSpaceStyle: "shaded",
  },
  spaces: [],
};

/**
 * What the public API hands out in place of a `SpaceDefinition`: the
 * identity and chrome of a space, and nothing that is an implementation
 * detail. Deliberately not the stored object — `members` is reached through
 * `memberPaths`/`isMember`, so the shape a consumer depends on does not grow
 * every time the definition does.
 */
export interface SpaceSummary {
  id: string;
  name: string;
  icon: string;
  color: string;
}

/**
 * Spaces's declared extension surface, reachable as
 * `app.plugins.plugins.spaces.api`.
 *
 * **Read-only, deliberately.** Every method is a projection of `data.json`
 * plus `RuntimeStateV1`, both versioned and validated, so the surface cannot
 * drift faster than the schema it projects. A `setActiveSpace` would commit
 * to the switch state machine's semantics, which are still changing, so it
 * is not offered.
 *
 * Every method answers from the CURRENT document; nothing here is cached,
 * and nothing here mutates. Arrays and objects returned are copies.
 */
export interface SpacesApi {
  /** The space filtering the tree, or `null` in *All* or while paused. */
  getActiveSpace(): SpaceSummary | null;
  /** Every defined space, in definition order — the order the strip uses. */
  listSpaces(): SpaceSummary[];
  /**
   * Whether `path` is a member of `spaceId` (default: the active space).
   *
   * MEMBERSHIP, not visibility: a path inherited from a member folder is a
   * member, and a member that `globalIgnore` hides is still a member.
   * False for *All*, for an unknown id, and while there is no active space.
   */
  isMember(path: string, spaceId?: string): boolean;
  /**
   * The EXACT stored member paths of `spaceId` (default: the active space).
   * `members` holds only exact entries — inherited ones are computed and
   * never stored — so a descendant of a member folder is a member without
   * appearing here. Empty for *All* and for an unknown id.
   */
  memberPaths(spaceId?: string): string[];
  /**
   * Fires when the ACTIVE SPACE changes, including to `null` for *All*. Not
   * on a rename, a membership edit or a re-render — it reports which space
   * is in force, not what is in it.
   *
   * Returns an idempotent unsubscribe function; a consumer that forgets to
   * call it leaks nothing, since the subscriber set is owned by the plugin
   * and dropped wholesale on unload.
   */
  onSpaceChange(listener: (space: SpaceSummary | null) => void): () => void;
}
