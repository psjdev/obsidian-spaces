import { describe, expect, it } from "vitest";
import {
  PRESET_ICONS,
  canCreate,
  collapseMode,
  modeHoldsChoice,
  MAX_SPACE_NAME_LENGTH,
  emptyForm,
  folderCandidates,
  isFolderForm,
  setFolderMode,
  setRoot,
  toggleItem,
  validateForm,
  toCreateOptions,
  type VaultSource,
} from "../src/ui/createSpaceForm";


function src(paths: Record<string, "file" | "folder">): VaultSource {
  return {
    allPaths: () => Object.keys(paths),
    kindOf: (p) => paths[p] ?? null,
  };
}

const VAULT = src({
  Papers: "folder",
  "Papers/Drafts": "folder",
  "Papers/Attention.md": "file",
  Projects: "folder",
  "Projects/Console 2030": "folder",
  "Projects/Console 2030/SBC": "folder",
  "Recipes.md": "file",
});

// Fixture with deliberately unordered insertion to test sorting logic.
// Insertion order is reverse-alphabetical (Z, M, A) so any empty query
// or alphabetically-dependent ranking would fail without the sort.
const UNORDERED_VAULT = src({
  "Zebra": "folder",
  "Mango": "folder",
  "Apples": "folder",
  "Recipes.md": "file",
});

describe("canCreate", () => {
  it("is false for an empty name", () => {
    expect(canCreate(emptyForm("#5b5bff"))).toBe(false);
  });

  it("is false for whitespace only — the reference shows Create dimmed", () => {
    expect(canCreate({ ...emptyForm("#5b5bff"), name: "   " })).toBe(false);
  });

  it("is true once there is a real name", () => {
    expect(canCreate({ ...emptyForm("#5b5bff"), name: "Research" })).toBe(true);
  });
});

describe("folderCandidates", () => {
  it("lists only top-level folders when the query is empty, so the field is browsable on focus", () => {
    expect(folderCandidates(VAULT, "")).toEqual(["Papers", "Projects"]);
  });

  it("lists top-level folders in alphabetical order even when insertion order differs", () => {
    // Critical test: the empty-query sort must work. UNORDERED_VAULT has
    // top-level folders in reverse-alphabetical insertion order (Zebra, Mango, Apples).
    // The result must be alphabetical (Apples, Mango, Zebra) regardless.
    expect(folderCandidates(UNORDERED_VAULT, "")).toEqual([
      "Apples",
      "Mango",
      "Zebra",
    ]);
  });

  it("never offers a file", () => {
    expect(folderCandidates(VAULT, "Recipes")).toEqual([]);
    expect(folderCandidates(VAULT, "Attention")).toEqual([]);
  });

  it("matches nested folders on the full path, so you can type one line instead of drilling", () => {
    expect(folderCandidates(VAULT, "Console")).toEqual([
      "Projects/Console 2030",
      "Projects/Console 2030/SBC",
    ]);
  });

  it("is case-insensitive", () => {
    expect(folderCandidates(VAULT, "papers")).toContain("Papers");
  });

  it("matches by substring without other candidates", () => {
    // This test pins substring matching. "Drafts" matches Papers/Drafts by
    // substring; nothing else matches, so there is no competing candidate to rank.
    // This is what the original test actually measured — not ranking, but substring.
    expect(folderCandidates(VAULT, "Drafts")).toEqual(["Papers/Drafts"]);
  });

  it("ranks basename prefix above a mid-path match", () => {
    // Critical: test ranking with actual competing candidates.
    // Use a fixture with both basename-prefix and mid-path matches.
    const withRanking = src({
      "Mid/Archive": "folder",
      "Archive": "folder",
      "Archive/Nested": "folder",
    });
    // Query "Archive" matches:
    //   - "Archive" by basename-prefix
    //   - "Archive/Nested" by mid-path (basename is "Nested")
    //   - "Mid/Archive" by mid-path
    // Basename-prefix match ("Archive") must come first.
    const result = folderCandidates(withRanking, "Archive");
    expect(result[0]).toBe("Archive");
  });

  it("ranks shorter path above longer path when both match by basename prefix", () => {
    // Critical: test the path-length tie-breaker.
    // Two folders with the same basename prefix but different path lengths.
    // Query "Store" matches:
    //   - "Store" by basename-prefix (length 5)
    //   - "Archive/Store" by basename-prefix (length 13)
    // The shorter one must come first.
    const withShortAndLong = src({
      "Store": "folder",
      "Archive/Store": "folder",
    });
    expect(folderCandidates(withShortAndLong, "Store")).toEqual([
      "Store",
      "Archive/Store",
    ]);
  });

  it("uses alphabetical order to break a full tie", () => {
    // Critical: test the alphabetical tie-breaker.
    // Query "Folder" matches:
    //   - "Folder_A" (length 8, basename-prefix, comes second alphabetically)
    //   - "Folder_Z" (length 8, basename-prefix, comes first alphabetically)
    // The alphabetical tie-breaker must put "Folder_A" first.
    const withTiedFolders = src({
      "Folder_Z": "folder",
      "Folder_A": "folder",
    });
    expect(folderCandidates(withTiedFolders, "Folder")).toEqual([
      "Folder_A",
      "Folder_Z",
    ]);
  });

  it("applies limit after sorting in the empty-query branch", () => {
    // Critical: sorting must happen before slicing in empty-query branch (createSpaceForm.ts:81).
    // UNORDERED_VAULT insertion order for top-level: Zebra, Mango, Apples (reverse-alpha).
    // Alphabetical order should be: Apples, Mango, Zebra.
    // With limit=2, we want the first two alphabetically (Apples, Mango),
    // not the first two inserted (Zebra, Mango).
    expect(folderCandidates(UNORDERED_VAULT, "", 2)).toEqual(["Apples", "Mango"]);
  });

  it("applies limit after sorting in the query branch", () => {
    // Critical: sorting must happen before slicing in query branch (createSpaceForm.ts:95).
    // Query "a" matches all three folders in UNORDERED_VAULT:
    //   - "Apples" (basename-prefix match)
    //   - "Mango" (substring match, tied with Zebra on prefix and length)
    //   - "Zebra" (substring match)
    // Ranking: Apples wins prefix criterion (0); Mango and Zebra tie (1).
    // Tie-break: alphabetically Mango < Zebra.
    // With limit=2:
    //   - Sort first: ["Apples", "Mango", "Zebra"] → slice → ["Apples", "Mango"] ✓
    //   - Slice first: ["Zebra", "Mango"] (insertion order) → sort → ["Mango", "Zebra"] ✗
    // This test catches if slice is moved before sort in the query branch.
    expect(folderCandidates(UNORDERED_VAULT, "a", 2)).toEqual(["Apples", "Mango"]);
  });

  it("honours the limit", () => {
    expect(folderCandidates(VAULT, "", 1)).toEqual(["Papers"]);
  });
});

