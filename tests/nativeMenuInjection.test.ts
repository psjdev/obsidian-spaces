import { describe, expect, it, vi } from "vitest";
import {
  armMenuInjection,
  cancelMenuInjection,
  type MenuLike,
  type MenuPrototype,
} from "../src/ui/nativeMenuInjection";

interface Rec {
  title?: string;
  icon?: string;
  click?: () => void;
  checked?: boolean;
  section?: string;
}

/**
 * The real shape: items accumulate on the INSTANCE, the methods live on the
 * prototype. A fake whose show methods sat on the instance would prove nothing
 * about the thing we actually patch.
 */
class FakeMenu {
  items: Rec[] = [];
  /** How many items existed when the original show finally ran. */
  itemsAtShowTime = -1;
  /** The REAL item objects, so a test can ask whether the host got one. */
  realItems: unknown[] = [];
  showArgs: unknown[] = [];
  /** Item count when each separator was added, so ordering can be asserted. */
  separatorsAfter: number[] = [];

  addSeparator(): this {
    this.separatorsAfter.push(this.items.length);
    return this;
  }

  addItem(cb: (item: unknown) => void): this {
    const rec: Rec = {};
    const item = {
      setTitle(t: string) {
        rec.title = t;
        return item;
      },
      setIcon(i: string) {
        rec.icon = i;
        return item;
      },
      onClick(h: () => void) {
        rec.click = h;
        return item;
      },
      setChecked(c: boolean) {
        rec.checked = c;
        return item;
      },
      // Not in MenuItemLike. Present so the proxy is forced to forward methods
      // this module has never heard of — Obsidian's MenuItem has several.
      setSection(sec: string) {
        rec.section = sec;
        return item;
      },
    };
    this.realItems.push(item);
    cb(item);
    this.items.push(rec);
    return this;
  }

  showAtMouseEvent(...args: unknown[]): string {
    this.itemsAtShowTime = this.items.length;
    this.showArgs = args;
    return "shown-at-mouse";
  }

  showAtPosition(...args: unknown[]): string {
    this.itemsAtShowTime = this.items.length;
    this.showArgs = args;
    return "shown-at-position";
  }
}

/**
 * A fresh class per test: these tests mutate the prototype by design, and a
 * shared one would leak a patch from one test into the next.
 */
const fresh = (): { proto: MenuPrototype; menu: () => FakeMenu } => {
  class Menu extends FakeMenu {}
  // Own copies, so patching this subclass never touches FakeMenu itself.
  Menu.prototype.showAtMouseEvent = FakeMenu.prototype.showAtMouseEvent;
  Menu.prototype.showAtPosition = FakeMenu.prototype.showAtPosition;
  return {
    proto: Menu.prototype as unknown as MenuPrototype,
    // `new`, not `Object.create`: the latter skips the constructor, so the
    // field initialisers never run and `items` is undefined.
    menu: () => new Menu(),
  };
};

/** The row spaces injects. */
const restoreRow =
  (onClick: () => void = () => {}) =>
  (menu: MenuLike): void => {
    menu.addItem((i) => i.setTitle("Restore saved ordering").setIcon("rotate-ccw").onClick(onClick));
  };

/**
 * Collects the deferred restore so tests never need a timer.
 * `defer` returns a canceller, exactly as production's `clearTimeout` one does,
 * so a test can see whether the pending restore was cancelled.
 */
const collector = (): {
  defer: (fn: () => void) => () => void;
  run: () => void;
  pending: () => number;
  cancelled: () => number;
} => {
  const queued: (() => void)[] = [];
  let cancelled = 0;
  return {
    defer: (fn) => {
      queued.push(fn);
      return () => {
        cancelled++;
        const at = queued.indexOf(fn);
        if (at >= 0) queued.splice(at, 1);
      };
    },
    run: () => queued.splice(0).forEach((fn) => fn()),
    pending: () => queued.length,
    cancelled: () => cancelled,
  };
};

/**
 * Most of these tests are about the wrapper, not about which menu it picks;
 * the "menu identity" block below supplies a real check.
 */
const anyMenu = (): boolean => true;

/**
 * The `New space` row, the second caller of this module. It differs from the
 * sort menu in two ways worth pinning: it precedes its item with a separator,
 * and it supplies NEITHER `decorateHostItem` nor `onHostItemClick`, so the
 * host's own entries must be left entirely alone.
 */
