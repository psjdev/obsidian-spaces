/**
 * Globals Obsidian's Chromium has and jsdom does not.
 *
 * Loaded for every test file. Without this the jsdom suites throw asynchronously
 * inside event handlers, where Vitest reports the failure as an unhandled error
 * rather than a failing test, so the tests stay green while the handler under
 * test dies half way through. Two keyboard tests sat in that state.
 *
 * Only genuine environment gaps belong here. Anything modelling Obsidian's own
 * API belongs in `obsidian-stub.ts`.
 */

/**
 * The backslash, built from its code point.
 *
 * Deliberate: the first version of this file used a `"$&"` replacement string
 * and shipped one backslash too few, which JavaScript reads as the identity
 * replacement. It escaped nothing while claiming in a comment that it did, and
 * no test noticed because the paths the suites use need no escaping. Keeping
 * backslashes out of the source removes that whole class of mistake.
 */
const BACKSLASH = String.fromCharCode(92);

/** Anything outside an unescaped CSS identifier. Over-escaping is still valid. */
const UNSAFE = /[^a-zA-Z0-9_-]/g;

// `CSS.escape` is a Web Platform API jsdom does not implement.
if (typeof globalThis.CSS === "undefined") {
  (globalThis as { CSS?: unknown }).CSS = {};
}
const css = globalThis.CSS as { escape?: (v: string) => string };
css.escape ??= (value: string): string =>
  String(value).replace(UNSAFE, (ch) => BACKSLASH + ch);

/**
 * `ResizeObserver` is another Web Platform API jsdom does not implement. The
 * strip watches its pane with one, to catch the zoom and theme changes that
 * move the pane's rows without causing a render.
 *
 * A stub that never fires is the honest model, not a shortcut: jsdom performs
 * no layout, so no element in a test can ever actually be resized. It exists
 * so `mount()` can construct one -- guarding the real call site instead would
 * put a branch in production code that Obsidian's Chromium can never take.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= NoopResizeObserver;

/**
 * `appendText` is Obsidian's own extension to `Node` (obsidian.d.ts:55), not a
 * Web Platform method, so jsdom has nothing by that name.
 *
 * Declarative settings build their descriptions into a `DocumentFragment` with
 * it, which means a tab that merely ASKS for its definitions throws here
 * without this -- long before anything renders.
 *
 * Guarded on `Node` existing at all: this file is a setup file for every test,
 * including the ones that run under the node environment with no DOM.
 */
if (typeof Node !== "undefined") {
  const proto = Node.prototype as Node & { appendText?: (val: string) => void };
  proto.appendText ??= function (this: Node, val: string): void {
    this.appendChild(this.ownerDocument?.createTextNode(val) ?? document.createTextNode(val));
  };
}