describe("toCreateOptions", () => {
  it("maps the form onto createSpace's options, items as members, each carrying its kind", () => {
    let s = { ...emptyForm("#4ecdc4"), name: "Research", icon: "microscope" };
    s = toggleItem(s, { path: "Papers", kind: "folder" });
    s = toggleItem(s, { path: "Projects/Console 2030", kind: "folder" });
    expect(toCreateOptions(s)).toEqual({
      icon: "microscope",
      color: "#4ecdc4",
      members: [
        { path: "Papers", kind: "folder" },
        { path: "Projects/Console 2030", kind: "folder" },
      ],
    });
  });
});

describe("folder-space form state", () => {
  it("starts with no root", () => {
    expect(emptyForm("#4ecdc4").root).toBe("");
    expect(isFolderForm(emptyForm("#4ecdc4"))).toBe(false);
  });

  it("becomes a folder form once a root is set", () => {
    const s = setRoot(emptyForm("#4ecdc4"), "Projects/Work");
    expect(isFolderForm(s)).toBe(true);
  });

  it("keeps chosen items when a root is set", () => {
    // Both sides are remembered so switching between Curate and Folder space
    // is free. Nothing ambiguous reaches storage: `toCreateOptions` submits
    // whichever side the mode names and ignores the other.
    const s = setRoot(
      toggleItem(emptyForm("#4ecdc4"), { path: "Papers", kind: "folder" }),
      "Projects/Work"
    );
    expect(s.items).toEqual([{ path: "Papers", kind: "folder" }]);
    expect(s.root).toBe("Projects/Work");
  });

  it("refuses the vault root", () => {
    for (const root of ["", "/"]) {
      expect(isFolderForm(setRoot(emptyForm("#4ecdc4"), root)), root).toBe(false);
    }
  });

  it("can still be created with only a name and a root", () => {
    expect(canCreate(setRoot({ ...emptyForm("#4ecdc4"), name: "Work" }, "Projects/Work"))).toBe(true);
  });

  // The form remembers BOTH sides on purpose, so this shape is reachable in
  // normal use: pick two items under Curate, switch to Pin to Folder, choose a
  // root. `SpaceController.membersForSnapshot` shows only a root's contents
  // when one is set, so submitting both would store a member list that never
  // renders and would resurface unexplained the moment the root broke.
  //
  // Asserted with `folderMode: true`, which is what makes this the folder
  // branch. An earlier version of this test set a phantom `folders` field and
  // left `folderMode` false — it took the curated branch and passed because
  // nothing had been picked, i.e. for a reason unrelated to its own name.
  it("submits the root alone when the form holds a root AND items", () => {
    const s = setRoot(
      setFolderMode(toggleItem({ ...emptyForm("#4ecdc4"), name: "Work" }, { path: "Papers", kind: "folder" }), true),
      "Projects/Work"
    );
    expect(s.items).toHaveLength(1);
    const opts = toCreateOptions(s);
    expect(opts.root).toBe("Projects/Work");
    expect(opts.members).toEqual([]);
  });
});