describe("the New space row", () => {
  const newSpaceRow =
    (onClick: () => void = () => {}) =>
    (menu: MenuLike): void => {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("New space").setIcon("layers").onClick(onClick));
    };

  it("adds a separator and then the row", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: newSpaceRow(), defer });

    const menu = newMenu();
    menu.showAtMouseEvent({});

    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]).toMatchObject({ title: "New space", icon: "layers" });
    // Recorded at zero items, i.e. before the row: a separator added after it
    // would draw a line under the menu rather than above our entry.
    expect(menu.separatorsAfter).toEqual([0]);
  });

  it("leaves the host's own entries untouched", () => {
    // Obsidian's New note / New folder / New canvas / New base. With no
    // `decorateHostItem` and no `onHostItemClick`, `addItem` is never patched,
    // so the host keeps the very objects it created.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: newSpaceRow(), defer });

    const menu = newMenu();
    const seen: unknown[] = [];
    menu.addItem((i) => {
      seen.push(i);
      (i as { setTitle(t: string): unknown }).setTitle("New note");
    });
    menu.showAtMouseEvent({});

    expect(menu.realItems[0]).toBe(seen[0]);
    expect(menu.items.map((r) => r.title)).toEqual(["New note", "New space"]);
  });

  it("opens the create panel once when the row is chosen", () => {
    let opened = 0;
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: newSpaceRow(() => void opened++),
      defer,
    });

    const menu = newMenu();
    menu.showAtMouseEvent({});
    menu.items[0]?.click?.();

    expect(opened).toBe(1);
  });

  it("ignores a menu opened by a different gesture", () => {
    // Identity, not menu contents: the four entries Obsidian puts in this menu
    // are translated, so matching their text would break outside English.
    const gesture = {};
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: (showArgs) => showArgs[0] === gesture,
      buildRow: newSpaceRow(),
      defer,
    });

    const other = newMenu();
    other.showAtMouseEvent({});
    expect(other.items).toHaveLength(0);
    expect(other.separatorsAfter).toEqual([]);

    const ours = newMenu();
    ours.showAtMouseEvent(gesture);
    expect(ours.items.map((r) => r.title)).toEqual(["New space"]);
  });
});

