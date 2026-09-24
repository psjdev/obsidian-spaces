/**
 * Putting a row of ours inside a menu Obsidian builds itself.
 * Pure — no DOM, no `"obsidian"` import; the prototype arrives injected.
 *
 * One caller today: the sort-order menu, which takes spaces's own ordering as
 * a seventh mode. The mechanism is not specific to it, which is why this file
 * is not named for it.
 *
 * The public menu events (`file-menu`, `files-menu`, `editor-menu`,
 * `url-menu`) cover neither, but `Menu.prototype.addItem` and
 * `showAtMouseEvent` are PUBLIC API, so this file does not join the
 * private-API quarantine. Both menus build synchronously inside the handler
 * for the gesture that opens them, so a patch armed by that gesture covers
 * exactly one — and since adding an item to an already-shown menu doesn't
 * render it, injection must happen BEFORE the original show method runs.
 *
 * `addItem` is patched only when a caller wants the HOST's items touched:
 * the sort menu unticks Obsidian's six modes, and must see items the host
 * adds before it calls show. Omit `decorateHostItem` and `onHostItemClick`
 * and `addItem` is left alone entirely. The wrapper never re-invokes the
 * caller's callback, since a second call would run side effects twice.
 *
 * The arm is scoped to a MENU, not a gesture: until `isIntendedMenu` answers
 * yes, `addItem` only COLLECTS items, so a menu another plugin opens inside
 * the armed macrotask passes through untouched.
 */

export interface MenuItemLike {
  setTitle(title: string): MenuItemLike;
  setIcon(icon: string): MenuItemLike;
  onClick(handler: () => void): MenuItemLike;
  setChecked(checked: boolean): MenuItemLike;
}

export interface MenuLike {
  addItem(cb: (item: MenuItemLike) => void): unknown;
}

type ShowMethod = (this: MenuLike, ...args: unknown[]) => unknown;

type AddItemMethod = (this: MenuLike, cb: (item: MenuItemLike) => void) => unknown;

export interface MenuPrototype {
  addItem: AddItemMethod;
  showAtMouseEvent: ShowMethod;
  showAtPosition: ShowMethod;
}

/** Both ways Obsidian opens a menu. The sort button uses the first (measured). */
const SHOW_METHODS = ["showAtMouseEvent", "showAtPosition"] as const;

/**
 * Logged once per SESSION, like the structurally identical logging in
 * `nativeExplorerSort.ts` — not once per arming, because arming happens on
 * every click of the sort button and a per-gesture log would eventually
 * flood.
 */
const logged = { identity: false, decoration: false, row: false };

function logOnce(key: keyof typeof logged, what: string, err: unknown): void {
  if (logged[key]) return;
  logged[key] = true;
  console.error(`Spaces: ${what}`, err);
}

/** What one arming needs in order to be taken back down from outside. */
interface Arming {
  restore: () => void;
  cancelTimer: () => void;
}

/**
 * At most one arming is live, because there is only one
 * `Menu.prototype`. A second arming installed while the first was still in
 * place would capture OUR wrapper as its `original`, and no restore could then
 * get back to Obsidian's own method — the first wrapper would sit on the
 * prototype for the rest of the session. Holding the live arming here also
 * gives `onunload` a teardown that is one call and needs no field in the
 * caller.
 */
let activeArming: Arming | null = null;

/**
 * Take down whatever is armed: cancel the pending restore and restore now.
 *
 * Safe to call when nothing is armed, and safe to call twice. `onunload` needs
 * it because `defer` is a bare `setTimeout` — the one kind of callback in this
 * plugin that no `Component` owns — and because a wrapper left on a shared
 * prototype after the plugin is gone is exactly the interoperability cost this
 * seam is meant to keep to one gesture.
 */
export function cancelMenuInjection(): void {
  const arming = activeArming;
  activeArming = null;
  if (!arming) return;
  arming.cancelTimer();
  arming.restore();
}

/** What the wrappers remember about one menu built during the armed window. */
interface MenuRecord {
  /** The REAL items the host added, in order — never proxies. */
  items: MenuItemLike[];
  /** Set once `isIntendedMenu` has said this is the menu the gesture meant. */
  intended: boolean;
}

