import { AbstractInputSuggest, type App } from "obsidian";
import { tagCandidates, type TagSource } from "./tagCandidates";

/**
 * Backs the add-a-tag field's autocomplete. All matching logic is
 * `tagCandidates` (tagCandidates.ts) — this class only adapts Obsidian's
 * popover to that pure function and reports a pick outward, the same division
 * `FolderSuggest` keeps with `folderCandidates`.
 *
 * The tag source arrives through the constructor rather than being read off
 * `app` here, for the same two reasons `FolderSuggest` takes a `VaultSource`:
 * the decision about what to offer stays testable in plain node, and the one
 * private Obsidian call behind it stays in its quarantine module
 * (`nativeTagCounts.ts`) instead of spreading into a class that must import
 * Obsidian types.
 *
 * `renderSuggestion`/`getSuggestions` are abstract on `AbstractInputSuggest`;
 * `selectSuggestion` is not, but is overridden here (rather than using the
 * `onSelect` callback) so a pick both notifies the caller AND clears the input
 * in one place.
 *
 * `onError` exists because a caller's try/catch around the constructor covers
 * only a construction-time throw. `getSuggestions` runs on every keystroke,
 * long after construction succeeded, and a throw there must not leave the
 * field silently dead — it reports outward so the caller can flip the field to
 * its plain-input fallback.
 *
 * Tags are stored without a leading `#` and shown with one, which is why
 * `renderSuggestion` adds it back and `onPick` does not.
 */
export class TagSuggest extends AbstractInputSuggest<string> {
  /**
   * Tracked exactly as `FolderSuggest` tracks it, and for the same class of
   * question: the caller's own Enter handler has to tell "the dropdown is
   * open, Obsidian's keymap is picking a suggestion" from "nothing is open,
   * commit what was typed". `PopoverSuggest` exposes no public getter for
   * this, only `open()`/`close()`, which are its documented, overridable
   * entry and exit points, so tracking a flag through them stays inside the
   * public surface.
   */
  private popoverOpen = false;

  constructor(
    app: App,
    textInputEl: HTMLInputElement,
    private readonly tags: TagSource,
    private readonly onPick: (tag: string) => void,
    private readonly onError: (e: unknown) => void
  ) {
    super(app, textInputEl);
  }

  get isPopoverOpen(): boolean {
    return this.popoverOpen;
  }

  override open(): void {
    this.popoverOpen = true;
    super.open();
  }

  override close(): void {
    this.popoverOpen = false;
    super.close();
  }

  protected override getSuggestions(query: string): string[] {
    try {
      return tagCandidates(this.tags, query);
    } catch (e) {
      this.onError(e);
      return [];
    }
  }

  override renderSuggestion(value: string, el: HTMLElement): void {
    el.setText("#" + value);
  }

  override selectSuggestion(value: string): void {
    this.onPick(value);
    this.setValue("");
    this.close();
  }
}
