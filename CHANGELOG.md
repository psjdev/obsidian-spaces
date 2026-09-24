# Changelog

## 0.4.0 — 2026-09-24

The space you are in can be marked two ways now. **Box**, the default and what
every vault has today, draws a tinted square with a coloured outline around its
icon. **Bold** drops the box and draws the icon at a heavier weight
instead. Either way the active icon stays at full strength while the others
remain muted, so neither look leans on a single cue. Set it under Settings →
Appearance → **Active space style**.

Settings now has three pages rather than two. **Appearance** is its own page
beside **Preferences** and **Spaces**, holding the settings that change how the
explorer looks: the space header, the pin marker, where the strip sits, how the
active space is marked, and whether new spaces take a colour. Preferences keeps
the behavioural groups. Nothing was removed and every setting is still findable
from Obsidian's own settings search.

## 0.3.2 — 2026-09-21

Fixes a state you could get stuck in. Choosing one of Obsidian's sort modes
inside a space pauses your own ordering until you switch back, and **User
ordered** in the sort menu is how you switch back. That entry only appeared
once a space had an order saved, so a space you had never reordered by hand
offered no way back: the paused ordering blocked the drag that would have
created the first order, and without an order the menu entry stayed hidden.

**User ordered** now appears whenever your ordering is paused, unticked,
whether or not anything has been reordered yet. Picking it resumes dragging.
The **Restore saved ordering** command always worked here and still does.

## 0.3.1 — 2026-09-21

Fixes sorting inside a space pinned to a folder. Obsidian's sort modes had no
effect there: the pinned folder's contents are hoisted to the top of the
explorer, and they were read straight from the vault's own list of children
rather than from Obsidian's sorted one. Because that list is usually
alphabetical, **File name (A to Z)** looked correct and every other mode
appeared to do nothing. Sorting inside subfolders was never affected, and no
saved order was ever at risk: nothing here writes one.

The notice shown when a drag is declined now says that dropping onto a folder
still moves the file. Declining a reorder does not cancel the drag, and
Obsidian goes on to handle it, so a row could leave a folder space while the
notice implied nothing had happened.

## 0.3.0 — 2026-09-21

The space strip can now sit on any of the four sides of the file explorer, not just the bottom.

Top, left and right join bottom, the existing default. Left and right render the strip as a full height vertical ribbon down the side of the pane. Top sits it between Obsidian's own toolbar row and the space header, and Obsidian's toolbar stays above the strip in every placement. Whichever edge you pick is saved per vault in `data.json`, so it survives a restart and travels with the vault.

There are three ways to move it, all routed through the same setter so they can never disagree with each other. A new **Space strip position** dropdown sits in Settings → Appearance, next to the toggles it joins. Four new commands, `Move the space strip to the top/bottom/left/right`, do the same from the palette or a hotkey. The strip can also be dragged by hand, behind a new **Unlock the space strip** command: unlocking reveals a grab handle at the strip's leading edge, dragging it toward an edge lights up the region the strip would occupy there, and releasing over it drops the strip in place. **Lock the space strip** ends that mode again, from the palette or by right-clicking the handle.

The unlocked state is deliberately a mode rather than a setting. It lives only in memory, never appears in Settings, and always starts locked again the next time Obsidian loads the plugin, so a vault never opens with a stray handle sitting in the explorer.

A vertical strip lines itself up with the pane beside it. With *All* pinned, the pinned control centres on Obsidian's toolbar row and the first space below it centres on the space header -- or on the first row of the file tree when the header is turned off. Only the start of the strip aligns: its icons and the tree's rows step at different rates, and they are not parallel lists, so matching them further along would only look stretched.

A new **Switch to space** command opens a search box: type part of a space's name and pick it from the results. It is unbound by default, so give it whatever hotkey suits you. With nothing typed it offers *All* and your first five spaces; once you type, it searches every space, *All* included. This is the route that keeps working in a vault with more spaces than fit on screen, where the strip is a long scroll and the header's list is a long list.

A horizontal strip scrolls with the mouse wheel. The rail has always overflowed and scrolled correctly on every edge, but a wheel reports its movement as a vertical delta and Chromium will not apply that to a strip that scrolls sideways, so with more spaces than fit, a strip docked top or bottom had no way to reach the ones past the edge. The wheel now scrolls it along its own axis. A strip that is already at one end keeps out of the way, so the file tree underneath still scrolls.

## 0.2.2 — 2026-09-20

Fixes a regression introduced in 0.2.0: a space created after Obsidian started
did not appear in Settings until Obsidian was restarted.

