// @vitest-environment jsdom
/**
 * `styles.css` depends on the same DOM shape as `selectors.ts` and cannot
 * import it — `selectors.ts` says so in a comment, and that comment has been
 * the only thing holding the two together. These tests make the coupling
 * executable for the two rules where getting it wrong is invisible in
 * development and obvious to a user:
 *
 *  - **The switch mask** hides `.nav-files-container` while a space switch
 *    rebuilds the explorer. Unscoped, it hides EVERY container with that
 *    class in the window, not only the file explorer's — a class other
 *    views and plugins use to look native.
 *  - **The custom-color delete badge** appears on `:hover` /
 *    `:focus-visible` only, so on a touch device there is no way to reach it
 *    at all.
 *  - **The folder-space elsewhere group's boundary**: `CLS_ELSEWHERE` must
 *    land on the `.tree-item` wrapper, matching `SEL.rowWrapper`'s
 *    convention, or the border it draws lands on the wrong box.
 *
 * Layer: these read the stylesheet and ask the DOM whether a SELECTOR matches,
 * which jsdom answers correctly (nwsapi). They deliberately do NOT assert
 * computed style: jsdom does not compute the cascade, and anything about a
 * painted result is a Layer 4 `dev:css` question.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CLS_ELSEWHERE, SEL } from "../src/explorer/selectors";

// `process.cwd()` rather than `import.meta.url`: under the jsdom environment
// the module URL is an http one and `fileURLToPath` refuses it. Vitest runs
// with the project root as the working directory.
const CSS = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");

/**
 * Selector texts of every top-level rule, and of every rule nested in an
 * `@media`, paired with the condition it sits under (`""` for top level).
 *
 * Parsed with the browser's own CSSOM rather than a regex: jsdom implements
 * `CSSStyleSheet`, so what is read here is what a parser sees.
 */
interface Rule {
  media: string;
  selector: string;
}

let rules: Rule[] = [];

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const sheet = style.sheet;
  if (!sheet) throw new Error("jsdom did not parse styles.css");
  const out: Rule[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule instanceof CSSMediaRule) {
      for (const inner of Array.from(rule.cssRules)) {
        if (inner instanceof CSSStyleRule) {
          out.push({ media: rule.conditionText ?? rule.media.mediaText, selector: inner.selectorText });
        }
      }
    } else if (rule instanceof CSSStyleRule) {
      out.push({ media: "", selector: rule.selectorText });
    }
  }
  rules = out;
  style.remove();
});

/** Every selector mentioning `needle`, whatever it is nested in. */
function selectorsFor(needle: string): Rule[] {
  return rules.filter((r) => r.selector.includes(needle));
}

describe("styles.css — the switch mask is the FILE explorer's", () => {
  function paneWith(dataType: string): HTMLElement {
    const pane = document.createElement("div");
    pane.className = "workspace-leaf-content";
    pane.setAttribute("data-type", dataType);
    const container = document.createElement("div");
    container.className = SEL.container.slice(1);
    pane.appendChild(container);
    return container;
  }

  let mask: Rule[];
  let ours: HTMLElement;
  let alsoOurs: HTMLElement;
  let theirs: HTMLElement;

  beforeAll(() => {
    mask = selectorsFor("spaces-switching");
    document.body.className = "spaces-switching";
    ours = paneWith("file-explorer");
    // Spaces binds, patches and filters EVERY file-explorer leaf in
    // the main window, so a second one is the normal case, not an exotic one.
    alsoOurs = paneWith("file-explorer");
    theirs = paneWith("some-other-plugin-view");
    document.body.replaceChildren(
      ours.parentElement!,
      alsoOurs.parentElement!,
      theirs.parentElement!
    );
  });

  it("has exactly one masking rule to reason about", () => {
    expect(mask).toHaveLength(1);
  });

  it("hides the file explorer's own tree while a switch is in flight", () => {
    expect(ours.matches(mask[0]!.selector)).toBe(true);
  });

  it("masks EVERY file-explorer tree, not just the first", () => {
    // The narrowing here is by pane TYPE, never by count.
    // A `:first-of-type`, or any rule written against a single element, would
    // put the switch flash back in the second explorer pane — which is why
    // the rule is a descendant combinator under the pane type and not an
    // identity.
    expect(alsoOurs.matches(mask[0]!.selector)).toBe(true);
  });

  it("leaves another view's .nav-files-container alone", () => {
    // The mask exists because Obsidian repaints the explorer's tree
    // unfiltered for ~43ms. Nothing about that says a bookmarks pane, or
    // another plugin's nav-shaped view, should blank at the same moment.
    expect(theirs.matches(mask[0]!.selector)).toBe(false);
  });
});

describe("styles.css — custom-color removal is reachable without hover", () => {
  it("reveals the delete badge on a pointer that cannot hover", () => {
    // The badge is `display: none` until `:hover`/`:focus-visible`. A touch
    // device produces neither on the way to a tap, so the badge was
    // unreachable and a custom color could never be deleted there.
    const reveal = selectorsFor("spaces-color-remove").filter((r) =>
      /hover:\s*none/.test(r.media)
    );
    expect(reveal.length).toBeGreaterThan(0);
    const badge = document.createElement("div");
    badge.className = "spaces-color-remove";
    const cell = document.createElement("div");
    cell.className = "spaces-color-cell";
    cell.appendChild(badge);
    document.body.replaceChildren(cell);
    // Reachable with no hover and no focus anywhere in the chain.
    expect(reveal.some((r) => badge.matches(r.selector))).toBe(true);
  });

  it("gives the switcher icons a coarse-pointer target size", () => {
    // ~44px is the guideline; the icons are 28px, which is deliberate density
    // on a desktop pointer and simply too small for a finger. Scoped to
    // `pointer: coarse` so the desktop strip is untouched.
    const grown = selectorsFor("spaces-switcher-item").filter((r) =>
      /pointer:\s*coarse/.test(r.media)
    );
    expect(grown.length).toBeGreaterThan(0);
  });
});

describe("styles.css — the elsewhere group's boundary", () => {
  it("has a rule for CLS_ELSEWHERE", () => {
    expect(selectorsFor(CLS_ELSEWHERE).length).toBeGreaterThan(0);
  });

  it("draws the border on the .tree-item wrapper, not on .tree-item-self", () => {
    // Unlike the scaffold/visitor de-emphasis pair (`> .tree-item-self`), a
    // border/margin/padding does not cascade into the subtree, so there is
    // nothing here for `> .tree-item-self` to protect — and `SEL.rowWrapper`
    // is what `ExplorerAdapter` actually classes (selectors.ts's coupling
    // comment). A rule scoped to the title element instead would silently
    // draw the border in the wrong place.
    const rules = selectorsFor(CLS_ELSEWHERE);
    const wrapper = document.createElement("div");
    wrapper.className = `${SEL.rowWrapper.slice(1)} ${CLS_ELSEWHERE}`;
    const title = document.createElement("div");
    title.className = "tree-item-self";
    wrapper.appendChild(title);
    expect(rules.some((r) => wrapper.matches(r.selector))).toBe(true);
    expect(rules.some((r) => title.matches(r.selector))).toBe(false);
  });
});
