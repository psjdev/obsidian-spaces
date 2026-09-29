import type { CreateSpaceOptions } from "../actions/spaceLifecycle";
import type { MemberEntry } from "../types";
import { MAX_SPACE_NAME_LENGTH } from "../definitions/schema";

/**
 * Re-exported so `CreateSpacePanel.ts` — which already imports form rules
 * from this module — can set the name input's `maxlength` from the same
 * source `canCreate` below enforces, rather than importing `schema.ts`
 * directly for one constant or (worse) re-typing `100`.
 */
export { MAX_SPACE_NAME_LENGTH };

/**
 * The icon row offers presets rather than a free-text Lucide name.
 * A preset cannot be unavailable, so nothing created here can name an icon
 * that will not render. "box" leads because it is the default every space has
 * had so far.
 */
export const PRESET_ICONS = [
  "box",
  "microscope",
  "briefcase",
  "book",
  "code",
  "palette",
  "target",
  "sprout",
] as const satisfies readonly string[];

export interface CreateFormState {
  name: string;
  icon: string;
  color: string;
  /**
   * What the user has picked for a curated space, in the order they picked it.
   *
   * Files and folders both, carrying their kind — the picker reads the vault,
   * so it knows which it clicked, and `MemberEntry.kind` has always allowed
   * either. Empty for a folder space, which has a root instead.
   */
  items: readonly MemberEntry[];
  /**
   * A folder space's root, or `""` for a curated space. Held alongside
   * `items` rather than instead of it — each mode remembers its own side, and
   * `toCreateOptions` submits whichever side the MODE names, so the two can
   * coexist in state without either reaching storage. The schema does not
   * drop the combination if it were ever submitted anyway — validation never
   * deletes a space, so it stores both and leaves
   * the choice of which one renders to `SpaceController.membersForSnapshot`
   * at runtime. `toCreateOptions` below decides by `isFolderForm` rather than
   * trusting that convergence, precisely so this form can never be the thing
   * that submits the ambiguous shape.
   */
  root: string;
  /**
   * Whether the user has chosen "Folder Pinned".
   *
   * Separate from `root` being non-empty, which is what `isFolderForm` asks.
   * The tick is *intent*, held from the moment it is made; the root is what
   * that intent has been filled in with. Without the flag the panel would have
   * to infer the mode from a field's value, which is what it used to do — and
   * that meant the kind of space silently changed as the user typed, with both
   * kinds' controls on screen and nothing saying they were alternatives.
   *
   * The kind cannot be changed after creation, so this is a one-way
   * door and the panel makes it a visible choice rather than a side effect.
   */
  folderMode: boolean;
}

/**
 * The slice of the vault this module needs. Declared locally rather than
 * imported so the module depends on neither Obsidian nor the visibility
 * engine — the arrangement `src/actions/membershipMenu.ts` uses. The real
 * `VaultIndex` satisfies it structurally.
 */
export interface VaultSource {
  /**
   * Every file AND folder in the vault. It was folders alone until the create
   * panel's picker started offering files — `MemberEntry.kind` has always
   * allowed either, and the consumers that want folders alone (this module's
   * `folderCandidates`, `FolderSuggest`) filter with `kindOf` rather than
   * relying on the source to have pre-filtered for them.
   */
  allPaths(): string[];
  kindOf(path: string): "file" | "folder" | null;
}

export function emptyForm(color: string): CreateFormState {
  // `""` is "the user has not picked yet", which the panel renders as a dashed
  // placeholder beside the name input. It is NOT the same as choosing
  // `PRESET_ICONS[0]`: comparing against the default would silently reclassify
  // someone who picked "box" on purpose. `toCreateOptions` resolves the
  // sentinel at submit, so `SpaceDefinition.icon` stays a required string
  // (schema.ts:139) and every stored space still has an icon.
  return { name: "", icon: "", color, items: [], root: "", folderMode: false };
}

/** True once the form describes a folder space rather than a curated one. */
export function isFolderForm(s: CreateFormState): boolean {
  return s.root !== "" && s.root !== "/";
}