describe("PRESET_ICONS", () => {
  it("offers a usable set and starts with the current default", () => {
    // Presets exist precisely so an icon choice can never be unavailable.
    expect(PRESET_ICONS[0]).toBe("box");
    expect(PRESET_ICONS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(PRESET_ICONS).size).toBe(PRESET_ICONS.length);
  });
});

describe("the unchosen icon (create-panel placeholder)", () => {
  // The panel shows a dashed placeholder until the user picks, so the form
  // has to be able to say "none yet". `SpaceDefinition.icon` is a required
  // string (schema.ts:139) and stays that way: the sentinel lives only in
  // form state, and `toCreateOptions` resolves it at submit. That keeps the
  // shipped data model untouched — every space still has an icon.
  it("starts with no icon chosen", () => {
    expect(emptyForm("#4ecdc4").icon).toBe("");
  });

  it("does not require an icon to create", () => {
    // An icon is a nicety. Gating Create on it would add a mandatory step to
    // every space creation for no correctness gain.
    const s = { ...emptyForm("#4ecdc4"), name: "Research" };
    expect(s.icon).toBe("");
    expect(canCreate(s)).toBe(true);
  });

  it("submits the default icon when none was chosen", () => {
    const s = { ...emptyForm("#4ecdc4"), name: "Research" };
    expect(toCreateOptions(s).icon).toBe(PRESET_ICONS[0]);
  });

  it("submits the chosen icon when one was picked", () => {
    const s = { ...emptyForm("#4ecdc4"), name: "Research", icon: "microscope" };
    expect(toCreateOptions(s).icon).toBe("microscope");
  });

  it("submits a deliberately chosen default the same as any other pick", () => {
    // Distinguishing "never touched it" from "chose box on purpose" is the
    // whole reason the sentinel is "" rather than PRESET_ICONS[0]: comparing
    // against the default would silently reclassify a real choice.
    const s = { ...emptyForm("#4ecdc4"), name: "Research", icon: PRESET_ICONS[0] };
    expect(toCreateOptions(s).icon).toBe(PRESET_ICONS[0]);
  });

  it("resolves the default for a folder-space form too", () => {
    const s = setRoot({ ...emptyForm("#4ecdc4"), name: "Work" }, "Projects/Work");
    expect(toCreateOptions(s).icon).toBe(PRESET_ICONS[0]);
  });
});