describe("armMenuInjection", () => {
  it("adds the row to a menu shown after arming", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer });

    const menu = newMenu();
    menu.showAtMouseEvent({});

    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]).toMatchObject({ title: "Restore saved ordering", icon: "rotate-ccw" });
  });

  it("appends the row LAST, after the host's own items", () => {
    // Measured in the fixture: Obsidian's six sort items carry no `setSection`,
    // so insertion order is the only thing deciding position.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer });

    const menu = newMenu();
    menu.addItem((i) => (i as { setTitle(t: string): unknown }).setTitle("File name (A to Z)"));
    menu.showAtMouseEvent({});

    expect(menu.items.map((r) => r.title)).toEqual([
      "File name (A to Z)",
      "Restore saved ordering",
    ]);
  });

  it("injects BEFORE the original show runs, so the row is in the rendered menu", () => {
    // The spike measured that a post-hoc addItem on an already-shown menu does
    // not render. Injecting after the original would look right in the item
    // list and be invisible on screen.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer });

    const menu = newMenu();
    menu.showAtMouseEvent({});

    expect(menu.itemsAtShowTime).toBe(1);
  });

  it("restores both methods once a menu has been shown", () => {
    const { proto, menu: newMenu } = fresh();
    const before = { m: proto.showAtMouseEvent, p: proto.showAtPosition };
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer });

    newMenu().showAtMouseEvent({});

    expect(proto.showAtMouseEvent).toBe(before.m);
    expect(proto.showAtPosition).toBe(before.p);
  });

  it("restores on the deferred tick when the click opened no menu at all", () => {
    // Arming happens on a click. Not every click opens a menu, and a patch left
    // installed until the next one would be live across unrelated gestures.
    const { proto } = fresh();
    const before = proto.showAtMouseEvent;
    const c = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer: c.defer });

    expect(proto.showAtMouseEvent).not.toBe(before);
    c.run();

    expect(proto.showAtMouseEvent).toBe(before);
  });

  it("adds nothing to a SECOND menu shown after the first", () => {
    // The blast radius is one gesture. A file context menu opened straight
    // after the sort menu must be untouched.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer });

    newMenu().showAtMouseEvent({});
    const second = newMenu();
    second.showAtMouseEvent({});

    expect(second.items).toHaveLength(0);
  });

  it("goes inert rather than clobbering a patch installed on top of ours", () => {
    // Restoring unconditionally would delete another plugin's wrapper. Ours
    // stays in the chain, doing nothing.
    const { proto, menu: newMenu } = fresh();
    const c = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer: c.defer });
    const ourWrapper = proto.showAtMouseEvent;

    // Another plugin wraps what it finds — which is us — and calls through.
    let foreignCalls = 0;
    const foreign = function (this: FakeMenu, ...args: unknown[]): unknown {
      foreignCalls++;
      return (ourWrapper as (...a: unknown[]) => unknown).apply(this, args);
    };
    proto.showAtMouseEvent = foreign as MenuPrototype["showAtMouseEvent"];

    // The deferred restore fires while that patch sits on top of ours.
    c.run();

    // Theirs survives: restoring would have deleted it.
    expect(proto.showAtMouseEvent).toBe(foreign);

    const menu = newMenu();
    menu.showAtMouseEvent({});

    // Ours is still in the chain and still passes through — but adds nothing.
    expect(foreignCalls).toBe(1);
    expect(menu.items).toHaveLength(0);
    expect(menu.itemsAtShowTime).toBe(0);
  });

  it("injects on the showAtPosition path too", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer });

    const menu = newMenu();
    menu.showAtPosition({ x: 1, y: 2 });

    expect(menu.items).toHaveLength(1);
  });

  it("passes the arguments, receiver and return value straight through", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(), defer });

    const menu = newMenu();
    const evt = { clientX: 7 };
    const returned = menu.showAtMouseEvent(evt);

    expect(returned).toBe("shown-at-mouse");
    expect(menu.showArgs).toEqual([evt]);
  });

  it("still shows the menu when buildRow throws, and says so once", () => {
    // A broken row must never cost the user Obsidian's own sort menu: fail
    // open, but not in silence. The assertion on the log lives here
    // because the flag is once-per-SESSION and this is the first test in the
    // file to make `buildRow` throw.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const boom = vi.fn(() => {
      throw new Error("nope");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: boom, defer });

      const menu = newMenu();
      expect(() => menu.showAtMouseEvent({})).not.toThrow();
      expect(menu.itemsAtShowTime).toBe(0);
      expect(boom).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("carries the click handler the caller supplied", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const onClick = vi.fn();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: restoreRow(onClick), defer });

    const menu = newMenu();
    menu.showAtMouseEvent({});
    menu.items[0].click?.();

    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("armMenuInjection host-item decoration", () => {
  /** What the sort menu's own six items look like being added. */
  const hostItem = (title: string, checked: boolean) => (i: unknown): void => {
    const it = i as { setTitle(t: string): unknown; setChecked(c: boolean): unknown };
    it.setTitle(title);
    it.setChecked(checked);
  };

  const untick = (i: { setChecked(c: boolean): unknown }): void => {
    i.setChecked(false);
  };

  it("unticks every item the host adds while armed", () => {
    // The whole point: Obsidian ticks its own mode even while the saved order
    // is what renders. Exactly one item may end up ticked.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: (m) => m.addItem((i) => i.setTitle("Custom ordering").setChecked(true)),
      decorateHostItem: untick,
      defer,
    });

    const menu = newMenu();
    menu.addItem(hostItem("File name (A to Z)", true));
    menu.addItem(hostItem("File name (Z to A)", false));
    menu.showAtMouseEvent({});

    expect(menu.items.map((r) => [r.title, r.checked])).toEqual([
      ["File name (A to Z)", false],
      ["File name (Z to A)", false],
      ["Custom ordering", true],
    ]);
  });

  it("invokes the host's callback EXACTLY ONCE", () => {
    // The trap this design was rewritten to avoid. Reading a menu by calling
    // each caller's callback a second time runs any side effect in it twice;
    // decorating means wrapping the callback, not re-running it.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, decorateHostItem: untick, defer });

    const calls = vi.fn(hostItem("File name (A to Z)", true));
    const menu = newMenu();
    menu.addItem(calls);
    menu.showAtMouseEvent({});

    expect(calls).toHaveBeenCalledOnce();
  });

  it("does NOT decorate our own row", () => {
    // Ours goes in through the original addItem, so the untick cannot strip
    // the tick we just set on it.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: (m) => m.addItem((i) => i.setTitle("Custom ordering").setChecked(true)),
      decorateHostItem: untick,
      defer,
    });

    const menu = newMenu();
    menu.showAtMouseEvent({});

    expect(menu.items[0]).toMatchObject({ title: "Custom ordering", checked: true });
  });

  it("restores addItem along with the show methods", () => {
    const { proto, menu: newMenu } = fresh();
    const before = proto.addItem;
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, decorateHostItem: untick, defer });
    expect(proto.addItem).not.toBe(before);

    newMenu().showAtMouseEvent({});

    expect(proto.addItem).toBe(before);
  });

  it("leaves a LATER menu's items alone", () => {
    // A file context menu opened straight after must keep its own checkmarks.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, decorateHostItem: untick, defer });
    newMenu().showAtMouseEvent({});

    const second = newMenu();
    second.addItem(hostItem("Rename", true));
    second.showAtMouseEvent({});

    expect(second.items[0].checked).toBe(true);
  });

  it("still adds the item when the decorator throws", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: () => {},
      decorateHostItem: () => {
        throw new Error("nope");
      },
      defer,
    });

    const menu = newMenu();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      menu.addItem(hostItem("File name (A to Z)", true));
      // The decoration runs when the menu is recognised, not when the item is
      // added, so this is where a throwing decorator has to be survivable.
      expect(() => menu.showAtMouseEvent({})).not.toThrow();
      expect(menu.items).toHaveLength(1);
      expect(menu.items[0].title).toBe("File name (A to Z)");
      // Once per session; the first test in the file to trip this one.
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("stops decorating once inert, even when it cannot leave the chain", () => {
    // Found by ablation: removing the `live` guard in the addItem wrapper killed
    // no test. It is not dead code. When another plugin patches addItem over
    // ours, restore() cannot lift ours out — so without the guard it would keep
    // unticking items in every later menu, not just the sort menu.
    const { proto, menu: newMenu } = fresh();
    const c = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, decorateHostItem: untick, defer: c.defer });
    const ourAdd = proto.addItem;

    const foreign = function (this: unknown, ...a: unknown[]): unknown {
      return (ourAdd as (...x: unknown[]) => unknown).apply(this, a);
    };
    proto.addItem = foreign as MenuPrototype["addItem"];
    c.run();

    expect(proto.addItem).toBe(foreign);
    const later = newMenu();
    later.addItem(hostItem("Rename", true));

    expect(later.items[0].checked).toBe(true);
  });

  it("leaves addItem untouched when no decorator is supplied", () => {
    const { proto } = fresh();
    const before = proto.addItem;
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, defer });

    expect(proto.addItem).toBe(before);
  });
});

