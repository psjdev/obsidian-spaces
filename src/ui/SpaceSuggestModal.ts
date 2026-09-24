import { SuggestModal, prepareFuzzySearch, renderResults, type App, type SearchResult } from "obsidian";
import { appendSpaceIcon } from "./spaceRow";
import { spaceSuggestions, type SpaceSuggestion } from "./spaceSuggest";
import type { SpaceEntry } from "./spaceEntries";
import type { ActiveSelection } from "../types";

/**
 * Type a space's name to switch to it.
 *
 * A third route to the same destination as the strip and the header's
 * popover, and the only one that scales: a strip is a row of glyphs you scan,
 * a popover is a list you scroll, and neither is pleasant once a vault has
 * more spaces than fit on screen.
 *
 * `SuggestModal` rather than `FuzzySuggestModal`, deliberately. The fuzzy
 * subclass filters the whole item list for you, which is precisely the
 * behaviour being replaced -- an empty query here shows a short list, not
 * everything -- and overriding its filtering costs more than not inheriting
 * it. Everything used here is public API, so none of this belongs in the
 * private-API quarantine.
 *
 * Decides nothing about WHICH spaces: the entries come from `spaceEntries.ts`,
 * the same list the strip and the popover render, and the order comes from
 * `spaceSuggest.ts`. This file measures nothing and ranks nothing; it draws.
 */
interface SpaceSuggestDeps {
  app: App;
  /** Read at open time, so the list reflects a space created since the last one. */
  entries: () => readonly SpaceEntry[];
  /**
   * The Appearance toggle. A function like `entries` above, for the same
   * reason: the modal is registered once and read at open time.
   */
  useThemeIconColor: () => boolean;
  /** Rejects if the switch fails; the modal is already closed by then. */
  switchTo(key: ActiveSelection): Promise<void>;
}

export class SpaceSuggestModal extends SuggestModal<SpaceSuggestion<SearchResult>> {
  constructor(private deps: SpaceSuggestDeps) {
    super(deps.app);
    this.setPlaceholder("Find a space");
  }

  getSuggestions(query: string): SpaceSuggestion<SearchResult>[] {
    return spaceSuggestions(this.deps.entries(), query, prepareFuzzySearch(query));
  }

  renderSuggestion(suggestion: SpaceSuggestion<SearchResult>, el: HTMLElement): void {
    el.classList.add("spaces-spaces-row");
    const { entry, match } = suggestion;
    // The same classes the header's popover uses, so the two lists look alike
    // without a second set of rules to keep in step.
    if (entry.active) el.classList.add("is-active");
    el.setAttribute("aria-current", String(entry.active));

    appendSpaceIcon(el, entry, this.deps.useThemeIconColor());

    const name = el.ownerDocument.win.createDiv();
    name.className = "spaces-spaces-row-name";
    // `renderResults` writes the text AND marks the matched characters. With
    // no match -- the empty query's short list -- there is nothing to mark, so
    // the name is written plainly rather than handed a fabricated result.
    if (match) renderResults(name, entry.label, match);
    else name.textContent = entry.label;
    el.appendChild(name);
  }

  onChooseSuggestion(suggestion: SpaceSuggestion<SearchResult>): void {
    // `SuggestModal` has already closed by the time this runs, which is the
    // ordering the header's popover arrived at independently: nothing can
    // choose a second row while a switch is in flight.
    void this.deps.switchTo(suggestion.entry.key).catch((e: unknown) => {
      console.error("Spaces: switching space failed", e);
    });
  }
}
