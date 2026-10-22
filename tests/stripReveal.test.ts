// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripReveal } from "../src/ui/stripReveal";
import { CLS_STRIP_FOCUS, CLS_STRIP_OPEN, CLS_STRIP_ZONE } from "../src/explorer/selectors";
import { installObsidianDom } from "./helpers/obsidianDom";

/**
 * The strip's right edge: the lip's while it is closed, and the settled one
 * when it is open. The two are the same number here so that every test that
 * is not about the difference reads as it did before the suppliers were
 * split; `the close threshold` below is the one that pulls them apart.
 */
const RIGHT = 38;

let pane: HTMLElement;
let strip: HTMLElement;
let reveal: StripReveal;

const zone = () => pane.querySelector<HTMLElement>(`.${CLS_STRIP_ZONE}`);
const enter = (el: Element) => el.dispatchEvent(new MouseEvent("mouseenter"));
const dragEnter = (el: Element) => el.dispatchEvent(new Event("dragenter", { bubbles: true }));
const move = (clientX: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX }));
const leaveDoc = (clientX: number) =>
  document.dispatchEvent(new MouseEvent("mouseleave", { clientX }));
const leavePane = (clientX: number) =>
  pane.dispatchEvent(new MouseEvent("mouseleave", { clientX }));
const moveCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => c[0] === "mousemove");
const focused = () => pane.classList.contains(CLS_STRIP_FOCUS);
/**
 * jsdom's `:focus-visible` matches any focused element, because nwsapi has no
 * keyboard-versus-mouse heuristic. So these dispatch `focusin` at a control
 * and vary only whether it is focused, which is the part jsdom can answer.
 * The keyboard/mouse half is Chromium's and was confirmed by hand.
 */
const focusIn = (el: Element) =>
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
const focusOut = (el: Element, relatedTarget: Element | null) =>
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget }));

beforeEach(() => {
  pane = document.createElement("div");
  strip = document.createElement("div");
  pane.appendChild(strip);
  document.body.appendChild(pane);
  reveal = new StripReveal({ pane, strip, lipRight: () => RIGHT, openRight: () => RIGHT });
});

afterEach(() => {
  reveal.destroy();
  pane.remove();
  vi.restoreAllMocks();
});

describe("StripReveal keyboard focus", () => {
  let control: HTMLButtonElement;
  let other: HTMLButtonElement;

  beforeEach(() => {
    control = document.createElement("button");
    other = document.createElement("button");
    strip.appendChild(control);
    strip.appendChild(other);
    reveal.attach();
  });

  it("reveals when a control inside the strip takes keyboard focus", () => {
    control.focus();
    focusIn(control);
    expect(focused()).toBe(true);
  });

  it("reveals by a class, never by a :has() selector in the stylesheet", () => {
    // The whole point of the change: `:has()` forces the browser to re-check
    // every matching ancestor whenever anything inside it changes, which the
    // Obsidian plugin scan flags. The class costs one `focusin`.
    control.focus();
    focusIn(control);
    expect(pane.className).toContain(CLS_STRIP_FOCUS);
  });

  it("does not reveal when the focused element is not :focus-visible", () => {
    // Nothing focused, so `matches(":focus-visible")` is false even in jsdom.
    // This is the mouse-click case in Chromium: clicking a space focuses its
    // icon without making it focus-visible, and revealing on that was the
    // stuck-open defect.
    focusIn(control);
    expect(focused()).toBe(false);
  });

  it("keeps the reveal while focus moves between controls inside the strip", () => {
    control.focus();
    focusIn(control);
    focusOut(control, other);
    expect(focused()).toBe(true);
  });

  it("drops the reveal when focus leaves the strip entirely", () => {
    control.focus();
    focusIn(control);
    focusOut(control, null);
    expect(focused()).toBe(false);
  });

  it("drops the reveal when focus moves to something outside the strip", () => {
    const outside = document.createElement("button");
    pane.appendChild(outside);
    control.focus();
    focusIn(control);
    focusOut(control, outside);
    expect(focused()).toBe(false);
  });

  it("attaches no pointer-move listener for a keyboard reveal", () => {
    // A strip held out by focus must not be closable by a pointer crossing
    // it; only blur closes that one.
    const add = vi.spyOn(window, "addEventListener");
    control.focus();
    focusIn(control);
    expect(moveCalls(add)).toHaveLength(0);
    expect(reveal.isOpen()).toBe(false);
  });

  it("clears the focus class on destroy, because the pane outlives it", () => {
    control.focus();
    focusIn(control);
    reveal.destroy();
    expect(focused()).toBe(false);
  });

  it("stops answering focus events after destroy", () => {
    reveal.destroy();
    control.focus();
    focusIn(control);
    expect(focused()).toBe(false);
  });
});

