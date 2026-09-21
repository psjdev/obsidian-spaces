/**
 * Runtime stand-in for the `obsidian` module under Vitest, wired in by the
 * `resolve.alias` in `vitest.config.ts`.
 *
 * ## Why this exists
 *
 * The installed `obsidian` npm package is **types-only** (`"main": ""`), so any
 * module that imports it throws at import time under Vitest. That is why
 * The "pure modules declare structural interfaces" convention exists,
 * and the convention stays: Layer 1 is still the default home for logic, and
 * this stub is not a licence to move it. What the alias buys is that the
 * modules which genuinely cannot avoid `"obsidian"` — `main.ts` above all —
 * stop being unreachable by *every* test, which is what let the plugin's
 * headline filtering feature be deleted with the suite green.
 *
 * `tsc` never sees this file in place of the real package: `tsconfig.json`
 * declares no `paths` mapping, so type checking still runs against the real
 * `obsidian.d.ts`. The alias is a Vitest-only, runtime-only substitution.
 *
 * ## The rule this file is written under
 *
 * A fake that models Obsidian *incorrectly* is worse than no fake — it makes
 * every test written against it worthless while looking green. So:
 *
 *  - behaviour that is **verified** (by `obsidian.d.ts`, or by a measurement
 *    this repo recorded in a source comment) is modelled, and the source of
 *    the verification is cited;
 *  - behaviour that would have to be **guessed** throws `notModelled()`.
 *
 * A test that needs an unmodelled behaviour therefore fails loudly, with a
 * message naming what is missing, instead of passing against an invention.
 * Widening the stub is fine — widening it by guessing is not.
 */

/** Thrown for any surface this stub deliberately declines to invent. */
function notModelled(what: string, why: string): never {
  throw new Error(
    `[obsidian-stub] ${what} is not modelled.\n` +
      `${why}\n` +
      `Model it here against a verified fact (obsidian.d.ts, or a measurement ` +
      `recorded in this repo), or take the test to Layer 4. Do not guess: an ` +
      `incorrect fake makes every test written against it worthless.`
  );
}

function requireDocument(what: string): Document {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error(
      `[obsidian-stub] ${what} needs a DOM. Run this test file under jsdom ` +
        `(add it to environmentMatchGlobs, or use the // @vitest-environment ` +
        `jsdom pragma).`
    );
  }
  return doc;
}

/* ------------------------------------------------------------------ *
 * Vault file tree
 *
 * `TAbstractFile`/`TFile`/`TFolder` are imported by `src/` only to be used as
 * `instanceof` discriminators (main.ts:341,742,1023; membership.ts:13;
 * creation.ts:13; ObsidianVaultIndex.ts:13). What matters is therefore the
 * class identity and the prototype chain, both of which are declared in
 * `obsidian.d.ts`. Fields are the documented ones, defaulted rather than
 * behavioural.
 * ------------------------------------------------------------------ */

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
  vault: unknown = null;
}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "";
  stat: { ctime: number; mtime: number; size: number } = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

/**
 * `main.ts:740` uses this as an `instanceof` discriminator on a leaf's view —
 * "is this leaf showing a file?". Only the class identity is needed.
 */
export class FileView {
  file: TFile | null = null;
}

/* ------------------------------------------------------------------ *
 * Notice
 * ------------------------------------------------------------------ */

/**
 * Every constructed `Notice`, in order, for tests that want to assert what the
 * plugin told the user. Reset it in `beforeEach` if you read it.
 */
export const noticeLog: Notice[] = [];

