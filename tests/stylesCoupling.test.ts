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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as selectors from "../src/explorer/selectors";
import { CLS, CLS_ELSEWHERE, SEL, UNSTYLED_CLASSES } from "../src/explorer/selectors";
import { LABEL_ROLES } from "../src/ui/compactLabel";
import { applyCompactLabels } from "../src/explorer/ExplorerAdapter";
import { buildChainIndex } from "../src/visibility/compactChains";

const COMPACT_TREE = {
  visibleChildrenOf: (p: string) =>
    p === "Work" ? ["Work/Clients"] : p === "Work/Clients" ? ["Work/Clients/a.md"] : [],
  isFolder: (p: string) => p === "Work" || p === "Work/Clients",
  isScaffold: (p: string) => p === "Work" || p === "Work/Clients",
  parentOf: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
  nameOf: (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
};
const INDEX = buildChainIndex(["Work"], COMPACT_TREE);
/** The whole joined path, which is what a two-folder run always draws. */
const PLAIN_LABEL = { abbreviateWhenOverflowing: false };

/**
 * A run of four folders, drawn SHORTENED below by telling the pass the row
 * does not fit, so the `gap` span is actually rendered and the stylesheet's
 * reach for it can be asserted against the real nesting rather than against a
 * hand-built span.
 */
const DEEP_CHAIN = ["A", "A/B", "A/B/C", "A/B/C/D"];
const DEEP_TREE = {
  visibleChildrenOf: (p: string) => {
    const i = DEEP_CHAIN.indexOf(p);
    if (i >= 0 && i < DEEP_CHAIN.length - 1) return [DEEP_CHAIN[i + 1]];
    if (p === "A/B/C/D") return ["A/B/C/D/a.md"];
    return [];
  },
  isFolder: (p: string) => DEEP_CHAIN.includes(p),
  isScaffold: (p: string) => DEEP_CHAIN.includes(p),
  parentOf: COMPACT_TREE.parentOf,
  nameOf: COMPACT_TREE.nameOf,
};
const DEEP_INDEX = buildChainIndex(DEEP_CHAIN, DEEP_TREE);

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
  style: CSSStyleDeclaration;
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
          out.push({ media: rule.conditionText ?? rule.media.mediaText, selector: inner.selectorText, style: inner.style });
        }
      }
    } else if (rule instanceof CSSStyleRule) {
      out.push({ media: "", selector: rule.selectorText, style: rule.style });
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

describe("styles.css — the hidden strip only hides where it can be revealed", () => {
  it("applies every hidden-strip rule inside a (hover: hover) block", () => {
    const hidden = selectorsFor("spaces-strip-hidden");
    expect(hidden.length).toBeGreaterThan(0);
    for (const r of hidden) expect(r.media.replace(/\s+/g, "")).toBe("(hover:hover)");
  });

  it("narrows the pane and slides the strip, opaquely, in the hover block", () => {
    const pane = selectorsFor(".spaces-strip-hidden").find((r) => r.style.getPropertyValue("padding-left") === "6px");
    expect(pane).toBeDefined();
    const strip = selectorsFor("spaces-strip-hidden > .spaces-switcher").find((r) =>
      r.style.getPropertyValue("transform").includes("translateX")
    );
    expect(strip?.style.getPropertyValue("transform")).toBe("translateX(calc(-100% + 6px))");
    expect(strip?.style.getPropertyValue("background")).toBe("var(--background-secondary)");
  });

  it("reveals on the open class and on focus within", () => {
    const open = selectorsFor("spaces-strip-open");
    expect(open.some((r) => r.style.getPropertyValue("transform") === "translateX(0)")).toBe(true);
    expect(selectorsFor(":focus-within").some((r) => r.selector.includes("spaces-strip-hidden"))).toBe(true);
  });
});

describe("styles.css — hiding the strip is purely visual", () => {
  // The principle: hidden is one `transform`. A hidden strip stays in the tab
  // order and the accessibility tree, and focusing into it reveals it.
  const FORBIDDEN = ["display", "visibility", "opacity", "pointer-events", "content-visibility"];

  it("never uses display, visibility or the like in a hidden-strip rule", () => {
    const hidden = selectorsFor("spaces-strip-hidden");
    expect(hidden.length).toBeGreaterThan(0);
    for (const r of hidden) {
      for (const prop of FORBIDDEN) {
        expect(r.style.getPropertyValue(prop), `${prop} in ${r.selector}`).toBe("");
      }
    }
  });

  it("never keys a hidden-strip rule on aria-hidden, tabindex or inert", () => {
    const hidden = selectorsFor("spaces-strip-hidden");
    expect(hidden.length).toBeGreaterThan(0);
    for (const r of hidden) {
      expect(r.selector).not.toMatch(/aria-hidden|tabindex|inert/);
    }
  });

  it("hides the strip with a transform", () => {
    const strip = selectorsFor("spaces-strip-hidden > .spaces-switcher").find((r) =>
      r.style.getPropertyValue("transform").includes("-100%")
    );
    expect(strip).toBeDefined();
  });

  it("carries the focus-within reveal, undoing the hiding transform", () => {
    const reveal = selectorsFor(":focus-within").find(
      (r) => r.selector.includes("spaces-strip-hidden") && r.selector.includes(".spaces-switcher:focus-within")
    );
    expect(reveal?.style.getPropertyValue("transform")).toBe("translateX(0)");
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

describe("picker row states", () => {
  it("a selected row is told from a covered one by weight, which no theme supplies", () => {
    // Both states are tinted on purpose: the tint is what groups a picked
    // folder with the rows it brings in, and they are drawn as one block. So
    // the tint cannot be the thing that separates them.
    //
    // That leaves the selected row's accent text and its weight. The color
    // is theme-derived and a theme can narrow `--text-accent` toward
    // `--text-normal`, which is exactly how these two states once became
    // indistinguishable. The WEIGHT is a literal in this stylesheet, so it
    // survives any theme. This pins the one difference a theme cannot take
    // away; asserting the tints differ would be wrong, because they match by
    // design.
    const selected = document.createElement("div");
    selected.className = "spaces-create-tree-row is-selected";
    const covered = document.createElement("div");
    covered.className = "spaces-create-tree-row is-inherited";

    const weightOf = (el: HTMLElement): string =>
      rules
        .filter((r) => el.matches(r.selector) && !r.selector.includes(":"))
        .map((r) => r.style.getPropertyValue("font-weight"))
        .filter((v) => v !== "")
        .join(" ");

    expect(weightOf(selected)).toBe("600");
    expect(weightOf(covered)).toBe("");
  });

  it("a run of tinted rows squares its interior corners, so it draws as one block", () => {
    // Readable through `rules` again. This pair used to be a forward-looking
    // parent selector, which jsdom's CSSOM drops silently, so the only thing
    // these assertions could reach was the stylesheet TEXT. The forward look
    // is now a class the renderer sets, so both halves of the join are
    // ordinary selectors a parser can answer.
    const joined = document.createElement("div");
    joined.className = "spaces-create-tree-row is-joined-down";
    const isJoinRule = (sel: string): boolean =>
      sel.includes("is-joined-down") && !sel.includes(":");
    const bottom = rules.filter((r) => joined.matches(r.selector) && isJoinRule(r.selector));
    expect(bottom, "the rule that squares the bottom corners").toHaveLength(1);
    expect(bottom[0].style.getPropertyValue("border-bottom-left-radius")).toBe("0");

    // The other half still looks BACK one sibling, which is a plain
    // combinator. Built as a real pair so the combinator is actually
    // exercised rather than pattern-matched.
    const host = document.createElement("div");
    const above = document.createElement("div");
    above.className = "spaces-create-tree-row is-selected";
    const below = document.createElement("div");
    below.className = "spaces-create-tree-row is-inherited";
    host.append(above, below);
    const top = rules.filter((r) => below.matches(r.selector) && r.selector.includes("+"));
    expect(top, "the sibling rule that squares the top corners").toHaveLength(1);
    expect(top[0].style.getPropertyValue("border-top-left-radius")).toBe("0");

    // The join is on the next row being COVERED, never merely tinted: two
    // folders picked separately are two selections and must stay two pills.
    // That rule now lives in `markJoinedRows`, which decides who gets
    // `is-joined-down`, and `pickerBlockJoin.test.ts` is where it is pinned.
    // What CSS can still promise is that it never squares a row on the
    // strength of the class pair alone.
    const pair = document.createElement("div");
    const first = document.createElement("div");
    first.className = "spaces-create-tree-row is-selected";
    const second = document.createElement("div");
    second.className = "spaces-create-tree-row is-selected";
    pair.append(first, second);
    for (const r of rules) {
      if (r.style.getPropertyValue("border-top-left-radius") !== "0") continue;
      expect(second.matches(r.selector), `two picked siblings must not merge: ${r.selector}`).toBe(false);
    }
  });

  it("merging a block is paint-only, so selecting a parent never moves a row", () => {
    // The first version of this collapsed the margin to join two rows, and
    // that MOVED them: a block of N rows lost (N-1) separators of height, so
    // picking a parent pulled its children up and deselecting dropped them
    // back. The separator is filled with a shadow instead.
    //
    // So the assertion is not "the gap closes" but "nothing in the merge rule
    // can affect layout". Anything that reserves or removes space -- margin,
    // padding, height, border-width, inset, position, transform -- reopens the
    // bug, which is why this lists them rather than naming one.
    const base = rules.filter((r) => r.selector === ".spaces-create-tree-row");
    expect(base).toHaveLength(1);
    expect(base[0].style.getPropertyValue("margin-bottom")).not.toBe("");

    const joined = document.createElement("div");
    joined.className = "spaces-create-tree-row is-joined-down";
    const merge = rules.filter(
      (r) => joined.matches(r.selector) && r.selector.includes("is-joined-down") && !r.selector.includes(":")
    );
    expect(merge, "the merge rule").toHaveLength(1);
    expect(merge[0].style.getPropertyValue("box-shadow")).not.toBe("");
    for (const prop of ["margin", "padding", "height", "border-width", "border-bottom-width", "top", "transform"]) {
      expect(merge[0].style.getPropertyValue(prop), `merge rule must not set ${prop}`).toBe("");
    }
  });

  it("a covered row keeps the plain focus ring, because it sets no shadow of its own", () => {
    // Covered rows stay in the tab order so a keyboard user can reach the
    // title explaining why they are inert, so they need a ring. The ring is
    // an inset box-shadow on `.spaces-create-tree-row:focus-visible`, and
    // that rule and `.spaces-create-tree-row.is-inherited` have equal
    // specificity, so a shadow on the covered rule would win on source order
    // and silently erase the ring. It did once. This pins the absence.
    const covered = document.createElement("div");
    covered.className = "spaces-create-tree-row is-inherited";
    const own = rules.filter((r) => covered.matches(r.selector) && !r.selector.includes(":"));
    for (const r of own) {
      expect(r.style.getPropertyValue("box-shadow"), r.selector).toBe("");
    }
    const ring = rules.filter((r) => r.selector === ".spaces-create-tree-row:focus-visible");
    expect(ring).toHaveLength(1);
    expect(ring[0].style.getPropertyValue("box-shadow")).toContain("--text-accent");
  });
});

describe("picker column layout", () => {
  it("the filter box does not shrink, so its height cannot track the list below it", () => {
    // The shape `CreateSpacePanel` builds: the filter is a bare `.text-input`
    // child of `.spaces-create-items`, with no class of its own.
    const view = document.createElement("div");
    view.className = "spaces-create-items";
    const filter = document.createElement("input");
    filter.className = "text-input";
    view.appendChild(filter);
    const matching = rules.filter((r) => filter.matches(r.selector));
    expect(matching.some((r) => r.style.getPropertyValue("flex-shrink") === "0")).toBe(true);
  });
});

describe("compacted row label roles", () => {
  /**
   * The real row shape: a `.tree-item` wrapper holding the `[data-path]` row
   * (`.tree-item-self`), whose children are the collapse chevron and
   * `.tree-item-inner`.
   *
   * `.tree-item-inner` is NEVER written — Obsidian seeds its inline-rename
   * editor from it, and a joined label there makes a compacted folder
   * unrenameable. The lead and separator spans go into an owned prefix
   * element inserted before it, so what the stylesheet has to reach is now a
   * span one level deeper than it used to be.
   */
  function compactedRow(
    path = "Work/Clients",
    name = "Clients",
    index = INDEX,
    opts = PLAIN_LABEL,
    overflows: () => boolean = () => false
  ): { title: HTMLElement; textEl: HTMLElement } {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-item";
    const title = document.createElement("div");
    title.className = "tree-item-self";
    title.setAttribute("data-path", path);
    const chevron = document.createElement("div");
    chevron.className = "tree-item-icon collapse-icon";
    const textEl = document.createElement("div");
    textEl.className = "tree-item-inner";
    textEl.textContent = name;
    title.appendChild(chevron);
    title.appendChild(textEl);
    wrapper.appendChild(title);
    applyCompactLabels([title], index, opts, { overflows });
    return { title, textEl };
  }

  /**
   * The same row, shortened.
   *
   * The pass shortens a row only when it MEASURES as overflowing, and jsdom
   * lays nothing out, so the measurement is substituted here. See
   * `OverflowProbe` for why that seam exists at all.
   */
  const shortenedRow = (): { title: HTMLElement; textEl: HTMLElement } =>
    compactedRow("A/B/C/D", "D", DEEP_INDEX, { abbreviateWhenOverflowing: true }, () => true);

  // `applyCompactLabels` classes each span `spaces-compact-<role>` from
  // `compactLabel`'s roles. The stylesheet cannot import them, so a role
  // renamed on one side only would silently stop dimming.
  const dimmed = ["spaces-compact-lead", "spaces-compact-sep"];
  for (const role of ["lead", "sep"] as const) {
    it(`spaces-compact-${role} is the class a rendered span carries`, () => {
      const { title } = compactedRow();
      expect(title.querySelector(`.spaces-compact-${role}`)).not.toBeNull();
    });
  }

  it("the tip is not rendered, so the stylesheet has nothing of ours to reach", () => {
    // `compactLabel` still returns the tip part; the adapter deliberately
    // does not draw it, because `.tree-item-inner` already is it.
    const { title, textEl } = compactedRow();
    expect(title.querySelector(".spaces-compact-tip")).toBeNull();
    expect(textEl.children.length).toBe(0);
  });

  it("the role spans are reachable from inside the owned prefix", () => {
    // The rules are written unscoped, so they must match a span wherever the
    // adapter puts it. Asserted against the REAL nesting rather than a bare
    // span, which is what would silently stop being true if the rules ever
    // gained an ancestor the prefix does not provide.
    const { title } = compactedRow();
    for (const cls of dimmed) {
      const span = title.querySelector<HTMLElement>(`.${cls}`);
      expect(span, cls).not.toBeNull();
      expect(rules.some((r) => span!.matches(r.selector)), cls).toBe(true);
    }
  });

  /**
   * `gap` is a role of its own precisely so the stylesheet can draw `..` as
   * the marker it is rather than as a very short folder name. That is only
   * true while the class the adapter writes and the class the stylesheet
   * reaches for are the same string, which neither side can check alone.
   */
  it("spaces-compact-gap is the class a shortened label's stand-in carries", () => {
    const { title } = shortenedRow();
    const span = title.querySelector<HTMLElement>(".spaces-compact-gap");
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe("..");
    expect(rules.some((r) => span!.matches(r.selector))).toBe(true);
  });

  /**
   * ONE SHADE FOR THE WHOLE PATH, which is a rule about what the stylesheet
   * must NOT say.
   *
   * Opacity on a role span multiplies with the row's, so any value on any
   * part draws that part at a different shade from the rest of its own path.
   * The parts used to carry 0.6 and 0.45, and in a real vault that read as
   * the last folder of a chain being a different color from the folders above
   * it. Nothing here forbids a variant from styling the roles -- the bidi
   * isolation below is one, and a variant could add weight or case -- but a
   * part-level opacity is how the shade splits, so it is the one declaration
   * these spans may not carry.
   */
  it("no part of a compacted label carries an opacity of its own", () => {
    for (const cls of [...dimmed, "spaces-compact-tip", "spaces-compact-prefix"]) {
      const span = document.createElement("span");
      span.className = cls;
      const withOpacity = rules.filter(
        (r) => span.matches(r.selector) && r.style.getPropertyValue("opacity") !== ""
      );
      expect(
        withOpacity.map((r) => r.selector),
        `${cls} must take the row's shade, not one of its own`
      ).toEqual([]);
    }
  });

  /**
   * A SIMPLIFIED specificity: (class count, type count). It counts every
   * `.class` (including one inside `:not()`) and every leading type name, and
   * IGNORES ids, attribute selectors, other pseudo-classes and comma lists
   * (a list is summed, not split). That is exact for every rule it ranks
   * today, each a single class-and-combinator selector competing for one
   * property on one row. It is NOT a general CSS specificity implementation: a
   * future `.x:hover` or `[data-path]` rule would be under-ranked here.
   */
  function specificity(selector: string): [number, number] {
    const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
    const types = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
    return [classes, types];
  }

  /**
   * The value a row's `opacity` resolves to, ranked the way the cascade does:
   * specificity first, source order breaking a tie. `getComputedStyle` is not
   * used because jsdom does not rank rules by specificity.
   */
  function winningOpacity(el: HTMLElement): { value: string; tied: boolean } {
    const hits = rules
      .map((r, order) => ({ r, order, spec: specificity(r.selector) }))
      .filter((h) => el.matches(h.r.selector) && h.r.style.getPropertyValue("opacity") !== "");
    hits.sort((a, b) => a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.order - b.order);
    const top = hits[hits.length - 1];
    const next = hits[hits.length - 2];
    const tied = !!next && next.spec[0] === top.spec[0] && next.spec[1] === top.spec[1];
    return { value: top.r.style.getPropertyValue("opacity"), tied };
  }

  describe("a compacted row carries more ink than a plain scaffold row", () => {
    const scaffoldRow = (compacted: boolean): HTMLElement => {
      const { title } = compactedRow();
      title.parentElement!.classList.add(CLS.scaffold);
      if (!compacted) title.parentElement!.classList.remove(CLS.compacted);
      return title;
    };

    it("a plain scaffold row stays at 0.45", () => {
      expect(winningOpacity(scaffoldRow(false)).value).toBe("0.45");
    });

    it("a compacted scaffold row draws at the visitor shade", () => {
      // The coupling the stylesheet states and cannot enforce: a compacted
      // row borrows the dimming this plugin already uses for "present, but
      // not a member". Both rules name the same custom property, so a change
      // to the visitor shade moves the compacted row with it -- and a future
      // edit that inlines a number into either one fails here.
      const visitor = rules.find((r) => r.selector === ".spaces-visitor > .tree-item-self");
      expect(visitor, "the visitor rule").toBeDefined();
      const shade = visitor!.style.getPropertyValue("opacity");
      expect(shade).toBe("var(--spaces-dim-visitor)");
      expect(winningOpacity(scaffoldRow(true)).value).toBe(shade);
    });

    it("the borrowed shade resolves to a real number on :root", () => {
      // A `var()` with nothing behind it renders as full opacity, which would
      // make a compacted row indistinguishable from a member folder.
      const root = rules.find((r) => r.selector === ":root");
      expect(root, ":root").toBeDefined();
      expect(Number(root!.style.getPropertyValue("--spaces-dim-visitor"))).toBeGreaterThan(0);
      expect(Number(root!.style.getPropertyValue("--spaces-dim-visitor"))).toBeLessThan(1);
    });

    it("wins by specificity, so source order cannot decide it", () => {
      // A tie would be settled by whichever rule is written last, which is
      // exactly what this guards against.
      expect(winningOpacity(scaffoldRow(true)).tied).toBe(false);
    });

    it("stands down on a row the user has cut, so Obsidian's cut cue survives", () => {
      // `is-cut` is Obsidian's class, not ours. A cut compacted row falls
      // back to the scaffold rule, which is dimmer than Obsidian's own 0.5.
      const title = scaffoldRow(true);
      title.classList.add("is-cut");
      expect(winningOpacity(title).value).toBe("0.45");
    });

    it("does not reach a member folder, which is not scaffold", () => {
      const { title } = compactedRow();
      title.parentElement!.classList.remove(CLS.scaffold);
      expect(rules.some((r) => title.matches(r.selector) && r.style.getPropertyValue("opacity") !== "")).toBe(false);
    });
  });

  describe("the role spans are bidi-isolated", () => {
    it("lead, separator and gap each carry unicode-bidi: isolate", () => {
      for (const role of ["lead", "sep", "gap"]) {
        const span = document.createElement("span");
        span.className = `spaces-compact-${role}`;
        const values = rules.filter((r) => span.matches(r.selector)).map((r) => r.style.getPropertyValue("unicode-bidi"));
        expect(values, role).toContain("isolate");
      }
    });
  });

  /**
   * A class the code sets that the stylesheet never mentions is a FAILURE,
   * not a gap nobody notices: `CLS.compacted` was set, cleared and pinned by
   * tests for a whole feature while no rule reached it.
   *
   * The list comes from `selectors.ts` itself, so a class added there is
   * covered the day it is added: every string export (all the `CLS_*`
   * constants) and every member of `CLS`. A class defined outside that file
   * is not covered, which is why the convention is that they live there.
   */
  describe("every class the code sets is styled or explicitly unstyled", () => {
    /**
     * Class-shaped strings only: the `spaces-` and `is-` families. A future
     * string export that is not a class (an attribute name, an id) is not
     * swept in and reported unstyled.
     */
    const isClass = (v: string): boolean => /^(spaces|is)-[a-z0-9-]+$/.test(v);
    const selectorClasses = (): string[] =>
      [
        ...Object.values(CLS),
        ...(Object.values(selectors) as unknown[]).filter((v): v is string => typeof v === "string"),
      ].filter(isClass);

    /**
     * The generated family. Driven by the runtime `LABEL_ROLES`, from which
     * the `LabelRole` type is derived, so a role cannot exist in the type and
     * be missing here. `tip` is filtered out the way `partsFor` filters it: it
     * is never drawn as a span, so `spaces-compact-tip` is NOT a gap.
     */
    const roleClasses = (): string[] =>
      LABEL_ROLES.filter((r) => r !== "tip").map((r) => `spaces-compact-${r}`);

    /** The classes the adapter really draws for the two row shapes. */
    const drawnRoles = (): string[] => {
      const found = new Set<string>();
      for (const row of [compactedRow().title, shortenedRow().title]) {
        row.querySelectorAll(`.${selectors.CLS_COMPACT_PREFIX} > span`).forEach((span) => {
          for (const c of Array.from(span.classList)) found.add(c);
        });
      }
      return [...found].sort();
    };

    /**
     * Every `spaces-*` literal in `src/**` (comments stripped first).
     *
     * CAN see: a class named as a string, in a `className =`, `cls:`,
     * `addClass(...)`, `classList.add(...)` or a selector string.
     * CANNOT see: a class assembled at runtime. The `spaces-compact-${role}`
     * template is the one such case, and a literal ending in `-` or followed by
     * `${` is skipped here for that reason; `roleClasses` covers it. Also
     * skipped on purpose: `--spaces-*` custom properties and `data-spaces-*`
     * attributes, which the lookbehind rejects because they are not classes.
     */
    const sourceClasses = (): string[] => {
      const out = new Set<string>();
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name.endsWith(".ts")) {
            const text = readFileSync(full, "utf8")
              .replace(/\/\*[\s\S]*?\*\//g, "")
              .replace(/(^|\s)\/\/.*$/gm, "$1");
            for (const m of text.matchAll(/(?<![\w-])spaces-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w${-])/g)) out.add(m[0]);
          }
        }
      };
      walk(resolve(process.cwd(), "src"));
      return [...out].sort();
    };

    const codeSetClasses = (): string[] => [
      ...new Set([...selectorClasses(), ...roleClasses(), ...sourceClasses()]),
    ];
    const mentioned = (cls: string): boolean =>
      rules.some((r) => new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(r.selector));

    it("sources the list from selectors.ts, and it holds what it should", () => {
      const all = codeSetClasses();
      for (const known of [CLS.scaffold, CLS.compacted, CLS_ELSEWHERE, selectors.CLS_COMPACT_PREFIX, selectors.CLS_DROP_LINE]) {
        expect(all).toContain(known);
      }
    });

    it("has a rule for every one of them", () => {
      const unstyled = codeSetClasses().filter((c) => !mentioned(c) && !(c in UNSTYLED_CLASSES));
      expect(unstyled).toEqual([]);
    });

    it("keeps the allowlist honest: a reason each, a real class each, and still unstyled", () => {
      const real = new Set(codeSetClasses());
      for (const [cls, reason] of Object.entries(UNSTYLED_CLASSES)) {
        expect(reason.trim(), cls).not.toBe("");
        expect(real.has(cls), `${cls} is not a class the code sets`).toBe(true);
        expect(mentioned(cls), `${cls} has a rule now, so drop it from the allowlist`).toBe(false);
      }
    });

    it("scans source files, and the scan holds what it should", () => {
      const found = sourceClasses();
      // A sample from several files; a scan that quietly found nothing would
      // pass the coverage test below vacuously.
      for (const known of ["spaces-switcher", "spaces-create-panel", "spaces-color-custom", CLS.scaffold]) {
        expect(found).toContain(known);
      }
      expect(found.length).toBeGreaterThan(50);
      expect(found.some((c) => c.startsWith("data-") || c.startsWith("--"))).toBe(false);
    });

    it("styles or allowlists every class found under src, not only selectors.ts", () => {
      const unstyled = sourceClasses().filter((c) => !mentioned(c) && !(c in UNSTYLED_CLASSES));
      expect(unstyled).toEqual([]);
    });

    it("covers every role but the tip, and never reports the tip as a gap", () => {
      // `partsFor` filters `tip` out before any span exists, because
      // `.tree-item-inner` already is the tip. So `spaces-compact-tip` is NOT
      // a gap in the stylesheet and must never be reported as one.
      expect(LABEL_ROLES).toContain("tip");
      const family = roleClasses();
      expect(family).not.toContain("spaces-compact-tip");
      expect(codeSetClasses()).not.toContain("spaces-compact-tip");
      for (const cls of family) expect(mentioned(cls), cls).toBe(true);
    });

    it("draws only classes from that family", () => {
      // The adapter and LABEL_ROLES must agree: a rendered role class outside
      // the family would escape the coverage above.
      const family = roleClasses();
      for (const cls of drawnRoles()) expect(family, cls).toContain(cls);
      expect(drawnRoles().length).toBeGreaterThan(0);
    });  });});
