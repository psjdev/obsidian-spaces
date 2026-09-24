import {
  Notice,
  PluginSettingTab,
  type App,
  type Plugin,
  type Setting,
  type SettingDefinitionItem,
} from "obsidian";
import type { DefinitionStore } from "../definitions/DefinitionStore";
import type { SpacesDefinitions, StripPlacement } from "../types";
import { deleteSpace, renameSpace, type SpaceLifecycleHooks } from "../actions/spaceLifecycle";
import { setStripPlacement } from "../actions/stripPlacement";
import { memberRows, missingCount, spaceRowSummary } from "./memberList";
import {
  MAX_PATTERNS,
  MAX_PATTERN_LENGTH,
  compileIgnore,
  type SkipReason,
} from "../visibility/glob";
import { isFolderSpace } from "../visibility/folderSpace";
import { ConfirmModal } from "./ConfirmModal";
import { SpaceContentsModal } from "./SpaceContentsModal";
import {
  BlurCommitLedger,
  deleteWithConfirm,
  type BlurCommittedField,
} from "./settingsEdits";

/**
 * Where to send someone who wants to support the plugin, or `""` for
 * nowhere.
 *
 * Empty renders NO header at all, rather than a dead link or a placeholder —
 * an affordance that does nothing is worse than an absent one. Point it at
 * Ko-fi, Buy Me a Coffee, GitHub Sponsors or anything else; all of them are
 * just a URL, and the choice changes nothing here.
 *
 * Empty is what ships. Obsidian's developer policies treat a support prompt
 * inside the plugin's own interface as something a README has to disclose, and
 * `manifest.json`'s `fundingUrl` already does the same job the way Obsidian
 * intends: a Support link on the community-list entry, no code, and nothing
 * asking for money inside the settings tab. The renderer below stays because
 * the decision is a URL, not a rewrite.
 *
 * Whoever sets it must name an address `fundingUrl` also names.
 * `tests/manifest.test.ts` asserts exactly that, because the failure that
 * matters is a settings link the listing never offers.
 */
export const SUPPORT_URL = "";

/**
 * Whether something outside spaces's own toggle is standing in the way of
 * restoration. `reason` is present whenever the native-workspaces status is
 * not "disabled" — independent of the toggle's own value: a
 * user who reads the toggle as ON and stops reading must not be shown a
 * clean pane when core Workspaces already overrides it. Kept as a plain
 * accessor (rather than importing the detector) so this file never needs to
 * know about Obsidian's private `internalPlugins` API.
 */
export interface EffectiveRestoreState {
  reason?: string;
}

/**
 * Whether the file explorer still exposes the sort seam ordering rides on.
 * Kept as a plain accessor for the same reason as
 * `EffectiveRestoreState` above: this file must never need to know which
 * private method ordering rides on — that knowledge is quarantined to
 * `src/layout/nativeExplorerSort.ts`, and naming it here would defeat the
 * grep that checks the quarantine holds.
 *
 * `available: false` is surfaced rather than swallowed. Ordering depends on
 * private API, which is the most version-fragile thing in this plugin, and a
 * user whose Obsidian dropped the seam deserves to see why dragging stopped
 * working instead of concluding the feature is broken.
 */
interface OrderingStatus {
  available: boolean;
}

/**
 * The Ignored-paths box reduced to exactly what gets persisted. Shared by the
 * commit and the flush so both compare like with like: without one
 * canonical form, adding a trailing newline would read as a pending edit
 * forever and `hide()` would rewrite the same list on every close.
 */
function ignoreLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * One sentence per skip reason, in the second person, saying what to do about
 * it. The reasons themselves come from `compileIgnore`; only the wording lives
 * here, because the wording is this control's business and the rule is the
 * compiler's.
 */
export function ignoreSkipMessage(reason: SkipReason): string {
  switch (reason) {
    case "over-cap":
      // "Maximum 100 patterns; beyond that, extras are ignored with a
      // notice." This is that notice.
      return `Only the first ${MAX_PATTERNS} patterns are used, and this one is past that limit.`;
    case "blank":
      return "Blank, so there is nothing to match.";
    case "too-long":
      // The cap bounds what one pattern can cost to match, so the
      // advice is to shorten it rather than to rewrite it.
      return `Longer than ${MAX_PATTERN_LENGTH} characters. Shorten it, or split it into separate rules.`;
    case "traversal":
      return 'Has a ".." segment, which patterns may not use. A folder whose name merely contains two dots is fine.';
    case "absolute":
      return 'Starts with "/". Patterns are vault-relative, so remove the leading slash.';
    case "uncompilable":
      return "Not a pattern this version can compile, so it hides nothing.";
  }
}