/**
 * Modelled from three verified facts:
 *
 *  - `obsidian.d.ts` declares `noticeEl`, `setMessage()` and `hide()` public;
 *  - `main.ts:323-328` records a measurement against Obsidian 1.13.7 —
 *    `noticeEl` is the INNER `.notice-message` element, not the toast, and a
 *    notice is still connected at opacity 1 seconds after `hide()` returns;
 *    (final review, mechanical: this citation had drifted to `:104-110`,
 *    which resolves to something else entirely — a citation that stops
 *    resolving is the start of the next lie this repo's own convention warns
 *    against)
 *  - `obsidian.d.ts`'s constructor signature — `message: string |
 *    DocumentFragment` — accepts a `DocumentFragment` for exactly the DOM
 *    reason any API does: to be consumed by `appendChild`, which the DOM spec
 *    (not an Obsidian-specific behaviour) defines as MOVING the fragment's
 *    children into the target. This is not a guess about Obsidian's
 *    internals; it is what `string | DocumentFragment` as a parameter type
 *    means in any DOM API (`main.ts`'s missing-root Notice embeds a real
 *    `<button>` this way).
 *
 * So `hide()` here does NOT detach the element: doing so would model the
 * opposite of what was measured, and `main.ts:1862` (the missing-root Notice)
 * and `:2677` (the blocked-drag Notice) both read `messageEl.isConnected`
 * precisely to tell a live toast from a dismissed one.
 * Obsidian's own timer-driven dismissal is not modelled — nothing in `src/`
 * depends on it, and inventing a schedule would put a sleep in the suite.
 */
export class Notice {
  readonly messageEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  hidden = false;

  constructor(
    public message: string | DocumentFragment,
    public duration?: number
  ) {
    const doc = requireDocument("new Notice()");
    this.toastEl = doc.createElement("div");
    this.toastEl.className = "notice";
    this.messageEl = doc.createElement("div");
    this.messageEl.className = "notice-message";
    if (typeof message === "string") {
      this.messageEl.textContent = message;
    } else {
      // `appendChild` on a DocumentFragment moves its children — `message`
      // itself is left empty after this, same as it would be after any real
      // `appendChild(fragment)` call. Callers that need to inspect what was
      // shown read `messageEl`, not `message`, afterwards.
      this.messageEl.appendChild(message);
    }
    this.toastEl.appendChild(this.messageEl);
    doc.body.appendChild(this.toastEl);
    noticeLog.push(this);
  }

  setMessage(message: string | DocumentFragment): this {
    this.message = message;
    if (typeof message === "string") {
      this.messageEl.textContent = message;
    } else {
      // Same DOM semantics as the constructor's DocumentFragment branch
      // (`appendChild` moves the fragment's children): clear whatever this
      // notice showed before, then move the new content in.
      this.messageEl.replaceChildren();
      this.messageEl.appendChild(message);
    }
    return this;
  }

  /** See the class docstring: dismissal is asynchronous in the real thing. */
  hide(): void {
    this.hidden = true;
  }

  /**
   * The deprecated spelling, and an alias rather than a second element:
   * Obsidian's own `noticeEl` and `messageEl` are the same node, and a
   * stub with two would let a test pass while reading the one the source
   * does not write. `src/` uses `messageEl` throughout; this stays for any
   * test still spelling it the old way.
   */
  get noticeEl(): HTMLElement {
    return this.messageEl;
  }

  /** Detach the toast — a test-only affordance, not part of Obsidian's API. */
  __destroy(): void {
    this.toastEl.remove();
  }
}

/* ------------------------------------------------------------------ *
 * Component / Plugin
 * ------------------------------------------------------------------ */

/**
 * `Plugin`'s constructor signature (`app`, `manifest`) and the two fields it
 * sets are declared in `obsidian.d.ts`; that is all `main.ts` needs to be
 * constructible.
 *
 * Everything else — the `Component` registration surface above all — throws.
 * `registerEvent`/`registerDomEvent`/`registerInterval` are the mechanism
 * The project requires every listener to go through, and a stub that pretended
 * to implement them would let a test claim teardown works when nothing was
 * ever torn down. Whether those listeners are really released is a Layer 4
 * question until someone models the real semantics here deliberately.
 */
export class Plugin {
  constructor(
    public app: unknown,
    public manifest: unknown
  ) {}