describe("StripReveal", () => {
  it("binds no pointer-move listener while closed", () => {
    const add = vi.spyOn(window, "addEventListener");
    reveal.attach();
    expect(moveCalls(add)).toHaveLength(0);
    expect(reveal.isOpen()).toBe(false);
  });

  it("creates the zone as a direct child of the pane", () => {
    reveal.attach();
    expect(zone()?.parentElement).toBe(pane);
  });

  it("opens when the pointer enters the zone", () => {
    reveal.attach();
    enter(zone()!);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("opens when the pointer enters the strip itself", () => {
    reveal.attach();
    enter(strip);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("opens when the pointer leaves the document left of the strip", () => {
    reveal.attach();
    leaveDoc(0);
    expect(reveal.isOpen()).toBe(true);
  });

  it("does not open when the pointer leaves the document right of the strip", () => {
    reveal.attach();
    leaveDoc(RIGHT + 200);
    expect(reveal.isOpen()).toBe(false);
  });

  it("opens when the pointer leaves the pane left of the lip", () => {
    reveal.attach();
    leavePane(10);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("does not open when the pointer leaves the pane to the right of the lip", () => {
    reveal.attach();
    leavePane(RIGHT + 1);
    expect(reveal.isOpen()).toBe(false);
  });

  it("destroy removes the pane mouseleave handler", () => {
    const add = vi.spyOn(pane, "addEventListener");
    const remove = vi.spyOn(pane, "removeEventListener");
    reveal.attach();
    const added = add.mock.calls.filter((c) => c[0] === "mouseleave").map((c) => c[1]);
    expect(added).toHaveLength(1);
    reveal.destroy();
    expect(remove.mock.calls.filter((c) => c[0] === "mouseleave").map((c) => c[1])).toEqual(added);
    leavePane(0);
    expect(reveal.isOpen()).toBe(false);
  });

  it("stays open while the pointer is left of the strip's right edge", () => {
    reveal.attach();
    enter(zone()!);
    move(5);
    move(RIGHT);
    expect(reveal.isOpen()).toBe(true);
  });

  it("closes as soon as the pointer passes the strip's right edge", () => {
    reveal.attach();
    enter(zone()!);
    move(RIGHT + 1);
    expect(reveal.isOpen()).toBe(false);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(false);
  });

  it("binds the pointer-move listener on open and removes it when it closes", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    reveal.attach();
    enter(zone()!);
    expect(moveCalls(add)).toHaveLength(1);
    move(RIGHT + 1);
    expect(moveCalls(remove)).toHaveLength(1);
    expect(moveCalls(remove)[0][1]).toBe(moveCalls(add)[0][1]);
  });

  it("does not stack listeners when entered twice", () => {
    const add = vi.spyOn(window, "addEventListener");
    reveal.attach();
    enter(zone()!);
    enter(strip);
    expect(moveCalls(add)).toHaveLength(1);
  });

  it("a drag reveal closes on the first pointer move past the edge", () => {
    // Nothing holds the strip open for the drag's duration, and nothing has
    // to: a native drag fires no `mousemove`, so the first one to arrive is
    // already after the drag, however it ended and whether or not its end
    // events reached us. An OS-originated drag sends none.
    reveal.attach();
    dragEnter(zone()!);
    expect(reveal.isOpen()).toBe(true);
    move(RIGHT + 100);
    expect(reveal.isOpen()).toBe(false);
  });

  it("destroy removes the zone and every listener", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    reveal.attach();
    const z = zone()!;
    enter(z);
    reveal.destroy();
    expect(zone()).toBeNull();
    expect(moveCalls(remove)).toHaveLength(1);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(false);
    // Nothing reacts any more.
    enter(z);
    enter(strip);
    leaveDoc(0);
    expect(reveal.isOpen()).toBe(false);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(false);
  });

  it("destroy removes the very handlers attach registered, on the strip and the document", () => {
    // Assert the teardown itself: the `show()` guard would hide a missing
    // removal if we only checked what the controller does afterwards.
    const handlers = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((c) => c[0] === type).map((c) => c[1]);
    const stripAdd = vi.spyOn(strip, "addEventListener");
    const stripRemove = vi.spyOn(strip, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    reveal.attach();
    const stripAdded = handlers(stripAdd, "mouseenter");
    const docAdded = handlers(docAdd, "mouseleave");
    expect(stripAdded).toHaveLength(1);
    expect(docAdded).toHaveLength(1);
    reveal.destroy();
    expect(handlers(stripRemove, "mouseenter")).toEqual(stripAdded);
    expect(handlers(docRemove, "mouseleave")).toEqual(docAdded);
  });

  it("destroy removes the strip's dragenter handler, by identity", () => {
    // The strip OUTLIVES this call -- only the zone goes with it -- so a
    // missing removal here leaves a live listener on an element that stays in
    // the pane. Asserted against the handler `attach()` registered, because
    // behaviour after `destroy()` proves nothing: `show()` returns early once
    // `win` is null, so the strip looks shut either way.
    const handlers = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((c) => c[0] === type).map((c) => c[1]);
    const add = vi.spyOn(strip, "addEventListener");
    const remove = vi.spyOn(strip, "removeEventListener");
    reveal.attach();
    const added = handlers(add, "dragenter");
    expect(added).toHaveLength(1);
    reveal.destroy();
    expect(handlers(remove, "dragenter")).toEqual(added);
  });

  it("destroy removes both of the zone's handlers, by identity", () => {
    // The zone is taken out of the DOM in the same call, so these removals are
    // discipline rather than a leak fix -- which is exactly why nothing caught
    // their deletion. The identities come off the STRIP's add calls: one
    // `onEnter` and one `onDragEnter` are shared with the zone, so this
    // asserts the zone was handed back the same two functions.
    const handlers = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter((c) => c[0] === type).map((c) => c[1]);
    const stripAdd = vi.spyOn(strip, "addEventListener");
    reveal.attach();
    const zoneRemove = vi.spyOn(zone()!, "removeEventListener");
    const enterHandler = handlers(stripAdd, "mouseenter");
    const dragHandler = handlers(stripAdd, "dragenter");
    expect(enterHandler).toHaveLength(1);
    expect(dragHandler).toHaveLength(1);
    reveal.destroy();
    expect(handlers(zoneRemove, "mouseenter")).toEqual(enterHandler);
    expect(handlers(zoneRemove, "dragenter")).toEqual(dragHandler);
  });

  it("attaching twice leaves one zone and one set of listeners", () => {
    const stripAdd = vi.spyOn(strip, "addEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    reveal.attach();
    reveal.attach();
    expect(pane.querySelectorAll(`.${CLS_STRIP_ZONE}`)).toHaveLength(1);
    expect(stripAdd.mock.calls.filter((c) => c[0] === "mouseenter")).toHaveLength(1);
    expect(docAdd.mock.calls.filter((c) => c[0] === "mouseleave")).toHaveLength(1);
  });

  it("reads both edges on every event, not once", () => {
    let lip = RIGHT;
    let settled = RIGHT;
    reveal.destroy();
    reveal = new StripReveal({ pane, strip, lipRight: () => lip, openRight: () => settled });
    reveal.attach();
    leaveDoc(100);
    expect(reveal.isOpen()).toBe(false);
    lip = 200; // a pane that has moved right, so the lip is further over
    leaveDoc(100);
    expect(reveal.isOpen()).toBe(true);
    settled = 200;
    move(150);
    expect(reveal.isOpen()).toBe(true);
    settled = 50; // and back
    move(150);
    expect(reveal.isOpen()).toBe(false);
  });

  it("does not close under a pointer inside the strip while the reveal animates", () => {
    // Measured in the running app: the painted right edge runs
    // 50, 57, 63, 69, 74, 78, 81, 82 over about 111ms while the strip slides
    // out. A pointer at x=70 is inside the settled bounds for every one of
    // those samples, and comparing it against the painted edge closed the
    // strip under the user for the first four.
    const painted = [50, 57, 63, 69, 74, 78, 81, 82];
    let frame = 0;
    const SETTLED = 82;
    reveal.destroy();
    reveal = new StripReveal({
      pane,
      strip,
      lipRight: () => painted[frame],
      openRight: () => SETTLED,
    });
    reveal.attach();
    enter(strip);
    expect(reveal.isOpen()).toBe(true);
    for (frame = 0; frame < painted.length; frame++) {
      move(70);
      expect(reveal.isOpen(), `painted edge at ${painted[frame]}`).toBe(true);
    }
    // The settled edge still closes it, which is the rule the README states.
    move(SETTLED + 1);
    expect(reveal.isOpen()).toBe(false);
  });

  it("opens when a drag enters the zone", () => {
    reveal.attach();
    dragEnter(zone()!);
    expect(reveal.isOpen()).toBe(true);
    expect(pane.classList.contains(CLS_STRIP_OPEN)).toBe(true);
  });

  it("opens when a drag enters the strip", () => {
    reveal.attach();
    dragEnter(strip);
    expect(reveal.isOpen()).toBe(true);
  });

  it("destroy removes the dragenter handlers", () => {
    reveal.attach();
    const z = zone()!;
    reveal.destroy();
    dragEnter(z);
    dragEnter(strip);
    expect(reveal.isOpen()).toBe(false);
  });

  it("destroy is idempotent", () => {
    reveal.attach();
    reveal.destroy();
    expect(() => reveal.destroy()).not.toThrow();
  });
});

describe("StripReveal in a popped-out window", () => {
  // `attach()` reads `pane.ownerDocument` and `doc.defaultView` rather than
  // the bundle's globals, because Obsidian's explorer can live in a popout,
  // whose document and window are different objects. Both reads could be
  // replaced with the bare globals and the suite stayed green: in a one-window
  // test the two are the same object, so nothing could tell them apart.
  //
  // An iframe, not `document.implementation.createHTMLDocument`: only an
  // iframe has a window of its own, which is the property a popout has too.
  // The harness patches Obsidian's DOM helpers onto it the way Obsidian
  // patches every window it opens -- `attach()` calls `pane.createDiv`.
  let frame: HTMLIFrameElement;
  let farDoc: Document;
  /** A popout window. `MouseEvent` is on it at runtime; `lib.dom` declares the
   * constructors on `Window & typeof globalThis` only. */
  let farWin: Window & { MouseEvent: typeof MouseEvent };
  let farPane: HTMLElement;
  let farStrip: HTMLElement;
  let far: StripReveal;

  beforeEach(() => {
    frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    if (!win) throw new Error("the iframe has no window");
    farWin = win as Window & { MouseEvent: typeof MouseEvent };
    farDoc = win.document;
    installObsidianDom(farWin as unknown as Parameters<typeof installObsidianDom>[0]);
    farPane = farDoc.createElement("div");
    farStrip = farDoc.createElement("div");
    farPane.appendChild(farStrip);
    farDoc.body.appendChild(farPane);
    far = new StripReveal({
      pane: farPane,
      strip: farStrip,
      lipRight: () => RIGHT,
      openRight: () => RIGHT,
    });
  });

  afterEach(() => {
    far.destroy();
    frame.remove();
  });

  it("binds the leave listener to the pane's own document, not this one", () => {
    const farAdd = vi.spyOn(farDoc, "addEventListener");
    const hereAdd = vi.spyOn(document, "addEventListener");
    far.attach();
    expect(farAdd.mock.calls.filter((c) => c[0] === "mouseleave")).toHaveLength(1);
    expect(hereAdd.mock.calls.filter((c) => c[0] === "mouseleave")).toHaveLength(0);
    // And it is live: a leave in that document opens the strip in that pane.
    farDoc.dispatchEvent(new farWin.MouseEvent("mouseleave", { clientX: 0 }));
    expect(far.isOpen()).toBe(true);
  });

  it("binds the move watcher to the pane's own window, not this one", () => {
    const farAdd = vi.spyOn(farWin, "addEventListener");
    const hereAdd = vi.spyOn(window, "addEventListener");
    far.attach();
    farStrip.dispatchEvent(new farWin.MouseEvent("mouseenter"));
    expect(far.isOpen()).toBe(true);
    expect(farAdd.mock.calls.filter((c) => c[0] === "mousemove")).toHaveLength(1);
    expect(hereAdd.mock.calls.filter((c) => c[0] === "mousemove")).toHaveLength(0);
    // A move in THIS window is not the pointer in that one.
    move(RIGHT + 100);
    expect(far.isOpen()).toBe(true);
    farWin.dispatchEvent(new farWin.MouseEvent("mousemove", { clientX: RIGHT + 100 }));
    expect(far.isOpen()).toBe(false);
  });

  it("builds the zone with the pane's own document", () => {
    // Which document BUILT it, not which one owns it now. The first version of
    // this test asked `zone.ownerDocument`, and it passed with the zone built
    // by `document.createElement`: `appendChild` adopts a node from another
    // document, so by the time the test looks, the answer is the same either
    // way. Found by ablation, recorded so it is not written again.
    const farCreate = vi.spyOn(farDoc, "createElement");
    const hereCreate = vi.spyOn(document, "createElement");
    far.attach();
    expect(farCreate.mock.calls.map((c) => c[0])).toContain("div");
    expect(hereCreate.mock.calls.map((c) => c[0])).not.toContain("div");
    expect(farPane.querySelector(`.${CLS_STRIP_ZONE}`)).not.toBeNull();
    expect(document.querySelector(`.${CLS_STRIP_ZONE}`)).toBeNull();
  });
});
