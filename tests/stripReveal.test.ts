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

  it("held open ignores the pointer until released", () => {
    reveal.attach();
    reveal.hold();
    expect(reveal.isOpen()).toBe(true);
    move(RIGHT + 100);
    expect(reveal.isOpen()).toBe(true);
    reveal.release();
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

  it("destroy is idempotent", () => {
    reveal.attach();
    reveal.destroy();
    expect(() => reveal.destroy()).not.toThrow();
  });
});