describe("armMenuInjection host-item clicks", () => {
  interface HostItem {
    setTitle(t: string): HostItem;
    setChecked(c: boolean): HostItem;
    setSection(s: string): HostItem;
    onClick(h: () => void): HostItem;
  }

  it("reports a click on a host item, after the host's own handler", () => {
    // Inferring "the user chose a sort" from the VALUE CHANGING would make
    // choosing the mode already in effect invisible, so that click would do
    // nothing. This is the positive signal that replaces the inference.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const order: string[] = [];
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: () => {},
      onHostItemClick: () => order.push("ours"),
      defer,
    });

    const menu = newMenu();
    menu.addItem((i) => (i as HostItem).onClick(() => order.push("host")));
    menu.showAtMouseEvent({});
    menu.items[0].click?.();

    // The host's handler must run first: it is what applies the sort mode.
    expect(order).toEqual(["host", "ours"]);
  });

  it("keeps chaining working through the proxy", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, onHostItemClick: () => {}, defer });

    const menu = newMenu();
    menu.addItem((i) => (i as HostItem).setTitle("File name (A to Z)").setChecked(true));
    menu.showAtMouseEvent({});

    expect(menu.items[0]).toMatchObject({ title: "File name (A to Z)", checked: true });
  });

  it("forwards methods this module does not know about", () => {
    // A proxy that only knew MenuItemLike would throw on anything else and
    // cost the user the whole menu.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, onHostItemClick: () => {}, defer });

    const menu = newMenu();
    expect(() => menu.addItem((i) => (i as HostItem).setSection("order"))).not.toThrow();

    expect(menu.items[0].section).toBe("order");
  });

  it("does NOT report a click on our own row", () => {
    // Ours restores the saved order; reporting it as a native sort gesture
    // would re-set the override the click just cleared.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const reported = vi.fn();
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: (m) => m.addItem((i) => i.setTitle("Custom ordering").onClick(() => {})),
      onHostItemClick: reported,
      defer,
    });

    const menu = newMenu();
    menu.showAtMouseEvent({});
    menu.items[0].click?.();

    expect(reported).not.toHaveBeenCalled();
  });

  it("does not report clicks in a LATER menu", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const reported = vi.fn();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, onHostItemClick: reported, defer });
    newMenu().showAtMouseEvent({});

    const second = newMenu();
    second.addItem((i) => (i as HostItem).onClick(() => {}));
    second.showAtMouseEvent({});
    second.items[0].click?.();

    expect(reported).not.toHaveBeenCalled();
  });

  it("still reports when the host handler throws, without swallowing it", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const reported = vi.fn();
    armMenuInjection({ proto, isIntendedMenu: anyMenu, buildRow: () => {}, onHostItemClick: reported, defer });

    const menu = newMenu();
    menu.addItem((i) =>
      (i as HostItem).onClick(() => {
        throw new Error("host blew up");
      })
    );
    menu.showAtMouseEvent({});

    // The host's failure propagates: swallowing it would hide a real Obsidian
    // bug behind a menu that silently did nothing.
    expect(() => menu.items[0].click?.()).toThrow("host blew up");
    expect(reported).toHaveBeenCalledOnce();
  });
});