/**
 * Chooses the root a folder space will window onto. The vault root is accepted
 * into state but never makes the form a folder form: it would produce a space
 * showing the whole vault, which is *All* under another name.
 */
export function setRoot(s: CreateFormState, path: string): CreateFormState {
  return { ...s, root: path };
}

/**
 * Switches between Curate and Folder space, keeping both sides.
 *
 * It deliberately discards nothing. The two buttons invite clicking between
 * them, and a look at the other mode should not cost the five items you had
 * just picked. Nothing ambiguous can reach storage because `toCreateOptions`
 * submits whichever side the MODE names and ignores the other — the mode is
 * the single source of truth for what is being made, and the values are just
 * what each side remembers.
 */
export function setFolderMode(s: CreateFormState, on: boolean): CreateFormState {
  if (s.folderMode === on) return s;
  return { ...s, folderMode: on };
}

/** Which control a failed Create should point at, and what to say about it. */
export interface FormFault {
  field: "name" | "root";
  message: string;
}

/**
 * Whether a mode holds anything — the question that decides what a collapse
 * means.
 *
 * Each side answers for itself rather than for the mode currently in effect,
 * because the form remembers both: a file ticked under Curate must not make
 * the collapsed Pin button look chosen.
 */
export function modeHoldsChoice(s: CreateFormState, folderMode: boolean): boolean {
  return folderMode ? isFolderForm(s) : s.items.length > 0;
}

/**
 * Closing a mode's picker: keep the mode if it holds something, abandon it if
 * it does not.
 *
 * Collapsing an empty Pin to Folder used to leave `folderMode` on. The button
 * stopped looking pressed, so the mode was visibly abandoned, but the state
 * still held it — `validateForm` went on demanding a folder and Create went on
 * refusing one the user had walked away from. Falling back to curated makes
 * the collapsed panel mean what it looks like, and an empty curated form is
 * precisely the "neither clicked" case that is allowed to create.
 *
 * The root itself is left in place. Abandoning a mode is not deleting a
 * choice, so re-opening Pin to Folder finds the folder still there.
 */
export function collapseMode(s: CreateFormState, folderMode: boolean): CreateFormState {
  return modeHoldsChoice(s, folderMode) ? s : setFolderMode(s, false);
}

/**
 * What is wrong with the form, or `null` if nothing is.
 *
 * Create is NOT disabled any more. A greyed-out button with no explanation
 * leaves the user to guess which of several controls it is waiting on, which
 * they cannot do — so the button always submits and this decides whether
 * anything happens, naming the control to point at when it does not.
 *
 * Only two things can be wrong, and neither mode button is one of them:
 * choosing nothing is a valid empty curated space, which is the common case.
 */
export function validateForm(s: CreateFormState): FormFault | null {
  const trimmed = s.name.trim();
  if (trimmed === "") {
    return { field: "name", message: "give the space a name." };
  }
  if (trimmed.length > MAX_SPACE_NAME_LENGTH) {
    // `validateSpace` (schema.ts) rejects a longer name outright, so without
    // this the panel would submit, fail, and show a Notice with the form
    // otherwise unchanged: an opaque, repeating dead end for a pasted name.
    return { field: "name", message: `keep the name under ${MAX_SPACE_NAME_LENGTH} characters.` };
  }
  // Reported after the name deliberately: the name has to be fixed either way,
  // and it sits above the picker, so faulting the lower control first would
  // read as arbitrary.
  if (s.folderMode && !isFolderForm(s)) {
    // Honours the click. They asked for a folder space, so ask for the folder
    // rather than quietly creating a curated one they cannot convert: the
    // kind is fixed at creation.
    //
    // Both ways out, named. Stating the requirement alone, without admitting
    // there is an alternative, reads as a demand when the user's actual intent
    // may have been to stop making a folder space at all — and that exit is a
    // click on a button they have to be told is still on.
    return {
      field: "root",
      message: "select a folder to pin, or deselect 'Folder pinned'.",
    };
  }
  return null;
}