describe("the folder-space checkbox", () => {
  // The kind of space is a one-way door: no conversion either way,
  // so the panel makes it a visible choice instead of inferring it from
  // whether a field happens to have a value in it.
  it("starts unticked — a plain space is the default", () => {
    expect(emptyForm("#4ecdc4").folderMode).toBe(false);
  });

  it("switching to folder mode keeps the items for coming back to", () => {
    const picked = toggleItem(
      toggleItem(emptyForm("#4ecdc4"), { path: "Papers", kind: "folder" }),
      { path: "Recipes", kind: "folder" }
    );
    const on = setFolderMode(picked, true);
    expect(on.folderMode).toBe(true);
    expect(on.items).toHaveLength(2);
  });

  it("switching to curate keeps the root for coming back to", () => {
    const rooted = setRoot(setFolderMode(emptyForm("#4ecdc4"), true), "Projects/Work");
    const off = setFolderMode(rooted, false);
    expect(off.folderMode).toBe(false);
    expect(off.root).toBe("Projects/Work");
  });

  it("is idempotent — re-ticking does not clear what you just chose", () => {
    // The panel calls this on every toggle, and a spurious re-render must not
    // eat a root the user has already picked.
    const rooted = setRoot(setFolderMode(emptyForm("#4ecdc4"), true), "Projects/Work");
    expect(setFolderMode(rooted, true)).toEqual(rooted);
  });

  it("blocks Create while ticked with no folder chosen", () => {
    // Ticking is a statement of intent. Submitting anyway would quietly make a
    // plain space and ignore it — worse than a disabled button.
    const s = { ...emptyForm("#4ecdc4"), name: "Work", folderMode: true };
    expect(canCreate(s)).toBe(false);
  });

  it("allows Create once a folder is chosen", () => {
    const s = setRoot({ ...emptyForm("#4ecdc4"), name: "Work", folderMode: true }, "Projects/Work");
    expect(canCreate(s)).toBe(true);
  });

  it("still blocks Create on the vault root, which is not a usable root", () => {
    const s = setRoot({ ...emptyForm("#4ecdc4"), name: "Work", folderMode: true }, "/");
    expect(canCreate(s)).toBe(false);
  });

  it("does not gate a plain space on anything but its name", () => {
    expect(canCreate({ ...emptyForm("#4ecdc4"), name: "Reading" })).toBe(true);
  });

  it("submits a folder space when ticked and rooted", () => {
    const s = setRoot({ ...emptyForm("#4ecdc4"), name: "Work", folderMode: true }, "Projects/Work");
    expect(toCreateOptions(s)).toMatchObject({ root: "Projects/Work", members: [] });
  });

  it("submits a plain space when unticked, whatever was typed before", () => {
    const s = toggleItem(
      setFolderMode(setRoot({ ...emptyForm("#4ecdc4"), name: "Reading", folderMode: true }, "Projects/Work"), false),
      { path: "Papers", kind: "folder" }
    );
    const out = toCreateOptions(s);
    expect(out).not.toHaveProperty("root");
    expect(out.members).toEqual([{ path: "Papers", kind: "folder" }]);
  });
});

describe("arriving with a root already chosen", () => {
  // The right-click entry ("Create space from this folder") opens the panel
  // pre-filled. Before the checkbox existed, a set root WAS the
  // folder mode; now the two are separate, and a root arriving without its
  // tick would show an unticked panel with an invisible selection.
  it("turns on folder mode", () => {
    const s = setFolderMode(setRoot(emptyForm("#4ecdc4"), "Projects/Hardware"), true);
    expect(s.folderMode).toBe(true);
    expect(s.root).toBe("Projects/Hardware");
  });

  it("keeps the root when folder mode is asserted, not clears it", () => {
    // `setFolderMode(s, true)` clears `folders`, never `root` — the regression
    // this guards is the two calls being ordered the other way round.
    const s = setFolderMode(setRoot(emptyForm("#4ecdc4"), "Archive"), true);
    expect(s.root).toBe("Archive");
  });
});

describe("picking items for a curated space", () => {
  const empty = () => emptyForm("#4ecdc4");
  const note = { path: "Archive/Bravo.md", kind: "file" as const };
  const dir = { path: "Papers", kind: "folder" as const };

  // The picker takes files as well as folders. That is not new capability —
  // `MemberEntry.kind` has always been "file" | "folder" and right-click
  // "Add to space" has been making file members all along. It was only the
  // create panel that could not.
  it("starts with nothing picked", () => {
    expect(empty().items).toEqual([]);
  });

  it("adds a file", () => {
    expect(toggleItem(empty(), note).items).toEqual([note]);
  });

  it("adds a folder", () => {
    expect(toggleItem(empty(), dir).items).toEqual([dir]);
  });

  it("keeps the order things were picked in", () => {
    const s = toggleItem(toggleItem(empty(), note), dir);
    expect(s.items.flatMap((i) => (i.kind === "tag" ? [] : [i.path]))).toEqual([
      "Archive/Bravo.md",
      "Papers",
    ]);
  });

  it("removes on a second click of the same path", () => {
    const s = toggleItem(toggleItem(empty(), note), note);
    expect(s.items).toEqual([]);
  });

  it("matches on path alone when removing", () => {
    // Kind cannot disagree for one path in a real vault, but a toggle that
    // silently added a duplicate because the kind differed would be a bug the
    // user could see and not explain.
    const s = toggleItem(toggleItem(empty(), note), { path: note.path, kind: "folder" });
    expect(s.items).toEqual([]);
  });

  it("submits what was picked, with each kind carried through", () => {
    const s = toggleItem(toggleItem({ ...empty(), name: "Reading" }, note), dir);
    expect(toCreateOptions(s).members).toEqual([note, dir]);
  });

  it("still allows a space with nothing picked — you can add later", () => {
    expect(canCreate({ ...empty(), name: "Later" })).toBe(true);
    expect(toCreateOptions({ ...empty(), name: "Later" }).members).toEqual([]);
  });

  it("survives a trip through folder mode and back", () => {
    const there = setFolderMode(toggleItem(empty(), note), true);
    const back = setFolderMode(there, false);
    expect(back.items).toEqual([note]);
  });
});

