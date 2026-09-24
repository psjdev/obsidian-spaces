import { Notice, type App } from "obsidian";
import { AnchoredPopover } from "./AnchoredPopover";
import { FolderSuggest } from "./FolderSuggest";
import type { VaultSource } from "./createSpaceForm";

/**
 * The "Change folder…" affordance a folder space's
 * missing-root state offers (`main.ts`'s `openMissingRootPicker`, its one
 * caller). No settings-row equivalent exists; Settings shows the row's
 * summary only (`spaceRowSummary`) and is not drivable under Vitest to add
 * one. A separate, tiny widget rather than reopening `CreateSpacePanel` —
 * that panel builds a whole new space (name, icon, color, starting
 * members); this only ever changes one existing space's `root`, which is
 * `setSpaceRoot`'s job (`spaceLifecycle.ts`), not `createSpace`'s.
 *
 * Modelled directly on `RenamePopover.ts`: positioning, dismissal and DOM
 * lifecycle all come from `AnchoredPopover`, so this behaves exactly like
 * every other picker in this codebase and adds nothing of its own to get
 * wrong there.
 */
interface FolderPickerPopoverDeps {
  anchor: HTMLElement;
  app: App;
  folders: VaultSource;
  /** The space's current root, or `""` when it has none usable to show. */
  current: string;
  /**
   * Writes the new root through the validated path `setSpaceRoot` provides —
   * never a second, differently-normalized write. Called with `""` for the
   * "Clear" action: storing an empty root, rather than removing the field,
   * keeps the space a folder space in the pre-choice state rather than
   * silently reclassifying it as an empty curated one.
   * Rejects on a failed write: the popover still closes, but the
   * caller is told why the field did not change.
   */
  apply(path: string): Promise<void>;
}

/** Returns the popover so its opener can close it (see `AnchoredPopover`'s own docstring: it does not own its lifetime). */
export function openFolderPickerPopover(deps: FolderPickerPopoverDeps): AnchoredPopover {
  // The ONE `FolderSuggest` this popover ever constructs, kept here — not
  // only inside `build()` — so `suppressEscape` and `onClose` below
  // (options on the SAME `AnchoredPopover`, not `build()`'s own concern)
  // can both reach it. Without retaining the instance here, `pop.close()`
  // and unload would tear down the input while the suggester's own
  // body-level popover and its listeners are never told — the failure
  // shape of a free function that opens something with document-level
  // listeners and returns `void`.
  let suggest: FolderSuggest | null = null;

  const popover = new AnchoredPopover({
    anchor: deps.anchor,
    className: "spaces-folder-picker-popover",
    ariaLabel: "Choose a folder",
    // Escape while the suggester's OWN dropdown is open must close ONLY the
    // dropdown (Obsidian's `app.keymap` `Scope` system) — the same hazard
    // and the same guard `CreateSpacePanel.ts:187` uses, and for the same
    // reason: `isPopoverOpen`, not `defaultPrevented`, because there is no
    // guarantee the keymap's own handling runs first or marks the event.
    suppressEscape: () => suggest?.isPopoverOpen ?? false,
    // The suggester's own document-level listeners come off the moment this
    // popover closes, for ANY reason — not only the ones this file itself
    // calls `pop.close()` for.
    onClose: () => {
      suggest?.close();
      suggest = null;
    },
    build: (root, pop) => {
      const doc = root.ownerDocument;

      const commit = (path: string): void => {
        void deps.apply(path).catch((e: unknown) => {
          new Notice(`Spaces: could not change the folder (${String(e)})`);
        });
        pop.close();
      };

      const input = doc.win.createEl("input");
      input.type = "text";
      input.className = "spaces-folder-picker-input";
      input.setAttribute("aria-label", "Folder path");
      input.placeholder = "Choose a folder…";
      input.value = deps.current;

      // Same shape as `CreateSpacePanel.ts`'s root row: a working
      // suggester commits through `selectSuggestion` (below); a suggester
      // that failed to construct, or whose `getSuggestions` threw, degrades
      // to the plain input, and Enter on IT re-checks `kindOf(...) ===
      // "folder"` before accepting — typed text did not come FROM
      // `folderCandidates`, so it is not yet known to name a real folder.
      let suggestBroken = false;
      const onSuggestError = (e: unknown): void => {
        suggestBroken = true;
        console.error("Spaces: folder suggester failed, degrading to plain input", e);
      };
      try {
        suggest = new FolderSuggest(deps.app, input, deps.folders, commit, onSuggestError);
      } catch (e) {
        onSuggestError(e);
      }

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!suggestBroken) return; // a real pick already went through selectSuggestion
          const p = input.value.trim();
          if (deps.folders.kindOf(p) !== "folder") return;
          commit(p);
        } else if (e.key === "Escape") {
          if (suggest?.isPopoverOpen) return; // let the suggester close its own dropdown first
          // Stopped as well as prevented: the popover's own Escape handler is
          // on the document in capture, and letting this reach Obsidian would
          // close the sidebar behind the popover too (mirrors RenamePopover).
          e.preventDefault();
          e.stopPropagation();
          pop.close();
        }
      });

      const clear = doc.win.createEl("button");
      clear.textContent = "Clear";
      clear.setAttribute(
        "aria-label",
        "Clear the folder — the space stays folder pinned, with no folder chosen"
      );
      clear.addEventListener("click", () => commit(""));

      root.appendChild(input);
      root.appendChild(clear);

      input.focus();
      input.select();
    },
  });

  popover.open();
  return popover;
}
