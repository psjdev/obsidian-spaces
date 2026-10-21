// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripReveal } from "../src/ui/stripReveal";
import { CLS_STRIP_OPEN, CLS_STRIP_ZONE } from "../src/explorer/selectors";

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
const moveCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => c[0] === "mousemove");

beforeEach(() => {
  pane = document.createElement("div");
  strip = document.createElement("div");
  pane.appendChild(strip);
  document.body.appendChild(pane);
  reveal = new StripReveal({ pane, strip, stripRight: () => RIGHT });
});

afterEach(() => {
  reveal.destroy();
  pane.remove();
  vi.restoreAllMocks();
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

  it("held open stays open with no pointer movement, and release clears the hold", () => {
    reveal.attach();
    reveal.hold();
    expect(reveal.isOpen()).toBe(true);
    expect(reveal.isHeld()).toBe(true);
    reveal.release();
    expect(reveal.isHeld()).toBe(false);
    move(RIGHT + 100);
    expect(reveal.isOpen()).toBe(false);
  });

  it("a pointer move while held means the drag is over: the hold heals and the strip closes", () => {
    reveal.attach();
    dragEnter(zone()!);
    expect(reveal.isHeld()).toBe(true);
    move(RIGHT + 100);
    expect(reveal.isOpen()).toBe(false);
    expect(reveal.isHeld()).toBe(false);
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

  it("attaching twice leaves one zone and one set of listeners", () => {
    const stripAdd = vi.spyOn(strip, "addEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    reveal.attach();
    reveal.attach();
    expect(pane.querySelectorAll(`.${CLS_STRIP_ZONE}`)).toHaveLength(1);
    expect(stripAdd.mock.calls.filter((c) => c[0] === "mouseenter")).toHaveLength(1);
    expect(docAdd.mock.calls.filter((c) => c[0] === "mouseleave")).toHaveLength(1);
  });

  it("reads the strip's right edge on every event, not once", () => {
    let edge = RIGHT;
    reveal.destroy();
    reveal = new StripReveal({ pane, strip, stripRight: () => edge });
    reveal.attach();
    leaveDoc(100);
    expect(reveal.isOpen()).toBe(false);
    edge = 200; // the strip slid out further
    leaveDoc(100);
    expect(reveal.isOpen()).toBe(true);
    move(150);
    expect(reveal.isOpen()).toBe(true);
    edge = 50; // and back
    move(150);
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

  it("holds open until released when no pointer moves arrive", () => {
    reveal.attach();
    dragEnter(zone()!);
    expect(reveal.isOpen()).toBe(true);
    expect(reveal.isHeld()).toBe(true);
    reveal.release();
    expect(reveal.isHeld()).toBe(false);
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