0.2.0 moved the settings tab to Obsidian's declarative API. Obsidian asks a
declarative tab for its definitions once, when the tab is registered, and then
renders what it was given. The method that used to be called every time the tab
was opened, `display()`, is not called at all for a tab that supplies
definitions, so nothing re-read the space list. Deleting a space still worked,
because the delete button asked for a redraw itself; creating one from the
explorer did not, because nothing in the settings tab was watching.

The tab now refreshes from the plugin's existing definition subscription,
whenever the space list changes: added, removed, renamed or reordered. It
deliberately does not refresh on anything else, so flipping a toggle no longer
risks redrawing the panel under your cursor.

## 0.2.1 — 2026-09-20

A label fix and the documentation for a feature that was already there.

- The entry Spaces adds to Obsidian's sort menu reads **User ordered** rather
  than "User Ordered". It sits among Obsidian's own six modes, all of which are
  sentence case, and Title Case made it look like it came from somewhere else.
- The README has a **Sorting** section. A space can be shown in one of
  Obsidian's sort modes instead of your saved order by picking that mode from
  the file explorer's own sort button, and nothing said so. The only previous
  mention was a commands-table row explaining how to come back from a place the
  README never told you how to reach.

The new section is explicit about two limits, because both are easy to assume
away: what Spaces remembers per space is whether to show your order or
Obsidian's sort, not which sort, so two spaces cannot sit in two different
native modes at once; and saved orders sync with your vault while the choice
between them is local to each device.

No behaviour change.

## 0.2.0 — 2026-09-15

The settings tab is declared rather than drawn, which is what puts it in
Obsidian's settings search.

### Settings

- **Settings are searchable.** Typing "reorder" or "ignored" into the Settings
  search box now finds them. Previously the tab was built imperatively, so
  there was nothing for Obsidian to index.
- **Obsidian draws the navigation.** Preferences and Spaces are now pages
  Obsidian renders and moves between, replacing the tab strip this plugin drew
  itself. The split is unchanged: the toggles on one screen grouped by heading,
  the space list on its own.
- Every setting, group and warning reads exactly as it did. The ignored-paths
  box still commits when you click away rather than as you type, a space still
  renames on blur, and Delete still asks first.

### Under it

- `getSettingDefinitions()` replaces `display()`, which Obsidian deprecated in
  1.13. Saving still goes through this plugin's own store: `getControlValue`
  and `setControlValue` are overridden, so schema validation, write tokens and
  external-change handling are unchanged, and `data.json` keeps its shape.
- 464 lines of hand-rolled tab strip and its tests are gone, and the settings
  file is 220 lines shorter.

This is the last of the findings from the community directory's review of
0.1.4. The plugin's lint is now clean: no errors and no warnings.

## 0.1.6 — 2026-09-15

Builds every element through Obsidian's own DOM helpers, which is the second
of the two lint findings held back from 0.1.5.

Seventy-one `document.createElement` calls become `doc.win.createDiv()` and
friends. The point is the window: an element built through the owning document
belongs to the window it is about to live in, so a popped-out file explorer
gets elements from its own window rather than the main one. Same reasoning as
0.1.5's `instanceOf` and `window.requestAnimationFrame`.

Obsidian installs these helpers on every window but does not declare them on
`Window` in `obsidian.d.ts`, so `src/obsidian-dom.d.ts` declares the four names
this plugin calls. It is a type-level statement about an under-declared public
API, verified against a live 1.13.7 window, and nothing about it runs.

No behaviour change, no interface change, no change to saved data.

## 0.1.5 — 2026-09-15

Acts on the community directory's automated review of 0.1.4, and adds the lint
that review runs so the next one holds no surprises. `npm run lint` is now part
of `npm run build`, which the release workflow runs.

### Release integrity

- Release assets carry GitHub build provenance attestations, so anyone can
  verify that the `main.js` they downloaded was built from this repository at
  the tagged commit. Applies from this release onward.

### Interface

- "All stays at the left of the space strip" and "Allow reordering outside
  spaces" replace two settings whose names read as Title Case to Obsidian's
  sentence-case lint. Mid-sentence, "All" is indistinguishable from the
  quantifier: "Pin all …" would mean pinning every icon.
- The colour field's placeholder reads "Hex value" rather than a "#5b5bff"
  sample, for the same lint. The label is unchanged.
- The "Switching spaces" settings heading is now "Switching". A heading that
  repeats the plugin name inside the plugin's own tab says nothing.

### Correctness

