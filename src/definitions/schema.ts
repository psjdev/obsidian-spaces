import {
  SCHEMA_VERSION,
  type MemberEntry,
  type OrderMap,
  type SpaceOrders,
  type SpaceDefinition,
  type SpacesDefinitions,
  type StripPlacement,
  type ActiveSpaceStyle,
} from "../types";

export type ValidationResult =
  | { ok: true; value: SpacesDefinitions }
  | { ok: false; error: string; futureSchema: boolean };

const COLOR = /^#[0-9a-f]{6}$/i;
const STRIP_PLACEMENTS = new Set(["bottom", "top", "left", "right"]);
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
    const { path, kind } = m as Record<string, unknown>;
    if (!isSafeVaultPath(path)) return null;
    if (kind !== "file" && kind !== "folder") return null;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, kind });
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
  // never as a reason to discard the id/name/icon/colour/members around it.
  //
  // A non-string `root` (a hand-edited `null`, a number, an object, ...) or
  // one that is an unsafe vault path in the ordinary sense (`../`, a drive
  // letter, a backslash, traversal) is exactly that: unusable, not
  // incoherent. Dropping the whole space over it would turn a single bad
  // string into the loss of the space's name, icon, colour and members on
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
  const members = validateMembers(r.members);
  if (!members) return null;
  return {
    id: r.id,
    name: r.name,
    icon: r.icon,
    color: r.color,
    ...(root === undefined ? {} : { root }),
    members,
  };
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
      schemaVersion: SCHEMA_VERSION,
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
        // Defaults to FALSE, so absent and non-boolean collapse to the
        // same answer and no `undefined` branch is needed. Strict for the same
        // reason as the keys above — `pinAllSpace: 1` must not read as true.
        pinAllSpace: st.pinAllSpace === true,
        // Defaults to FALSE like `pinAllSpace` above, so absent and
        // non-boolean collapse to the same answer. Strict for the same reason:
        // `showPinnedFolder: 1` must not read as true.
        showPinnedFolder: st.showPinnedFolder === true,
        // Defaults to true, strict like `showSpaceHeader` above —
        // `autoAssignColor: 0` must not read as true the way a `!== false`
        // check would make it. An explicit false is kept: someone who turned
        // colour off wants it off, and re-enabling it on the next load would
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
