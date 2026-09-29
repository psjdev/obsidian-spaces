import {
  SCHEMA_VERSION,
  type MemberEntry,
  type OrderMap,
  type SpaceOrders,
  type SpaceDefinition,
  type SpacesDefinitions,
  type StripPlacement,
  type ActiveSpaceStyle,
  type DropIndicatorStyle,
} from "../types";
import { normalizeTag } from "../visibility/tagMatch";
import { canonicalPath } from "../visibility/glob";

export type ValidationResult =
  | { ok: true; value: SpacesDefinitions }
  | { ok: false; error: string; futureSchema: boolean };

const COLOR = /^#[0-9a-f]{6}$/i;
const STRIP_PLACEMENTS = new Set(["bottom", "top", "left", "right"]);
const DROP_INDICATOR_STYLES = new Set(["box", "line"]);
/**
 * Each stored value and the style it means. `box` and `bold` were the names
 * up to 0.6.0: `box` drew the theme's shading and nothing else by then, which
 * is what `shaded` draws, so both old names keep their look rather than being
 * approximated. Dropping them would silently reset the setting on upgrade.
 */
const ACTIVE_SPACE_STYLES = new Map<string, ActiveSpaceStyle>([
  ["shaded", "shaded"],
  ["boxed", "boxed"],
  ["bolded", "bolded"],
  ["box", "shaded"],
  ["bold", "bolded"],
]);
/** The same cap the picker enforces, applied to hand-edited documents. */
const MAX_CUSTOM_COLORS = 12;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * `ID` accepts all three of these, and `orders.bySpaceId` is a plain
 * object indexed by the id: `bySpaceId[id] ??= {}` with `id === "__proto__"`
 * reads the inherited accessor (truthy, so no assignment happens) and the
 * next line writes onto `Object.prototype` itself, for the whole renderer.
 * The order maps are also built with a null prototype below — this rejection
 * stops a NEW id of that shape, the null prototype covers an old document
 * that already carries one.
 */
export const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Space name cap, enforced here. Exported so a caller that builds a name
 * BEFORE it ever reaches `validateSpace` — the create-space form's
 * `validateForm` and its `<input maxlength>` — enforces the identical rule
 * instead of re-typing `100` and risking drift. Without that, a pasted long
 * name passes the form's own check, the write fails here, and the panel
 * reports a Notice with no visible reason and an unchanged form — an opaque,
 * repeating dead end.
 */
export const MAX_SPACE_NAME_LENGTH = 100;

function fail(error: string, futureSchema = false): ValidationResult {
  return { ok: false, error, futureSchema };
}

/** Vault-relative, no traversal, no drive letters, no backslashes. */
export function isSafeVaultPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 1000) return false;
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return false;
  return !p.split("/").some((seg) => seg === ".." || seg === ".");
}

function validateMembers(raw: unknown): MemberEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: MemberEntry[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const { kind } = m as Record<string, unknown>;
    if (kind === "file" || kind === "folder") {
      const { path } = m as Record<string, unknown>;
      if (!isSafeVaultPath(path)) return null;
      // Namespaced so a tag can never collide with a path in this set.
      const key = "p:" + path;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, path });
      continue;
    }
    if (kind === "tag") {
      const { tag } = m as Record<string, unknown>;
      if (typeof tag !== "string") return null;
      const normalized = normalizeTag(tag);
      if (normalized.length === 0) return null;
      const key = "t:" + normalized;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "tag", tag: normalized });
      continue;
    }
    // An unrecognised kind is still fatal, which rejects the whole document
    // rather than silently dropping a member an older build would then write
    // back without. See the forward compatibility section of the spec.
    return null;
  }
  return out;
}

/**
 * One folder's order map. Defensive throughout: an unusable order
 * must never take the tree down, so anything unparseable is dropped and the
 * affected folder simply sorts natively. This never returns an error —
 * there is no failure mode here worth refusing to load a document over.
 *
 * The empty-string key is the vault root and is legitimate; `isSafeVaultPath`
 * rejects it (zero length), so it is allowed explicitly. Storage uses "" for
 * the root because Obsidian's own root path is "/", which that guard also
 * rejects — the wiring maps one to the other.
 */
function validateOrderMap(raw: unknown): OrderMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  // Null prototype: keys here are folder paths, and a folder named
  // `__proto__` is a legal vault path.
  const out: OrderMap = Object.create(null) as OrderMap;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== "" && !isSafeVaultPath(key)) continue;
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const p of value) {
      if (!isSafeVaultPath(p)) continue;
      // A path listed twice would make `applyOrder` emit the row twice.
      // First occurrence wins, matching `validateMembers`' de-dupe.
      if (seen.has(p)) continue;
      seen.add(p);
      list.push(p);
    }
    // Empty lists are dropped so a hand-edited file cannot accumulate dead
    // keys, and so `applyOrder`'s "no order" fast path is reached.
    if (list.length > 0) out[key] = list;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Returns undefined rather than an empty shell, so absence is one shape. */