  load(): void {
    notModelled("Component.load()", "It drives onload() and the child lifecycle.");
  }
  unload(): void {
    notModelled("Component.unload()", "It drives onunload() and releases registrations.");
  }
  onload(): void | Promise<void> {
    notModelled("Plugin.onload()", "Call the plugin's own onload only under Layer 4.");
  }
  onunload(): void {
    notModelled("Plugin.onunload()", "See onload().");
  }
  register(_cb: () => unknown): void {
    notModelled("Component.register()", "Release semantics are not modelled.");
  }
  registerEvent(_ref: unknown): void {
    notModelled("Component.registerEvent()", "Release semantics are not modelled.");
  }
  registerDomEvent(..._args: unknown[]): void {
    notModelled("Component.registerDomEvent()", "Release semantics are not modelled.");
  }
  registerInterval(_id: number): number {
    return notModelled("Component.registerInterval()", "Release semantics are not modelled.");
  }
  addChild<T>(_child: T): T {
    return notModelled("Component.addChild()", "The child lifecycle is not modelled.");
  }
  removeChild<T>(_child: T): T {
    return notModelled("Component.removeChild()", "The child lifecycle is not modelled.");
  }
  addCommand(_cmd: unknown): unknown {
    return notModelled("Plugin.addCommand()", "Command registration is not modelled.");
  }
  addRibbonIcon(..._args: unknown[]): unknown {
    return notModelled("Plugin.addRibbonIcon()", "Ribbon DOM is not modelled.");
  }
  addSettingTab(_tab: unknown): void {
    notModelled("Plugin.addSettingTab()", "The settings modal is not modelled.");
  }
  registerView(..._args: unknown[]): void {
    notModelled("Plugin.registerView()", "View registration is not modelled.");
  }
  loadData(): Promise<unknown> {
    return notModelled("Plugin.loadData()", "Use DefinitionStore's injected port instead.");
  }
  saveData(_data: unknown): Promise<void> {
    return notModelled("Plugin.saveData()", "Use DefinitionStore's injected port instead.");
  }
}

/**
 * `obsidian.d.ts` declares the (`app`, `plugin`) constructor and a
 * `containerEl: HTMLElement`. The element is created here so a subclass can be
 * constructed, but it is DETACHED and carries none of the settings modal's own
 * markup or classes — do not assert layout or class structure against it.
 */
export class PluginSettingTab {
  containerEl: HTMLElement;

  constructor(
    public app: unknown,
    public plugin: unknown
  ) {
    this.containerEl = requireDocument("new PluginSettingTab()").createElement("div");
  }

  display(): void {
    notModelled("PluginSettingTab.display()", "Subclasses override it; the base does nothing useful here.");
  }
  hide(): void {
    notModelled("PluginSettingTab.hide()", "Modal teardown is not modelled.");
  }

  /**
   * The declarative tab's redraw. Loud rather than absent for the usual
   * reason: `SpacesSettingTab` calls this after a write, and a silently
   * missing method would let a test pass while the redraw it is supposed to
   * prove never happened.
   */
  update(): void {
    notModelled(
      "PluginSettingTab.update()",
      "Obsidian renders from getSettingDefinitions(); that rendering is not modelled here."
    );
  }
}

/**
 * Exists only so `class ConfirmModal extends Modal` can be *imported*.
 *
 * Added by the merge arbiter, not by either branch: W03 built this stub and
 * W08 added the first `extends Modal` in the codebase, so each was correct
 * alone and only their combination failed — `Class extends value undefined`
 * at `src/ui/ConfirmModal.ts:12`, which took `tests/filterAndOrderFolder.test.ts`
 * down with it because the import chain reaches it through `SettingsTab.ts`.
 *
 * `contentEl`/`modalEl` are real elements because `obsidian.d.ts` declares
 * them as `HTMLElement`, and `open`/`close` are inert because a modal's
 * presentation is a Layer 4 question. Anything that needs a modal to actually
 * behave like one must say so loudly rather than pass against a guess — which
 * is why `onOpen`/`onClose` are left to subclasses and nothing here pretends
 * to drive them. `ConfirmModal`'s own decision logic is covered at Layer 1 in
 * `tests/settingsEdits.test.ts`, which is where it belongs.
 */
export class Modal {
  contentEl: HTMLElement;
  modalEl: HTMLElement;

  constructor(public app: unknown) {
    const doc = requireDocument("new Modal()");
    this.modalEl = doc.createElement("div");
    this.contentEl = doc.createElement("div");
    this.modalEl.appendChild(this.contentEl);
  }

  open(): void {
    notModelled("Modal.open()", "Presenting a modal is a Layer 4 concern.");
  }

  close(): void {
    notModelled("Modal.close()", "Dismissing a modal is a Layer 4 concern.");
  }
}