export class SpacesSettingTab extends PluginSettingTab {
  private readonly edits = new BlurCommitLedger();

  constructor(
    app: App,
    plugin: Plugin,
    private defs: DefinitionStore,
    private hooks?: SpaceLifecycleHooks,
    private getEffectiveRestore?: () => EffectiveRestoreState,
    private getOrderingStatus?: () => OrderingStatus,
    // A callback, not the switcher itself: this tab is built before the
    // switcher exists, in `onload()`, and only ever needs the one thing on
    // it that a placement change must cancel first.
    private cancelStripDrag?: () => void
  ) {
    super(app, plugin);
  }

  /**
   * The tab, declared rather than drawn.
   *
   * Obsidian renders from this and indexes it for the settings search, which
   * is the point: built imperatively in `display()`, none of these settings
   * could be found by typing "reorder" into the Settings search box. Returning
   * a non-empty array also means `display()` is never called, so this is the
   * whole tab — there is no half-way arrangement.
   *
   * Re-run by `update()`, which is how anything derived from state is
   * refreshed: the `desc` fields below are values rather than callbacks, so a
   * description that depends on a setting is regenerated by re-asking this
   * method, not by mutating a node that has already been rendered.
   *
   * TWO pages, not one per section. The split is deliberate and predates the
   * declarative API, which only changed who draws the navigation. One page per
   * section would have put two settings behind three of them and ONE behind
   * another, so finding a toggle would mean guessing which page it lived
   * under — navigation added on top of a problem navigation does not solve.
   * What actually buried the toggles was the space list, which grows without
   * bound; separating that is the whole win, and the toggles stay on one
   * screen, grouped by heading and scannable at a glance.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      // First, and its own page rather than a group inside Preferences: it is
      // the half of the settings people go looking for. Preferences keeps the
      // behavioural groups behind it.
      { type: "page", name: "Appearance", items: this.appearanceItems() },
      { type: "page", name: "Preferences", items: this.preferenceItems() },
      { type: "page", name: "Spaces", items: this.spaceItems() },
    ];
  }

  /**
   * Reads a toggle's value out of this plugin's own store.
   *
   * Overridden because the default reads `app.vault.getConfig`, which knows
   * nothing about `data.json`. Only booleans arrive here: the two controls
   * with editing semantics worth keeping — ignored paths, and a space's name —
   * stay imperative below, so the store's write path, its validation and its
   * blur-commit behaviour are untouched by this migration.
   */
  override getControlValue(key: string): unknown {
    const settings = this.defs.get().settings as unknown as Record<string, unknown>;
    return settings[key];
  }

  /** The matching write. `save` reports failure exactly as it did before. */
  override setControlValue(key: string, value: unknown): void {
    if (key === "stripPlacement") {
      // Routed through the shared setter rather than the generic write path
      // below, so Settings, the four commands and a completed drag can never
      // disagree about where the strip is. Cancels a drag in flight before
      // writing, so choosing a placement from Settings mid-gesture ends the
      // gesture cleanly rather than racing it.
      void setStripPlacement(this.defs, value as StripPlacement, () => this.cancelStripDrag?.());
      return;
    }
    this.save(
      (d) => {
        (d.settings as unknown as Record<string, unknown>)[key] = value;
      },
      // One setting governs another's enabled state AND its description, and a
      // description is a value here rather than a callback. Re-asking for the
      // definitions is what redraws it.
      key === "allowReordering"
    );
  }

  /**
   * What the Spaces page is built from, as a string.
   *
   * Ids and names in order, because those are the three things a change to
   * the space list can do that the rendered page must follow: add, remove,
   * rename, reorder. Settings live on the other page and are read through
   * `getControlValue`, so a toggle changes no definition and must not cost a
   * redraw.
   */
  private spaceSignature(): string {
    return this.defs
      .get()
      .spaces.map((s) => `${s.id}\u0000${s.name}`)
      .join("\u0001");
  }

  private lastSignature: string | null = null;