/**
 * Arm a one-shot injection into the next menu this prototype shows **that the
 * caller recognises**.
 *
 * Call it from the sort button's click. The menu `isIntendedMenu` accepts gets
 * `buildRow` applied just before it renders; then the prototype is put back. A
 * menu that is not recognised passes straight through and does NOT consume the
 * arm — the sort menu need not be the first menu to open in the window. If the
 * click opens no menu at all, `defer` puts the prototype back anyway.
 *
 * `defer` is injected rather than closed over `setTimeout` so tests can run
 * the restore without a timer. Production passes a `window.setTimeout` and
 * returns the `clearTimeout` for it.
 */
export function armMenuInjection(args: {
  proto: MenuPrototype;
  /**
   * Asked, on ENTRY to the show wrapper, whether the menu now showing is the
   * one the arming gesture meant. It is handed the arguments the host passed
   * to the show method, which is where the anchor lives: Obsidian's explorer
   * shows the sort menu with `showAtMouseEvent(evt)` for the very click that
   * armed this. A throw is read as "no" — see the `identity` catch below.
   */
  isIntendedMenu: (showArgs: unknown[]) => boolean;
  buildRow: (menu: MenuLike) => void;
  /**
   * Applied to every item the HOST added to that one menu, once the menu has
   * been recognised. It unticks Obsidian's six sort modes, so the single tick
   * left is the one naming what is actually on screen.
   *
   * Omit it, and omit `onHostItemClick`, and `addItem` is not patched at all.
   */
  decorateHostItem?: (item: MenuItemLike) => void;
  /**
   * Called when the user activates one of the HOST's items in that menu, after
   * the host's own handler has run.
   *
   * This exists because inferring the gesture from its effect does not work.
   * Reading "the user chose a sort" off a `sortOrder` change misses the mode
   * already in effect: choosing it changes nothing, so the click does nothing
   * at all — and with the native modes unticked, that is a dead click on a
   * mode the user can see is not active. A click is positive evidence and
   * needs no inference.
   *
   * Supplying it is what installs the item proxy, and the proxy is the one
   * thing here a host can observe (`proxy !== item`). Pass it only when a
   * report would actually change something.
   */
  onHostItemClick?: () => void;
  /**
   * Runs the restore at the end of the macrotask. Return a canceller and
   * `cancelMenuInjection` can stop it; return nothing and it cannot.
   */
  defer: (fn: () => void) => (() => void) | void;
}): void {
  // Whatever is still armed comes down first. See `activeArming`.
  cancelMenuInjection();

  const { proto, isIntendedMenu, buildRow, decorateHostItem, onHostItemClick, defer } = args;

  const records = new WeakMap<MenuLike, MenuRecord>();
  const original: Record<string, ShowMethod> = {};
  const ours: Record<string, ShowMethod> = {};
  let originalAddItem: AddItemMethod | null = null;
  let ourAddItem: AddItemMethod | null = null;
  let live = true;
  let cancelTimer: (() => void) | void;

  const restore = (): void => {
    if (!live) return;
    // Cleared FIRST, so our wrappers are inert from this moment even in the
    // branches below where they cannot be lifted out of the chain.
    live = false;
    for (const name of SHOW_METHODS) {
      // Ownership check. If another plugin patched over us, its wrapper is now
      // the prototype's value and restoring would delete it. Ours stays in the
      // chain instead, passing straight through and adding nothing.
      if (proto[name] === ours[name]) proto[name] = original[name];
    }
    if (originalAddItem && proto.addItem === ourAddItem) proto.addItem = originalAddItem;
  };

  /**
   * What the host's callback is handed instead of the real item, and ONLY when
   * `onHostItemClick` was supplied — a proxy is not identical to the item it
   * wraps, so a host that stores what it was given cannot find it again in
   * `menu.items` by identity, nor in a `WeakMap` it keyed on it.
   *
   * A plain object listing the four methods of `MenuItemLike` would throw the
   * moment Obsidian called anything else on it — `setSection`, `setDisabled`,
   * `setIsLabel` — and cost the user the entire menu. A proxy forwards
   * everything, and re-wraps the return value so the host's chaining
   * (`setTitle(...).setChecked(...)`) keeps landing on the proxy.
   */
  const clickReportingProxy = (
    item: MenuItemLike,
    record: MenuRecord,
    report: () => void
  ): MenuItemLike => {
    const proxy: MenuItemLike = new Proxy(item, {
      get(target, prop, receiver): unknown {
        if (prop === "onClick") {
          return (handler: () => void): MenuItemLike => {
            target.onClick(() => {
              try {
                handler();
              } finally {
                // `finally`: the host's handler is what applies the sort mode,
                // and if it throws we still know the user picked a mode.
                //
                // `record.intended` is the entry check reaching this far. A
                // menu the arm never recognised never becomes intended, so
                // clicking one of ITS items never records a sort override.
                if (record.intended) report();
              }
            });
            return proxy;
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...callArgs: unknown[]): unknown => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, callArgs);
          return result === item ? proxy : result;
        };
      },
    });
    return proxy;
  };

  if (decorateHostItem || onHostItemClick) {
    const originalAdd = proto.addItem;
    originalAddItem = originalAdd;
    const report = onHostItemClick;
    // The callback is WRAPPED, never re-invoked. Calling it a second time to
    // inspect the item would run any side effect inside it twice.
    const wrapper: AddItemMethod = function (this: MenuLike, cb): unknown {
      if (!live) return originalAdd.call(this, cb);
      let found = records.get(this);
      if (!found) {
        found = { items: [], intended: false };
        records.set(this, found);
      }
      const record = found;
      return originalAdd.call(this, (item: MenuItemLike) => {
        // COLLECT only. Nothing here yet says which menu this is, so the
        // decoration waits for the show wrapper's entry check and the
        // host gets its real item unless a click report was asked for.
        record.items.push(item);
        cb(report ? clickReportingProxy(item, record, report) : item);
      });
    };
    ourAddItem = wrapper;
    proto.addItem = wrapper;
  }

  const isIntended = (showArgs: unknown[]): boolean => {
    try {
      return isIntendedMenu(showArgs);
    } catch (e) {
      // Fail CLOSED, the one place in this file that does. Everywhere else the
      // cost of a throw is spaces's own row; here it would be another
      // plugin's menu, so a check that cannot answer must not read as "yes".
      logOnce("identity", "could not identify the sort menu; leaving this menu alone", e);
      return false;
    }
  };

  for (const name of SHOW_METHODS) {
    const target = proto[name];
    original[name] = target;
    const wrapper: ShowMethod = function (this: MenuLike, ...rest: unknown[]): unknown {
      // Not recognised: pass through, and stay armed. Bailing must not consume
      // the arm — the sort menu may not be the first menu of the macrotask.
      if (live && isIntended(rest)) {
        const record = records.get(this);
        if (record) {
          record.intended = true;
          for (const item of record.items) {
            try {
              decorateHostItem?.(item);
            } catch (e) {
              // A failed decoration must not cost the host its own menu item;
              // the visible cost is Obsidian's tick left where it was.
              logOnce("decoration", "could not untick a native sort mode", e);
            }
          }
        }
        // Disarm before building, never after. Two reasons: a `buildRow` that
        // opened a menu of its own would otherwise re-enter this wrapper, and
        // restoring first puts the ORIGINAL `addItem` back — so our own row is
        // neither collected nor decorated and keeps the tick we set on it.
        restore();
        try {
          buildRow(this);
        } catch (e) {
          // A broken row must not cost the user Obsidian's own sort menu.
          logOnce("row", "could not add the saved-ordering row to the sort menu", e);
        }
      }
      return target.apply(this, rest);
    };
    ours[name] = wrapper;
    proto[name] = wrapper;
  }

  activeArming = {
    restore,
    cancelTimer: () => {
      if (typeof cancelTimer === "function") cancelTimer();
    },
  };
  cancelTimer = defer(restore);
}