/**
 * `SuggestModal<T>` as `obsidian.d.ts:6861` declares it: a `Modal` subclass
 * whose `getSuggestions`, `renderSuggestion` and `onChooseSuggestion` are
 * abstract and therefore supplied by the subclass under test.
 *
 * It exists here so `src/ui/SpaceSuggestModal.ts` can be DEFINED. Extending
 * a missing export is `class extends undefined`, which throws while the
 * module is still loading -- so without this every test file that reaches
 * `main.ts`, however indirectly, fails to collect. Nine of them did.
 *
 * `setPlaceholder` records its argument rather than rendering one, the same
 * bargain `setIcon` makes below: what `src/` ASKED for is a fact worth
 * keeping, what Obsidian draws in response is not this stub's to invent.
 */
export class SuggestModal<T> extends Modal {
  /** The exact string `src/` passed, for a test that cares to read it. */
  placeholder = "";
  /** Declared so the generic parameter is used, as the real class uses it. */
  protected readonly suggestions: T[] = [];

  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }
}

/**
 * `prepareFuzzySearch` (`obsidian.d.ts:5252`) and `renderResults`
 * (`obsidian.d.ts:5428`).
 *
 * Exported so the imports in `SpaceSuggestModal.ts` resolve, and deliberately
 * NOT implemented. Obsidian's fuzzy scoring and its match highlighting are
 * real algorithms whose output this stub cannot reproduce, and a plausible
 * imitation would make every ranking assertion written against it worthless.
 * `spaceSuggest.ts` takes its scorer as a parameter precisely so the ordering
 * rules can be tested without either of these.
 */
export function prepareFuzzySearch(_query: string): (text: string) => never {
  return () =>
    notModelled(
      "prepareFuzzySearch()",
      "Obsidian's fuzzy scoring cannot be reproduced here. Inject a scorer " +
        "into `spaceSuggestions` instead, which is why it takes one."
    );
}

export function renderResults(_el: HTMLElement, _text: string, _result: unknown): void {
  notModelled("renderResults()", "Match highlighting is a Layer 4 concern.");
}

/**
 * `Platform` as `obsidian.d.ts:4823` declares it, defaulted to **desktop**.
 *
 * `src/ui/SwitcherView.ts` imports it for touch gating and reads
 * `Platform.isMobile`, so without this the binding is
 * `undefined` and any test reaching that line throws on property access —
 * a trap for the next person to test that file, not a fault in it.
 *
 * Desktop is not a guess: the suite runs under node/jsdom, which is what the
 * desktop app's renderer most resembles, and every flag below is copied from
 * the declaration rather than invented. A test that wants the mobile branch
 * must say so by assigning to these fields, which makes the intent visible in
 * the test instead of hiding in the fake.
 */
export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: false,
};

/* ------------------------------------------------------------------ *
 * Surfaces this stub declines to invent
 * ------------------------------------------------------------------ */

/**
 * `Menu.prototype` must exist as an object with `addItem` and
 * `showAtMouseEvent` on it, because `main.ts:1291` hands the prototype to
 * `armSortMenuInjection` — that much is `obsidian.d.ts`. The
 * behaviour of a real menu is not modelled: `tests/nativeSortMenu.test.ts`
 * already exercises the patch against a purpose-built `MenuPrototype` fake,
 * which is the honest way to test that seam.
 */
export class Menu {
  addItem(_build: (item: unknown) => unknown): this {
    return notModelled("Menu.addItem()", "Menu DOM and item construction are not modelled.");
  }
  addSeparator(): this {
    return notModelled("Menu.addSeparator()", "Menu DOM is not modelled.");
  }
  showAtMouseEvent(_e: MouseEvent): this {
    return notModelled("Menu.showAtMouseEvent()", "Menu presentation is not modelled.");
  }
  showAtPosition(_p: unknown): this {
    return notModelled("Menu.showAtPosition()", "Menu presentation is not modelled.");
  }
  hide(): this {
    return notModelled("Menu.hide()", "Menu presentation is not modelled.");
  }
}