- Element type tests use Obsidian's cross-window `instanceOf` rather than
  `instanceof`, and the animation frame the file explorer schedules is
  requested and cancelled on `window`. Both are about a popped-out explorer,
  where the main window's constructors and globals are the wrong ones to
  compare against.
- `setWarning` and `noticeEl` are replaced by `setDestructive` and
  `messageEl`. The two Delete buttons, in the settings list and in the
  confirmation dialog, do change appearance: `mod-warning` filled them solid
  red with white text, and `mod-destructive` renders a red tint with red text
  and a red border. This entry originally claimed neither button changed, on
  the strength of the class being applied rather than of what it renders.
- Twelve redundant type assertions are gone. Two of the twelve turned out to
  be load-bearing and were rewritten as `satisfies` rather than removed.

No change to what the plugin does, or to any saved data.

## 0.1.4 — 2026-09-15

Brings the plugin in line with Obsidian's developer policies and UI style guide.

- Menu and button labels are sentence case, matching the rest of Obsidian:
  "Rename space…", "Change space icon…", "Change space colour…", and the
  "Folder pinned" mode in the create panel.
- The settings tab no longer carries a support link. Funding is reachable the
  way Obsidian intends, from the plugin's entry in the community list, and
  nothing inside the plugin asks for money.

The README's opening no longer reads as though "Obsidian Spaces" were a
first-party product, and the requirements section now says what actually stands
between Spaces and mobile.

No behaviour change.

## 0.1.3 — 2026-09-15

The author field now reads as a name rather than a username. It is shown as
"By …" in the plugin browser, where `peter.jamrozinski` looked like an email
fragment. The copyright line matches.

No behaviour change.

## 0.1.2 — 2026-09-15

Rewrites the 0.1.0 notes. They had been written as changes relative to earlier
development builds, which nobody outside the project ever ran, so a first-time
reader met "until now" and "previously" with nothing to compare against. They
now describe what the release contains. Several entries also named buttons that
had since been renamed.

No behaviour change.

## 0.1.1 — 2026-09-15

Drops the "Arc-style spaces:" prefix from the plugin's description, so the
directory listing leads with what it does rather than what it resembles. The
same text now sits in `package.json`, which had drifted to its own wording.

No behaviour change.

## 0.1.0 — 2026-09-15

The first public release. Spaces adds switchable views to the file explorer:
pick a space and the tree shows only the notes and folders that belong to it.

### Spaces

- **Two kinds of space.** A *curated* space holds notes and folders you pick by hand; add a
  folder and everything inside it comes along. A *folder pinned* space is a live window onto
  one folder, with that folder hidden and its contents lifted to the top level, so anything
  you later add to it appears without you doing anything. Which kind a space is, is fixed
  when you create it.
- **Creating one.** Click **+** on the switcher strip or run **Create space**. Name it, give
  it an icon and a colour, then pick **Curated** or **Folder Pinned** and choose from a
  searchable tree of the vault. Both are optional: a name alone is a valid empty space.
  Right-click any folder and choose **Create folder pinned space** to make one in a click.
- **Adding and removing later.** Right-click any row for **Add to space**, or, inside a
  space, **Remove from *space***. Removing a member never touches the file.
- **New notes land in the right place.** Create a note or folder while a folder pinned space
  is active and it goes inside that space's folder, whether you used Ctrl+N, the ribbon, the
  explorer's own buttons, or followed a link to a note that does not exist yet.
- **Visitors.** Open a note that is not in the current space and it appears anyway, dimmed
  and italic, so a link never leads nowhere.
- **Your own row order.** Drag rows to arrange them, remembered per space. Drag the switcher
  icons to reorder the spaces themselves.
- **Per-space tabs, if you want them.** **Restore tabs when switching spaces** is off by
  default; turn it on and each space also remembers its own tabs and sidebars.

### Safety

- **Nothing is reorganised.** A note lives at one real path and belongs to zero or more
  spaces. Creating, renaming or deleting a space never moves, renames or deletes a file.
- **A corrupt `data.json` is never overwritten.** A document Spaces cannot understand is
  left alone rather than silently replaced with defaults, so a bad hand-edit or an
  interrupted sync cannot erase your spaces.
- **It fails open.** If the file explorer's layout cannot be recognised, filtering stops and
  leaves a complete working tree rather than a broken one.
- **No network access and no dependencies**, both enforced by tests.

### Performance

- Folder lookups are served from a vault index rather than a linear scan, which is what makes
  a space switch usable on a vault with thousands of notes.
- Bulk vault changes — a large paste, a git checkout touching many files — are coalesced into
  a single pass per burst instead of a full re-index per event.