export function validateOrders(raw: unknown): SpaceOrders | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const all = validateOrderMap(r.all);

  let bySpaceId: Record<string, OrderMap> | undefined;
  const rawBy = r.bySpaceId;
  if (rawBy && typeof rawBy === "object" && !Array.isArray(rawBy)) {
    // Null prototype: keys here are space ids, and a document written
    // before ids were screened can still carry `__proto__` as one. On a plain
    // object `acc["__proto__"] = map` would set acc's prototype instead of
    // storing the entry, so the order would silently vanish; on a null-
    // prototype object it is an ordinary own property.
    const acc: Record<string, OrderMap> = Object.create(null) as Record<string, OrderMap>;
    for (const [id, m] of Object.entries(rawBy as Record<string, unknown>)) {
      // An id for a space that no longer exists is harmless — it is simply
      // never consulted, and `deleteSpace` clears it on the normal path.
      const map = validateOrderMap(m);
      if (map) acc[id] = map;
    }
    if (Object.keys(acc).length > 0) bySpaceId = acc;
  }

  if (!all && !bySpaceId) return undefined;
  return { ...(all ? { all } : {}), ...(bySpaceId ? { bySpaceId } : {}) };
}

function validateSpace(raw: unknown): SpaceDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID.test(r.id)) return null;
  if (RESERVED_IDS.has(r.id)) return null;
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > MAX_SPACE_NAME_LENGTH) {
    return null;
  }
  if (typeof r.icon !== "string" || r.icon.length > 64) return null;
  if (typeof r.color !== "string" || !COLOR.test(r.color)) return null;
  // Folder spaces. This function's job is to load a document safely, not to
  // correct it, and the one thing it must never do is cost the user a space
  // — so `root` is validated for SHAPE only, and a value this loader cannot use is dropped as a single field,
  // never as a reason to discard the id/name/icon/color/members around it.
  //
  // A non-string `root` (a hand-edited `null`, a number, an object, ...) or
  // one that is an unsafe vault path in the ordinary sense (`../`, a drive
  // letter, a backslash, traversal) is exactly that: unusable, not
  // incoherent. Dropping the whole space over it would turn a single bad
  // string into the loss of the space's name, icon, color and members on
  // the very next write — and a rejected document is sticky, refusing every
  // write for the rest of the session.
  //
  // "" and "/" are NOT in that unusable set, even though neither is ever
  // honoured as a folder-space root: they are exactly the two spellings
  // of "no root chosen" (the missing-root state), and that is a decision
  // for `rootOf()` at runtime, not a rewrite this loader has any authority
  // to make. They are stored as given.
  //
  // `root` and `members` both populated is left alone in full for the same
  // reason: which one the runtime prefers is also `rootOf()`'s call, and
  // storing both loses nothing — clearing `root` later brings the members
  // straight back, whereas dropping the space cannot be undone by the user
  // at all.
  let root: string | undefined;
  if (typeof r.root === "string" && (r.root === "" || r.root === "/" || isSafeVaultPath(r.root))) {
    root = r.root;
  }
  // Shape only, entry by entry, exactly like `root` above: a bad string is
  // unusable, not incoherent, and dropping the whole space over one would
  // cost the user its name, icon, color and members.
  let exclude: string[] | undefined;
  if (Array.isArray(r.exclude)) {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const e of r.exclude) {
      if (!isSafeVaultPath(e)) continue;
      const folded = canonicalPath(e);
      if (seen.has(folded)) continue;
      seen.add(folded);
      kept.push(e);
    }
    if (kept.length > 0) exclude = kept;
  }
  const members = validateMembers(r.members);
  if (!members) return null;
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    color: r.color,
    ...(root === undefined ? {} : { root }),
    ...(exclude === undefined ? {} : { exclude }),
    members,
  };
}

/**
 * The version to stamp on a document about to be written.
 *
 * Version 2 added tag members and per-space exclusions. A build that only
 * understands version 1 rejects the whole document rather than dropping what
 * it does not recognise, which is the safe behaviour, but it is also a
 * plugin that refuses to work. So a document earns version 2 by using
 * something version 1 cannot hold, and nothing else.
 *
 * This matters for someone running two devices through Sync who upgrades one
 * of them first.
 *
 * Recomputed from current content every call, deliberately, rather than
 * remembering the version a document arrived with: removing the last tag
 * member or exclusion returns a document to version 1, so an older install
 * can open it again. That is why the incoming version is never consulted
 * here — considering it would quietly remove that recovery path.
 */
export function schemaVersionFor(spaces: readonly SpaceDefinition[]): number {
  const usesV2 = spaces.some(
    (s) => s.members.some((m) => m.kind === "tag") || (s.exclude?.length ?? 0) > 0
  );
  return usesV2 ? 2 : 1;
}