describe("what gets submitted when both sides are set", () => {
  // The form remembers a root AND items so switching between Curate and
  // Folder space costs nothing. That makes `toCreateOptions` the only thing
  // standing between a remembered value and the wrong kind of space, so it
  // keys on the MODE, never on whether a root happens to be set.
  const both = (mode: boolean) =>
    setFolderMode(
      setRoot(
        toggleItem({ ...emptyForm("#4ecdc4"), name: "Both" }, { path: "Papers", kind: "folder" }),
        "Projects/Work"
      ),
      mode
    );

  it("submits the items, ignoring a remembered root, when curating", () => {
    const out = toCreateOptions(both(false));
    expect(out).not.toHaveProperty("root");
    expect(out.members).toEqual([{ path: "Papers", kind: "folder" }]);
  });

  it("submits the root, ignoring remembered items, in folder mode", () => {
    const out = toCreateOptions(both(true));
    expect(out).toMatchObject({ root: "Projects/Work", members: [] });
  });

  it("falls back to a curated space when folder mode has no usable root", () => {
    // `""` and `"/"` are the missing-root state. Mode alone must not
    // submit a root that `rootOf` would refuse.
    const s = setFolderMode({ ...emptyForm("#4ecdc4"), name: "Broken" }, true);
    const out = toCreateOptions(setRoot(s, "/"));
    expect(out).not.toHaveProperty("root");
  });
});

describe("validateForm", () => {
  // Create is no longer disabled — a disabled button with no explanation is
  // the thing this replaces. It always submits; validation decides whether
  // anything happens and, when it does not, which control to point at.
  const named = () => ({ ...emptyForm("#4ecdc4"), name: "Research" });

  it("passes a named curated form with nothing chosen", () => {
    // The common case and the whole point: neither mode clicked is a valid
    // empty curated space, not an error.
    expect(validateForm(named())).toBeNull();
  });

  it("faults the name when it is empty", () => {
    expect(validateForm(emptyForm("#4ecdc4"))?.field).toBe("name");
  });

  it("faults the name when it is only whitespace", () => {
    expect(validateForm({ ...emptyForm("#4ecdc4"), name: "   " })?.field).toBe("name");
  });

  it("faults the name when it is over the schema's limit", () => {
    const long = "x".repeat(MAX_SPACE_NAME_LENGTH + 1);
    expect(validateForm({ ...emptyForm("#4ecdc4"), name: long })?.field).toBe("name");
  });

  it("faults the root when Pin to Folder is on with no folder", () => {
    // Honours the click: they asked for a folder space, so ask for the folder
    // rather than quietly making a curated one they cannot convert.
    expect(validateForm(setFolderMode(named(), true))?.field).toBe("root");
  });

  it("faults the root when the chosen root is the vault root", () => {
    // `""` and `"/"` are the missing-root state, not a usable root.
    const s = setRoot(setFolderMode(named(), true), "/");
    expect(validateForm(s)?.field).toBe("root");
  });

  it("passes once a real folder is chosen", () => {
    const s = setRoot(setFolderMode(named(), true), "Projects/Work");
    expect(validateForm(s)).toBeNull();
  });

  it("reports the name first when both are wrong", () => {
    // The name is the field they must fix either way, and it is above the
    // picker — pointing at the lower one first would read as arbitrary.
    const s = setFolderMode(emptyForm("#4ecdc4"), true);
    expect(validateForm(s)?.field).toBe("name");
  });

  it("carries a message for the control to show", () => {
    expect(validateForm(emptyForm("#4ecdc4"))?.message).toBeTruthy();
  });

  it("agrees with canCreate", () => {
    // One rule, two shapes — `canCreate` must never say yes to something
    // `validateForm` faults, or the button and the submit disagree.
    const cases = [
      emptyForm("#4ecdc4"),
      named(),
      setFolderMode(named(), true),
      setRoot(setFolderMode(named(), true), "Projects/Work"),
    ];
    for (const s of cases) expect(canCreate(s)).toBe(validateForm(s) === null);
  });
});