  /**
   * Re-reads the definitions when, and only when, the space list has changed.
   *
   * Obsidian builds a declarative tab from `getSettingDefinitions()` once,
   * when the tab is registered, and then renders `settingItems`. It does NOT
   * re-ask on open: `display()` is what used to be called every time, and a
   * tab that returns definitions never gets `display()` at all. The typings
   * say as much from the other side — `update()` is "called by dynamic tabs
   * when their data changes", and this is a dynamic tab.
   *
   * Before this existed, a space created from the explorer's + button did not
   * appear in settings until Obsidian restarted and the tab was registered
   * again, because nothing here had any reason to look again.
   *
   * Gated on the signature rather than refreshed on every definition change:
   * every toggle on the Preferences page writes to the same store, and
   * redrawing the whole tab under the user's cursor each time they flip a
   * switch is the cost `save()` has always deliberately avoided.
   */
  refreshIfSpacesChanged(): void {
    const next = this.spaceSignature();
    if (next === this.lastSignature) return;
    this.lastSignature = next;
    this.update();
  }

  override hide(): void {
    this.edits.flush();
    this.edits.clear();
    super.hide();
  }

  /** A fragment belonging to the settings window rather than the main one. */
  private frag(): DocumentFragment {
    return this.containerEl.doc.win.createFragment();
  }

  /** Body text, plus a warning block under it when there is one. */
  private describe(text: string, warning?: (host: HTMLElement) => void): string | DocumentFragment {
    if (!warning) return text;
    const frag = this.frag();
    frag.appendText(text);
    // A fragment takes the same `createDiv`/`createEl` helpers an element
    // does; Obsidian declares them on `Node`.
    warning(frag as unknown as HTMLElement);
    return frag;
  }

  /**
   * The Appearance page's items, flat rather than wrapped in a group: the
   * page is the heading, and a group repeating it would read as a stutter.
   */
  private appearanceItems(): SettingDefinitionItem[] {
    return [
      {
        name: "Show the space name above the file tree",
        desc:
          "Shows the active space's icon and name at the top of the file explorer. " +
          "Turn it off if the icon strip along the bottom is orientation enough.",
        control: { type: "toggle", key: "showSpaceHeader" },
      },
      {
        name: "Mark folder pinned spaces with a pin",
        desc:
          "When the space name row above is shown, a folder pinned space gets a pin " +
          "on the right. Hover it to see which folder.",
        control: { type: "toggle", key: "showPinnedFolder" },
      },
      {
        // Led by "All" rather than "Pin All …": sentence case is linted,
        // and mid-sentence the view's own label is indistinguishable from
        // the quantifier — "Pin all …" would read as pinning every icon.
        name: "All stays at the left of the space strip",
        desc:
          "Keeps All in place while the other space icons scroll past it, " +
          "the way the + button stays pinned to the right.",
        control: { type: "toggle", key: "pinAllSpace" },
      },
      {
        name: "Space strip position",
        desc:
          "Where the strip of space icons sits in the file explorer. Left and " +
          "right show it as a vertical ribbon.",
        control: {
          type: "dropdown",
          key: "stripPlacement",
          options: {
            bottom: "Bottom",
            top: "Top",
            left: "Left",
            right: "Right",
          },
        },
      },
      {
        name: "Assign a colour to new spaces",
        desc:
          "New spaces take the next colour in the palette, so consecutive " +
          "spaces are easy to tell apart. Turn this off to start every new " +
          "space neutral and pick its colour yourself.",
        control: { type: "toggle", key: "autoAssignColor" },
      },
      {
        name: "Use theme colours for space icons",
        desc:
          "Draws every space icon in your theme's icon colour instead of the " +
          "colour you gave it. Your colours are kept and come back when you " +
          "turn this off.",
        control: { type: "toggle", key: "useThemeIconColor" },
      },
      {
        name: "Active space style",
        desc:
          "How the strip marks the space you are in. Shaded shades it the way " +
          "your theme shades a selected row. Boxed adds an outline in the " +
          "space's colour. Bolded draws the icon at a heavier weight and no " +
          "shading.",
        control: {
          type: "dropdown",
          key: "activeSpaceStyle",
          options: {
            shaded: "Shaded",
            boxed: "Boxed",
            // Kept to one short word each. A native select sizes to its
            // selected option, so a long label makes the whole row jump when
            // the value changes, and the declarative settings API exposes
            // no class to scope a width rule to, only `name` and `desc`, so a
            // CSS fix would have to style every plugin's dropdowns.
            bolded: "Bolded",
          },
        },
      },
    ];
  }