/**
 * Scoping the arm to a GESTURE would act on whatever menu happened to appear
 * inside that macrotask. These tests are about the entry check that scopes it
 * to a MENU instead.
 */
describe("armMenuInjection menu identity", () => {
  /** Stands in for the click event Obsidian hands to `showAtMouseEvent`. */
  const gesture = { sortButtonClick: true };
  const isTheSortMenu = (showArgs: unknown[]): boolean => showArgs[0] === gesture;

  interface HostItem {
    setTitle(t: string): HostItem;
    setChecked(c: boolean): HostItem;
    onClick(h: () => void): HostItem;
  }

  const untick = (i: { setChecked(c: boolean): unknown }): void => {
    i.setChecked(false);
  };

  const nativeMode =
    (title: string, onClick: () => void = () => {}) =>
    (i: unknown): void => {
      (i as HostItem).setTitle(title).setChecked(true).onClick(onClick);
    };

  it("leaves a menu another plugin opened in the armed window completely alone", () => {
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const reported = vi.fn();
    armMenuInjection({
      proto,
      isIntendedMenu: isTheSortMenu,
      buildRow: restoreRow(),
      decorateHostItem: untick,
      onHostItemClick: reported,
      defer,
    });

    const foreign = newMenu();
    foreign.addItem(nativeMode("Pin to top"));
    foreign.showAtMouseEvent({ someOtherClick: true });
    foreign.items[0].click?.();

    // No row of ours, its own tick intact, and its click is not a sort gesture.
    expect(foreign.items.map((r) => r.title)).toEqual(["Pin to top"]);
    expect(foreign.items[0].checked).toBe(true);
    expect(reported).not.toHaveBeenCalled();
  });

  it("is still armed for the intended menu after a foreign one went past", () => {
    // Bailing must not consume the arm: the sort menu is the one that matters
    // and it may not be the first menu to open in the window.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: isTheSortMenu,
      buildRow: restoreRow(),
      decorateHostItem: untick,
      defer,
    });

    newMenu().showAtMouseEvent({ someOtherClick: true });

    const sortMenu = newMenu();
    sortMenu.addItem(nativeMode("File name (A to Z)"));
    sortMenu.showAtMouseEvent(gesture);

    expect(sortMenu.items.map((r) => [r.title, r.checked])).toEqual([
      ["File name (A to Z)", false],
      ["Restore saved ordering", undefined],
    ]);
  });

  it("hands the host its REAL item when no click reporting is asked for", () => {
    // The proxy is what breaks identity, so it may only appear where it is
    // needed. `decorateHostItem` alone must not summon one.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: isTheSortMenu,
      buildRow: restoreRow(),
      decorateHostItem: untick,
      defer,
    });

    const menu = newMenu();
    let handed: unknown;
    let firstRead: unknown;
    let secondRead: unknown;
    menu.addItem((i) => {
      handed = i;
      firstRead = (i as unknown as { setTitle: unknown }).setTitle;
      secondRead = (i as unknown as { setTitle: unknown }).setTitle;
      (i as HostItem).setTitle("File name (A to Z)");
    });
    menu.showAtMouseEvent(gesture);

    // A WeakMap lookup and a cached bound method both depend on these two.
    expect(handed).toBe(menu.realItems[0]);
    expect(firstRead).toBe(secondRead);
  });

  it("does not decorate a foreign menu's items even before it is shown", () => {
    // The decoration used to run inside `addItem`, where nothing yet says
    // which menu this is. It now waits for the identity check.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: isTheSortMenu,
      buildRow: restoreRow(),
      decorateHostItem: untick,
      defer,
    });

    const foreign = newMenu();
    foreign.addItem(nativeMode("Pin to top"));

    expect(foreign.items[0].checked).toBe(true);
  });

  it("leaves the menu alone when the identity check throws, and says so once", () => {
    // Fail CLOSED: a check that cannot answer must not be read as "yes".
    // The first test in this file to trip this catch, because the log is
    // once-per-session.
    const { proto, menu: newMenu } = fresh();
    const { defer } = collector();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      armMenuInjection({
        proto,
        isIntendedMenu: () => {
          throw new Error("nope");
        },
        buildRow: restoreRow(),
        defer,
      });

      const menu = newMenu();
      expect(() => menu.showAtMouseEvent(gesture)).not.toThrow();
      expect(menu.items).toHaveLength(0);
      expect(logged).toHaveBeenCalledOnce();

      // Once per session, not once per menu.
      newMenu().showAtMouseEvent(gesture);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("re-arming before the restore does not strand a wrapper", () => {
    // Two sort clicks in one macrotask. The second arming used to capture the
    // FIRST arming's wrapper as the original, so no restore could ever get
    // back to Obsidian's own method.
    const { proto, menu: newMenu } = fresh();
    const before = proto.showAtMouseEvent;
    const first = collector();
    const second = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: isTheSortMenu,
      buildRow: restoreRow(),
      defer: first.defer,
    });
    armMenuInjection({
      proto,
      isIntendedMenu: isTheSortMenu,
      buildRow: restoreRow(),
      defer: second.defer,
    });
    first.run();
    second.run();

    expect(proto.showAtMouseEvent).toBe(before);
    const menu = newMenu();
    menu.showAtMouseEvent(gesture);
    expect(menu.items).toHaveLength(0);
  });
});