/**
 * Real `Setting` builds a `.setting-item` subtree and a dozen chainable
 * control builders. Reproducing that from memory is exactly the fake that
 * would make `SettingsTab` tests worthless, so it throws.
 */
export class Setting {
  constructor(_containerEl: HTMLElement) {
    notModelled(
      "new Setting()",
      "Its DOM subtree and chainable control builders are Obsidian's, not ours."
    );
  }
}

/**
 * Extended by `FolderSuggest` in `CreateSpacePanel.ts`, so the class must
 * exist for that module to evaluate — but `FolderSuggest.ts` records
 * that its constructor requires a real `App`, so constructing one is out of
 * reach here.
 */
export class AbstractInputSuggest<T> {
  constructor(_app: unknown, _inputEl: HTMLInputElement) {
    notModelled(
      "new AbstractInputSuggest()",
      "It requires a real App (see FolderSuggest.ts) and owns its own popover DOM."
    );
  }
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return notModelled("AbstractInputSuggest.getSuggestions()", "Subclasses override it.");
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {
    notModelled("AbstractInputSuggest.renderSuggestion()", "Subclasses override it.");
  }
  selectSuggestion(_value: T): void {
    notModelled("AbstractInputSuggest.selectSuggestion()", "Subclasses override it.");
  }
  setValue(_value: string): void {
    notModelled("AbstractInputSuggest.setValue()", "Input wiring is not modelled.");
  }
  close(): void {
    notModelled("AbstractInputSuggest.close()", "Popover teardown is not modelled.");
  }
}

/**
 * `setIcon(el, name)` injects Obsidian's own Lucide SVG. The exact element,
 * classes and attributes are undocumented, and a test that asserted against a
 * guessed shape would be asserting against this file rather than against
 * Obsidian. Icon presence is a Layer 4 question (`dev:dom`).
 */
export function setIcon(el: HTMLElement, iconId: string): void {
  // Deliberately NOT a model of Obsidian's markup — the SVG element, classes
  // and attributes it injects are undocumented, and inventing them would make
  // any test that asserted on them worthless.
  //
  // What this does model is the one thing that IS certain: the call succeeds
  // and leaves an icon in the element. That is enough for a test about a
  // panel's STATE (pressed, invalid, focused) to run without the icon calls
  // scattered through its render throwing. `data-stub-icon` is this stub's
  // own invention and exists only so a failure is legible in a DOM dump —
  // nothing in `src/` reads it, and no test may assert on the shape of what
  // lands here. Anything about real icon markup stays Layer 4.
  el.replaceChildren();
  el.setAttribute("data-stub-icon", iconId);
}

/**
 * `getIconIds()` returns Obsidian's live registry (~1500 ids, per
 * `src/ui/knownIcons.ts:8`). Any list written here would be fiction, and
 * `knownIcons.ts` exists specifically to decide membership against the real
 * registry.
 */
export function getIconIds(): string[] {
  return notModelled(
    "getIconIds()",
    "It reads Obsidian's live icon registry; no list written here would be real."
  );
}

/**
 * Deliberately not implemented even though the algorithm is nearly public:
 * `src/actions/spaceLifecycle.ts:29-44` already documents that spaces's own
 * canonicalisation is a NARROW approximation and not the real function. A
 * plausible-looking reimplementation here would quietly become the reference
 * the tests agree with, which is the failure mode this stub is written to
 * avoid.
 */
export function normalizePath(_path: string): string {
  return notModelled(
    "normalizePath()",
    "Its full normalisation (separators, unicode, edge cases) is Obsidian's."
  );
}

/* ------------------------------------------------------------------ *
 * Type-position exports
 *
 * `src/` imports these with `import type` only, so they are erased before the
 * alias is ever consulted. They exist so that a `import { App } from
 * "obsidian"` written by mistake fails with a message rather than with
 * "undefined is not a constructor".
 * ------------------------------------------------------------------ */

export class App {
  constructor() {
    notModelled("new App()", "Build the small structural shape your code actually reads.");
  }
}

export class Vault {
  constructor() {
    notModelled("new Vault()", "Build the small structural shape your code actually reads.");
  }
}

export class WorkspaceLeaf {
  constructor() {
    notModelled("new WorkspaceLeaf()", "Build the small structural shape your code actually reads.");
  }
}