  private preferenceItems(): SettingDefinitionItem[] {
    const settings = this.defs.get().settings;
    const orderingUnavailable = this.getOrderingStatus ? !this.getOrderingStatus().available : false;
    const restoreBlocked = this.getEffectiveRestore?.().reason;

    return [
      {
        type: "group",
        heading: "File tree",
        items: [
          {
            name: "Show files you open that are not in this space",
            desc:
              "A file you open appears dimmed and italic even when it is not a member, " +
              "so you can see it and add it to the space. Turn this off to show only members.",
            control: { type: "toggle", key: "revealVisitors" },
          },
          {
            name: "Ignored paths",
            desc: this.describe(
              "One glob per line. Supports * within a segment and ** across segments. " +
                "Hidden in every space; an explicit member overrides this.",
              (host) => {
                this.renderIgnoreWarning(host);
              }
            ),
            // Imperative on purpose. A declarative `textarea` control persists
            // on change, and this field must persist on BLUR: one `mutate` per
            // keystroke would put a save, a recompile of every glob and a tree
            // repaint behind each character typed.
            render: (setting) => {
              this.renderIgnoreField(setting);
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Reordering",
        items: [
          {
            name: "Allow reordering of space items",
            desc: this.describe(
              "Drag rows in the file explorer to arrange them, remembered separately " +
                "for each space and for All. Turn this off to sort the tree normally; " +
                "any orders you have set are kept, not discarded.",
              orderingUnavailable
                ? (host) => {
                    const warn = host.createDiv({ cls: "spaces-setting-warning" });
                    warn.createEl("strong", { text: "Unavailable in this Obsidian version. " });
                    warn.appendText(
                      "Spaces filters and orders the tree through the file explorer's own sort, " +
                        "and this version does not expose it. Spaces can no longer filter, so the " +
                        "whole vault shows; nothing you have set has been lost, and it will apply " +
                        "again when Obsidian restores it."
                    );
                  }
                : undefined
            ),
            control: { type: "toggle", key: "allowReordering" },
          },
          {
            // "outside spaces" for the same sentence-case reason as "All stays
            // at the left" above. All is the only thing outside a space, and
            // the description names it.
            name: "Allow reordering outside spaces",
            desc: settings.allowReordering
              ? "Drag rows to arrange them in All as well as in spaces. Turn this off to leave " +
                "All sorted the way Obsidian sorts it; any order you have set for All is kept, " +
                "not discarded."
              : "Reordering is off above, so this has no effect. Any order you have set for All " +
                "is kept, and this applies again when you turn reordering back on.",
            control: {
              type: "toggle",
              key: "allowReorderingAll",
              // Asked fresh on every render and again by `refreshDomState()`,
              // so the greying follows the toggle above without this file
              // wiring the two together.
              disabled: () => !this.defs.get().settings.allowReordering,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Switching",
        items: [
          {
            name: "Restore tabs when switching spaces",
            desc: this.describe(
              "Off, switching changes only the file tree. On, each space also " +
                "remembers its own tabs, sidebars and active pane, and switching " +
                "restores them.",
              restoreBlocked
                ? (host) => {
                    const warn = host.createDiv({ cls: "spaces-restore-warning" });
                    warn.createEl("strong", { text: "Restoration is unavailable:" });
                    warn.appendText(` ${restoreBlocked}.`);
                  }
                : undefined
            ),
            control: { type: "toggle", key: "restoreLayouts" },
          },
        ],
      },
    ];
  }

  /**
   * The ignored-paths textarea, kept on the blur-commit ledger.
   *
   * `tests/settingsBlurFlush.test.ts` covers what that protects: a value typed
   * and then abandoned by closing the dialog is still written, once, by
   * `hide()`.
   */
  private renderIgnoreField(setting: Setting): void {
    setting.addTextArea((t) => {
      const saved = (): string => this.defs.get().settings.globalIgnore.join("\n");
      t.setValue(saved());
      t.inputEl.rows = 6;
      const field: BlurCommittedField = {
        current: () => ignoreLines(t.getValue()).join("\n"),
        write: (value) => {
          const lines = value ? value.split("\n") : [];
          this.defs
            .mutate((d) => {
              d.settings.globalIgnore = lines;
            })
            .then(
              // Redraws the warning by re-asking for the definitions, which is
              // the declarative equivalent of repainting the one node.
              () => {
                this.update();
              },
              (e: unknown) => {
                new Notice(`Spaces: could not save ignored paths (${String(e)})`);
              }
            );
        },
      };
      this.edits.track(field, saved());
      t.inputEl.addEventListener("blur", () => {
        this.edits.commit(field);
      });
    });
  }

  /**
   * The notice for patterns past the cap, and for an invalid pattern that is
   * reported and skipped. Same visual treatment as the ordering warning rather
   * than a third style, and no colours of its own — `.spaces-setting-warning`
   * is built from `--text-error` and `--background-modifier-error`.
   */
  private renderIgnoreWarning(host: HTMLElement): void {
    const { skipped } = compileIgnore(this.defs.get().settings.globalIgnore);
    if (skipped.length === 0) return;

    const warn = host.createDiv({ cls: "spaces-setting-warning" });
    warn.createEl("strong", {
      text:
        skipped.length === 1
          ? "1 pattern is not being applied. "
          : `${skipped.length} patterns are not being applied. `,
    });
    warn.appendText("They are still saved, but they hide nothing:");
    for (const s of skipped) {
      const line = warn.createDiv();
      line.appendText(`Line ${s.index + 1}: `);
      line.createEl("code", { text: s.pattern.trim() || "(blank)" });
      line.appendText(` — ${ignoreSkipMessage(s.reason)}`);
    }
  }

  /**
   * One row per space, imperative for the same reason as the ignore field: the
   * name commits on blur, and the two buttons are actions rather than values.
   * The name and the summary stay declarative, so a space is still findable by
   * name in the settings search.
   */
  private spaceItems(): SettingDefinitionItem[] {
    const spaces = this.defs.get().spaces;
    if (spaces.length === 0) {
      return [
        {
          name: "No spaces yet",
          desc: "Use the + button at the bottom of the file explorer to make one.",
        },
      ];
    }

    const exists = (path: string): boolean => this.app.vault.getAbstractFileByPath(path) !== null;

    return spaces.map((space) => {
      const rows = memberRows(space, exists);
      const missing = missingCount(rows);
      return {
        name: space.name,
        desc: spaceRowSummary(space, exists),
        render: (setting: Setting) => {
          setting.addText((t) => {
            t.setValue(space.name);
            const field: BlurCommittedField = {
              current: () => t.getValue().trim(),
              accepts: (v) => v.length > 0,
              write: (v) => {
                void renameSpace(this.defs, space.id, v);
              },
            };
            this.edits.track(field, space.name);
            t.inputEl.addEventListener("blur", () => {
              this.edits.commit(field);
            });
          });

          if (!isFolderSpace(space)) {
            setting.addButton((b) =>
              b
                .setButtonText("Contents…")
                .setTooltip(`See and manage what is in ${space.name}`)
                .onClick(() => {
                  new SpaceContentsModal(this.app, this.defs, space.id).open();
                })
            );
          }

          setting.addButton((b) =>
            b
              .setButtonText("Delete")
              .setDestructive()
              .onClick(async () => {
                await deleteWithConfirm(
                  { name: space.name, memberCount: rows.length, missingCount: missing },
                  {
                    confirm: (prompt) => new ConfirmModal(this.app, prompt).ask(),
                    remove: () => deleteSpace(this.defs, space.id, this.hooks),
                    // One fewer row is a change to the definitions themselves,
                    // not to a rendered value, so this is `update()` and not
                    // `refreshDomState()`.
                    onDeleted: () => {
                      this.update();
                    },
                    onError: (message) => {
                      new Notice(message);
                    },
                  }
                );
              })
          );
        },
      };
    });
  }

  /**
   * Every toggle writes the same way and reports failure the same way, so the
   * shape lives here once rather than nine times.
   *
   * `rerender` exists for the one setting whose value changes another
   * setting's enabled state; everywhere else redrawing the tab under the
   * user's cursor would be a cost with no benefit.
   */
  private save(fn: (d: SpacesDefinitions) => void, rerender = false): void {
    this.defs
      .mutate(fn)
      .then(() => {
        if (rerender) this.update();
      })
      .catch((e: unknown) => {
        new Notice(`Spaces: could not save setting (${String(e)})`);
      });
  }
}