describe("collapseMode", () => {
  /**
   * The bug this exists for: clicking Pin to Folder and then clicking it
   * again left `folderMode` on. The button stopped looking pressed, so the
   * user had visibly abandoned the mode — but the form still held it, so
   * `validateForm` went on demanding a folder and Create went on refusing.
   * The panel said one thing and the state held another.
   *
   * The rule that settles it: a mode survives being collapsed only if it
   * holds something. Nothing chosen means nothing to keep, and the form
   * falls back to curated — which, empty, is exactly the "neither clicked"
   * case that is allowed to create.
   */
  const named = () => ({ ...emptyForm("#4ecdc4"), name: "Research" });

  it("abandons folder mode when no folder was chosen", () => {
    const s = collapseMode(setFolderMode(named(), true), true);
    expect(s.folderMode).toBe(false);
    expect(validateForm(s)).toBeNull();
  });

  it("keeps folder mode when a folder was chosen", () => {
    // Collapsing is tidying the panel, not undoing the choice. Dropping the
    // mode here would silently turn their folder space into a curated one.
    const s = collapseMode(setRoot(setFolderMode(named(), true), "Projects/Work"), true);
    expect(s.folderMode).toBe(true);
    expect(toCreateOptions(s).root).toBe("Projects/Work");
  });

  it("treats an unusable root as nothing chosen", () => {
    // `"/"` is the missing-root state, so there is nothing to keep.
    const s = collapseMode(setRoot(setFolderMode(named(), true), "/"), true);
    expect(s.folderMode).toBe(false);
  });

  it("leaves a curated form alone whether or not it holds items", () => {
    // Curated with nothing IS the neutral state, so collapsing it is a no-op
    // in both directions.
    const bare = collapseMode(named(), false);
    expect(bare.folderMode).toBe(false);
    const withItem = collapseMode(toggleItem(named(), { path: "a.md", kind: "file" }), false);
    expect(withItem.items).toHaveLength(1);
  });

  it("does not discard the root it stops using", () => {
    // Re-opening the mode must bring the selection back — abandoning is a
    // consequence of the collapse, not a deletion. The assertion is on the
    // ROOT surviving; asserting `folderMode` here would be tautological,
    // since the last call in the chain is `setFolderMode(s, true)`.
    const chosen = setRoot(setFolderMode(named(), true), "Projects/Work");
    // Collapse a mode that holds nothing, so the abandon branch is the one
    // taken, while the root that was chosen stays in state.
    const abandoned = collapseMode({ ...chosen, root: "/" }, true);
    expect(abandoned.folderMode).toBe(false);
    expect(abandoned.root).toBe("/");
    // And the real case: a held root is untouched by a collapse.
    expect(collapseMode(chosen, true).root).toBe("Projects/Work");
    expect(setFolderMode(collapseMode(chosen, true), true).root).toBe("Projects/Work");
  });
});

describe("modeHoldsChoice", () => {
  const named = () => ({ ...emptyForm("#4ecdc4"), name: "Research" });

  it("is false for either mode on a fresh form", () => {
    expect(modeHoldsChoice(named(), true)).toBe(false);
    expect(modeHoldsChoice(named(), false)).toBe(false);
  });

  it("is true for folder mode once a usable root is set", () => {
    expect(modeHoldsChoice(setRoot(named(), "Projects"), true)).toBe(true);
  });

  it("is true for curated once an item is picked", () => {
    expect(modeHoldsChoice(toggleItem(named(), { path: "a.md", kind: "file" }), false)).toBe(true);
  });

  /**
   * Each side answers for itself. The form remembers both, so asking about
   * curated must not be answered by the root, or the collapsed Pin button
   * would light up because some file was ticked in the other mode.
   */
  it("answers for the mode asked about, not the one in effect", () => {
    const s = setRoot(toggleItem(named(), { path: "a.md", kind: "file" }), "Projects");
    expect(modeHoldsChoice(s, true)).toBe(true);
    expect(modeHoldsChoice(s, false)).toBe(true);
  });
});