export function validateDefinitions(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("definitions must be an object");
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.schemaVersion !== "number" || !Number.isInteger(r.schemaVersion)) {
    return fail("schemaVersion must be an integer");
  }
  // Never reinterpret a future schema as v1.
  if (r.schemaVersion > SCHEMA_VERSION) {
    return fail(
      `schemaVersion ${r.schemaVersion} is newer than supported ${SCHEMA_VERSION}`,
      true
    );
  }

  const s = r.settings;
  if (!s || typeof s !== "object") return fail("settings must be an object");
  const st = s as Record<string, unknown>;
  const globalIgnore = Array.isArray(st.globalIgnore)
    ? st.globalIgnore.filter((p): p is string => typeof p === "string")
    : [];

  const orders = validateOrders(r.orders);

  if (!Array.isArray(r.spaces)) return fail("spaces must be an array");
  const spaces: SpaceDefinition[] = [];
  const ids = new Set<string>();
  for (const rawSpace of r.spaces) {
    const sp = validateSpace(rawSpace);
    if (!sp) return fail("invalid space definition");
    if (ids.has(sp.id)) return fail(`duplicate space id: ${sp.id}`);
    ids.add(sp.id);
    spaces.push(sp);
  }

  return {
    ok: true,
    value: {
      schemaVersion: schemaVersionFor(spaces),
      settings: {
        globalIgnore,
        // Defaults to FALSE, matching `DEFAULT_DEFINITIONS`. A *missing*
        // key (fresh install, or a document written before this setting
        // existed) becomes false; an *explicit* true is kept. Restoring tabs
        // moves the workspace on every switch, so it is opted into rather than
        // inherited from an absent key.
        restoreLayouts: st.restoreLayouts === true,
        // A missing key defaults to true, but a present
        // non-boolean is NOT trusted — `revealVisitors: 0` must not read as
        // true the way the looser check above would make it.
        revealVisitors:
          st.revealVisitors === undefined ? true : st.revealVisitors === true,
        // Defaults to true. Strict for the same reason as
        // `revealVisitors` directly above — `allowReordering: 0` must not
        // read as true. Only an absent key defaults to true; a present
        // non-boolean reads as false, consistent with the neighbouring key.
        allowReordering:
          st.allowReordering === undefined ? true : st.allowReordering === true,
        // Defaults to true, strict like its neighbours —
        // `allowReorderingAll: 0` must not read as true.
        allowReorderingAll:
          st.allowReorderingAll === undefined ? true : st.allowReorderingAll === true,
        // Defaults to true, strict for the same reason as the two keys
        // above — `showSpaceHeader: 0` must not read as true.
        showSpaceHeader:
          st.showSpaceHeader === undefined ? true : st.showSpaceHeader === true,
        // Degrades rather than rejects, exactly like `revealVisitors` above: a
        // hand-edited or future-version value must never cost someone their
        // spaces, and a strip in the wrong corner is a cosmetic complaint.
        stripPlacement:
          typeof st.stripPlacement === "string" && STRIP_PLACEMENTS.has(st.stripPlacement)
            ? (st.stripPlacement as StripPlacement)
            : "bottom",
        // Degrades for the same reason as the placement above, and to the
        // look every existing vault already has: a document written before
        // this setting existed carries no key at all.
        activeSpaceStyle:
          (typeof st.activeSpaceStyle === "string"
            ? ACTIVE_SPACE_STYLES.get(st.activeSpaceStyle)
            : undefined) ?? "shaded",
        // Degrades rather than rejects, like the two above. A wrong indicator
        // is a cosmetic complaint and must never cost someone their spaces.
        dropIndicatorStyle:
          typeof st.dropIndicatorStyle === "string" &&
          DROP_INDICATOR_STYLES.has(st.dropIndicatorStyle)
            ? (st.dropIndicatorStyle as DropIndicatorStyle)
            : "box",
        // Defaults to FALSE, so absent and non-boolean collapse to the
        // same answer and no `undefined` branch is needed. Strict for the same
        // reason as the keys above — `pinAllSpace: 1` must not read as true.
        pinAllSpace: st.pinAllSpace === true,
        // Defaults to FALSE like `pinAllSpace` above, so absent and
        // non-boolean collapse to the same answer. Strict for the same reason:
        // `showPinnedFolder: 1` must not read as true.
        showPinnedFolder: st.showPinnedFolder === true,
        // Defaults to FALSE for the same reason as the two above, and because
        // it changes how every existing install looks. Nothing here touches a
        // space's stored color: this key governs drawing alone.
        useThemeIconColor: st.useThemeIconColor === true,
        // Defaults to true, strict like `showSpaceHeader` above —
        // `autoAssignColor: 0` must not read as true the way a `!== false`
        // check would make it. An explicit false is kept: someone who turned
        // color off wants it off, and re-enabling it on the next load would
        // undo a choice they made on purpose.
        autoAssignColor:
          st.autoAssignColor === undefined ? true : st.autoAssignColor === true,
        // Same defensive shape as `globalIgnore`: keep what parses, drop
        // what does not, never refuse the document over a bad chip.
        customColors: Array.isArray(st.customColors)
          ? st.customColors
              .filter((c): c is string => typeof c === "string" && COLOR.test(c))
              .map((c) => c.toLowerCase())
              .filter((c, i, a) => a.indexOf(c) === i)
              .slice(0, MAX_CUSTOM_COLORS)
          : [],
      },
      spaces,
      ...(orders ? { orders } : {}),
    },
  };
}