/**
 * Whether Create would do anything.
 *
 * Derived from `validateForm` rather than re-deriving the rule, so the button
 * and the submit can never disagree about what is acceptable.
 *
 * No longer called by the panel — Create always submits and `validateForm`
 * decides, because a disabled button explains nothing. Kept as the boolean
 * spelling of the same rule, with a test pinning the two together, so a
 * future caller that wants "is this form acceptable?" does not re-derive it.
 */
export function canCreate(s: CreateFormState): boolean {
  return validateForm(s) === null;
}

/**
 * Whether two member entries name the same thing. A tag member has no path,
 * so the two kinds are only ever identical to their own kind; this picker
 * builds only file and folder chips, not tag chips.
 */
function sameEntry(a: MemberEntry, b: MemberEntry): boolean {
  if (a.kind === "tag" || b.kind === "tag") {
    return a.kind === "tag" && b.kind === "tag" && a.tag === b.tag;
  }
  return a.path === b.path;
}

export function toggleItem(s: CreateFormState, entry: MemberEntry): CreateFormState {
  const without = s.items.filter((i) => !sameEntry(i, entry));
  if (without.length !== s.items.length) return { ...s, items: without };
  return { ...s, items: [...s.items, entry] };
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * Folders offered for the chip field.
 *
 * An empty query lists top-level folders only, so focusing the field is
 * browsable before you know any names — that is what keeps the single-row
 * picker usable for someone who has never seen the vault's layout.
 * A query matches the FULL path, so `Projects/Console 2030`
 * is one line rather than three clicks.
 */
export function folderCandidates(
  src: VaultSource,
  query: string,
  limit = 20
): string[] {
  const q = query.trim().toLowerCase();
  // The vault root is a folder and `allPaths` now returns it, but it is not a
  // candidate: a space rooted there is *All* under another name, and
  // `setSpaceRoot` normalises `"/"` straight back to the missing-root state. It
  // used to be unreachable here because the source listed folders below the
  // root only; that stopped being true when the source widened to the whole
  // vault, and only the empty-query branch happened to still exclude it.
  const folders = src
    .allPaths()
    .filter((p) => src.kindOf(p) === "folder" && p !== "/" && p !== "");

  if (q === "") {
    return folders
      .filter((p) => !p.includes("/"))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit);
  }

  const matches = folders.filter((p) => p.toLowerCase().includes(q));
  // A basename prefix is what the user most likely meant; then shorter paths,
  // which are the shallower and more general folders; then alphabetical so the
  // order is stable rather than incidental.
  matches.sort((a, b) => {
    const ap = basename(a).toLowerCase().startsWith(q) ? 0 : 1;
    const bp = basename(b).toLowerCase().startsWith(q) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
  return matches.slice(0, limit);
}

/**
 * Branches on the MODE and on `isFolderForm`, never on whether a side
 * happens to be non-empty. The form remembers both sides at once by design, so
 * "has a root" and "has items" can both be true — this is the one function
 * whose OUTPUT
 * `createSpace` actually persists, and `SpaceController.membersForSnapshot`
 * shows a folder space's root and nothing else, silently, if both ever
 * ended up set. Deciding by the mode here means a form holding both still
 * submits cleanly as whichever kind was asked for — never as a folder space
 * carrying an invisible, un-rendered member list.
 */
export function toCreateOptions(s: CreateFormState): CreateSpaceOptions {
  // The sentinel never leaves this module: an untouched icon becomes the
  // default here, so the stored shape is unchanged from before the placeholder
  // existed. An icon is a nicety, so `validateForm` deliberately does not gate
  // on one — resolving it silently is the whole point.
  const base = { icon: s.icon === "" ? PRESET_ICONS[0] : s.icon, color: s.color };
  // MODE first, then usability. The form remembers both sides, so a set root
  // means nothing on its own — only the mode says which kind is being made.
  // `isFolderForm` still has the last word so a mode with an unusable root
  // (`""` or `"/"`) falls back rather than submitting one.
  if (s.folderMode && isFolderForm(s)) {
    return { ...base, root: s.root, members: [] };
  }
  return { ...base, members: [...s.items] };
}