/**
 * `defer` is a bare `window.setTimeout` in production — the one callback
 * in this plugin that no `Component` owns — and it is what puts a shared
 * prototype back. `onunload` has to be able to reach it.
 */
describe("cancelMenuInjection", () => {
  it("restores the prototype and cancels the pending restore", () => {
    const { proto, menu: newMenu } = fresh();
    const before = { m: proto.showAtMouseEvent, a: proto.addItem };
    const c = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: restoreRow(),
      decorateHostItem: (i) => void i.setChecked(false),
      defer: c.defer,
    });

    cancelMenuInjection();

    expect(proto.showAtMouseEvent).toBe(before.m);
    expect(proto.addItem).toBe(before.a);
    // The timer is cancelled, not merely left to fire into a dead arming.
    expect(c.cancelled()).toBe(1);
    expect(c.pending()).toBe(0);

    const menu = newMenu();
    menu.showAtMouseEvent({});
    expect(menu.items).toHaveLength(0);
  });

  it("is safe when nothing is armed, and when called twice", () => {
    const { proto } = fresh();
    const before = proto.showAtMouseEvent;
    const c = collector();
    expect(() => cancelMenuInjection()).not.toThrow();

    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: restoreRow(),
      defer: c.defer,
    });
    cancelMenuInjection();
    expect(() => cancelMenuInjection()).not.toThrow();

    expect(proto.showAtMouseEvent).toBe(before);
    expect(c.cancelled()).toBe(1);
  });

  it("leaves a foreign patch installed over ours alone, as restore() does", () => {
    // Unload must not delete another plugin's feature either. Ours goes inert.
    const { proto, menu: newMenu } = fresh();
    const c = collector();
    armMenuInjection({
      proto,
      isIntendedMenu: anyMenu,
      buildRow: restoreRow(),
      defer: c.defer,
    });
    const ourWrapper = proto.showAtMouseEvent;
    const foreign = function (this: FakeMenu, ...a: unknown[]): unknown {
      return (ourWrapper as (...x: unknown[]) => unknown).apply(this, a);
    };
    proto.showAtMouseEvent = foreign as MenuPrototype["showAtMouseEvent"];

    cancelMenuInjection();

    expect(proto.showAtMouseEvent).toBe(foreign);
    const menu = newMenu();
    menu.showAtMouseEvent({});
    expect(menu.items).toHaveLength(0);
  });
});
