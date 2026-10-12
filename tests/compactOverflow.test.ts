// @vitest-environment jsdom
/**
 * Shortening a compacted label is decided by MEASUREMENT, not by counting
 * folders.
 *
 * WHY THIS SUITE REPLACED A THRESHOLD. Counting folders answers the wrong
 * question. `Work/Shared` is two folders and fits anywhere;
 * `Correspondence/Subcontractors` is also two folders and overflows a narrow
 * pane, and under a folder count it never shortened and so never carried the
 * tooltip either -- the exact case the setting was added to solve. The pane
 * knows whether the text fits; nothing else does.
 *
 * WHY THE MEASUREMENT IS INJECTED HERE. jsdom runs no layout engine at all:
 * every element reports `scrollWidth` and `clientWidth` as 0, so the real
 * probe answers "fits" for every row ever built in a test. Substituting the
 * probe is therefore the only way a test can tell a row that fits from one
 * that does not. It is also why `e2e/deep-compact.mjs` exists outside this
 * repo: the real probe is only exercised in a real Obsidian, against a real
 * pane width.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ExplorerAdapter,
  applyCompactLabels,
  rowOverflows,
  type OverflowProbe,
} from "../src/explorer/ExplorerAdapter";
import { CLS_COMPACT_PREFIX, SEL } from "../src/explorer/selectors";
import type { CompactLabelPolicy } from "../src/ui/compactLabel";
import type { VisibilitySnapshot } from "../src/visibility/VisibilityEngine";
import { buildChainIndex, type ChainIndex } from "../src/visibility/compactChains";

/** The user leaves shortening on: a row that does not fit may be shortened. */
const ON: CompactLabelPolicy = { abbreviateWhenOverflowing: true };
/** The user wants the whole path always. */
const OFF: CompactLabelPolicy = { abbreviateWhenOverflowing: false };

/** A pane too narrow for every row in it. */
const ALWAYS: OverflowProbe = () => true;
/** A pane wide enough for every row in it. */
const NEVER: OverflowProbe = () => false;

const DEEP_CHAIN = [
  "Research",
  "Research/2026",
  "Research/2026/Q4",
  "Research/2026/Q4/Projects",
  "Research/2026/Q4/Projects/Atlas",
  "Research/2026/Q4/Projects/Atlas/Design",
  "Research/2026/Q4/Projects/Atlas/Design/Decisions",
];
const DEEP_TIP = DEEP_CHAIN[DEEP_CHAIN.length - 1];
const DEEP_FULL = "Research/2026/Q4/Projects/Atlas/Design/Decisions";

/** Two folders, the shortest run that compacts at all. */
const PAIR_CHAIN = ["Work", "Work/Shared"];
const PAIR_TIP = "Work/Shared";

function treeOver(chain: readonly string[]): Parameters<typeof buildChainIndex>[1] {
  const tip = chain[chain.length - 1];
  return {
    visibleChildrenOf: (p: string) => {
      const i = chain.indexOf(p);
      if (i >= 0 && i < chain.length - 1) return [chain[i + 1]];
      if (p === tip) return [`${tip}/a.md`];
      return [];
    },
    isFolder: (p: string) => chain.includes(p),
    isScaffold: (p: string) => chain.includes(p),
    parentOf: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
    nameOf: (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
  };
}

const DEEP: ChainIndex = buildChainIndex([DEEP_CHAIN[0]], treeOver(DEEP_CHAIN));
const PAIR: ChainIndex = buildChainIndex([PAIR_CHAIN[0]], treeOver(PAIR_CHAIN));

/** The real row shape: `[data-path]` is `.tree-item-self` inside `.tree-item`. */
function row(path: string, name: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-item nav-folder";
  const title = document.createElement("div");
  title.className = "tree-item-self nav-folder-title";
  title.setAttribute("data-path", path);
  const chevron = document.createElement("div");
  chevron.className = "tree-item-icon collapse-icon";
  const textEl = document.createElement("div");
  textEl.className = "tree-item-inner nav-folder-title-content";
  textEl.textContent = name;
  title.append(chevron, textEl);
  wrapper.appendChild(title);
  return title;
}

const deepRow = (): HTMLElement => row(DEEP_TIP, "Decisions");
const pairRow = (): HTMLElement => row(PAIR_TIP, "Shared");
const prefixOf = (title: HTMLElement): HTMLElement | null =>
  title.querySelector<HTMLElement>(`:scope > .${CLS_COMPACT_PREFIX}`);

describe("the shortening decision is the measurement", () => {
  it("draws a label that FITS in full, whatever its folder count", () => {
    // Seven folders, the deepest run the design notes measured. Under the
    // folder-count threshold this always shortened; now the pane decides, and
    // this pane has room.
    const title = deepRow();
    applyCompactLabels([title], DEEP, ON, { overflows: NEVER });
    expect(title.textContent).toBe(DEEP_FULL);
    expect(title.querySelector(".spaces-compact-gap")).toBeNull();
    expect(title.hasAttribute("aria-label")).toBe(false);
  });

  it("shortens a label that does NOT fit, and gives it the tooltip", () => {
    const title = deepRow();
    applyCompactLabels([title], DEEP, ON, { overflows: ALWAYS });
    expect(title.textContent).toBe("../Design/Decisions");
    expect(prefixOf(title)!.textContent).toBe("../Design/");
    expect(title.getAttribute("aria-label")).toBe(DEEP_FULL);
  });

  it("never shortens with the setting off, however badly the row overflows", () => {
    const title = deepRow();
    const probe = vi.fn(ALWAYS);
    applyCompactLabels([title], DEEP, OFF, { overflows: probe });
    expect(title.textContent).toBe(DEEP_FULL);
    expect(title.hasAttribute("aria-label")).toBe(false);
    // Nothing is even measured: the answer cannot change the label, and
    // reading `scrollWidth` forces a layout.
    expect(probe).not.toHaveBeenCalled();
  });

  it("never shortens a two folder run, even when it does not fit", () => {
    // Structural, not a consequence of any number: `../Shared` is no shorter
    // to read than `Work/Shared` and trades a usable folder name for a glyph.
    const title = pairRow();
    applyCompactLabels([title], PAIR, ON, { overflows: ALWAYS });
    expect(title.textContent).toBe("Work/Shared");
    expect(title.querySelector(".spaces-compact-gap")).toBeNull();
    expect(title.hasAttribute("aria-label")).toBe(false);
  });

  it("draws every row in full before it measures any of them", () => {
    // The batching, as an assertion rather than a comment. A pass that
    // measured row N straight after writing row N would force a synchronous
    // layout per row, and one render window is about fifty of them.
    const titles = [deepRow(), deepRow(), deepRow()];
    const drawnAtEachMeasurement: number[] = [];
    applyCompactLabels(titles, DEEP, ON, {
      overflows: () => {
        drawnAtEachMeasurement.push(titles.filter((t) => prefixOf(t) !== null).length);
        return false;
      },
    });
    expect(drawnAtEachMeasurement).toEqual([3, 3, 3]);
  });

  it("measures every row before it shortens any of them", () => {
    // The other half of the batching: the writes come after ALL the reads, so
    // no measurement is taken against a tree half of which has already moved.
    const titles = [deepRow(), deepRow(), deepRow()];
    const shortenedAtEachMeasurement: number[] = [];
    applyCompactLabels(titles, DEEP, ON, {
      overflows: () => {
        shortenedAtEachMeasurement.push(
          titles.filter((t) => t.textContent!.startsWith("..")).length
        );
        return true;
      },
    });
    expect(shortenedAtEachMeasurement).toEqual([0, 0, 0]);
    for (const t of titles) expect(t.textContent).toBe("../Design/Decisions");
  });

  it("writes nothing on a repeated pass, so our own pass cannot re-trigger itself", () => {
    // The adapter's MutationObserver watches the container this pass writes
    // into. A pass that rewrote the prefix every time would schedule the next
    // one forever. Identity, not text, is what tells a no-op from a rebuild.
    const title = deepRow();
    applyCompactLabels([title], DEEP, ON, { overflows: ALWAYS });
    const prefix = prefixOf(title);
    const spans = Array.from(prefix!.children);
    applyCompactLabels([title], DEEP, ON, { overflows: ALWAYS });
    expect(prefixOf(title)).toBe(prefix);
    Array.from(prefixOf(title)!.children).forEach((el, i) => expect(el).toBe(spans[i]));
    expect(title.textContent).toBe("../Design/Decisions");
  });

  it("leaves a shortened row alone until it is asked to re-measure", () => {
    // What a sidebar resize changes, and what an ordinary pass must not. An
    // ordinary pass redrawing the full label to measure it would rewrite the
    // prefix twice per pass forever; the resize is the only event that can
    // make a shortened row fit again.
    const title = deepRow();
    applyCompactLabels([title], DEEP, ON, { overflows: ALWAYS });
    expect(title.textContent).toBe("../Design/Decisions");

    applyCompactLabels([title], DEEP, ON, { overflows: NEVER });
    expect(title.textContent).toBe("../Design/Decisions");

    applyCompactLabels([title], DEEP, ON, { overflows: NEVER, remeasure: true });
    expect(title.textContent).toBe(DEEP_FULL);
    expect(title.hasAttribute("aria-label")).toBe(false);
  });
});

describe("rowOverflows, the production probe", () => {
  /**
   * jsdom lays nothing out, so this can only be asserted against hand-set
   * widths. It is still worth pinning WHICH two comparisons are made: the
   * overflow this feature exists for was never visible on the row alone --
   * the prefix kept its full width and Obsidian's own text element was the
   * one squeezed to nothing.
   */
  function widths(el: HTMLElement, scroll: number, client: number): void {
    Object.defineProperty(el, "scrollWidth", { value: scroll, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: client, configurable: true });
  }

  it("is false for a row whose content fits", () => {
    const title = deepRow();
    widths(title, 200, 220);
    widths(title.querySelector(SEL.rowText) as HTMLElement, 60, 60);
    expect(rowOverflows(title)).toBe(false);
  });

  it("is true when the row itself overflows", () => {
    const title = deepRow();
    widths(title, 263, 222);
    widths(title.querySelector(SEL.rowText) as HTMLElement, 60, 60);
    expect(rowOverflows(title)).toBe(true);
  });

  it("is true when the row fits only because the tip was squeezed to nothing", () => {
    // The measured failure: a 246px pane, the row reporting no overflow of its
    // own, and `.tree-item-inner` laid out at a client width of ZERO.
    const title = deepRow();
    widths(title, 222, 222);
    widths(title.querySelector(SEL.rowText) as HTMLElement, 58, 0);
    expect(rowOverflows(title)).toBe(true);
  });

  it("allows a single pixel of slack, because the two widths round opposite ways", () => {
    const title = deepRow();
    widths(title, 223, 222);
    widths(title.querySelector(SEL.rowText) as HTMLElement, 60, 60);
    expect(rowOverflows(title)).toBe(false);
  });
});

/**
 * THE RESIZE OBSERVER, and the leak it would be.
 *
 * A pane that gets narrower has to be re-measured: nothing else in the plugin
 * hears about a sidebar drag, and the decision taken at the old width is now
 * wrong. The observer that hears it outlives the plugin unless teardown
 * disconnects it, and that is the difference between a feature and a leak.
 */
describe("the nav container's ResizeObserver", () => {
  const SNAP: VisibilitySnapshot = {
    decisionFor: () => ({
      visible: true,
      reason: "scaffold",
      canRemoveMembership: false,
      overridesIgnore: false,
    }),
    visiblePaths: () => new Set(DEEP_CHAIN),
  };

  /** Every observer this test's window handed out, so teardown can be audited. */
  interface FakeRO {
    observed: Element[];
    disconnected: number;
  }
  let made: FakeRO[] = [];
  let fire: (() => void) | null = null;
  let original: typeof ResizeObserver;

  beforeEach(() => {
    made = [];
    fire = null;
    original = window.ResizeObserver;
    window.ResizeObserver = class {
      private readonly me: FakeRO = { observed: [], disconnected: 0 };
      constructor(cb: () => void) {
        made.push(this.me);
        fire = cb;
      }
      observe(el: Element): void {
        this.me.observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {
        this.me.disconnected++;
      }
    } as unknown as typeof ResizeObserver;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.ResizeObserver = original;
    document.body.innerHTML = "";
  });

  function mount(): HTMLElement {
    document.body.innerHTML = `<div class="nav-files-container">
      <div class="tree-item nav-folder">
        <div class="tree-item-self nav-folder-title" data-path="${DEEP_TIP}">
          <div class="tree-item-icon collapse-icon"></div>
          <div class="tree-item-inner nav-folder-title-content">Decisions</div>
        </div>
      </div>
    </div>`;
    return document.querySelector(".nav-files-container") as HTMLElement;
  }

  it("watches the container it was bound to", () => {
    const container = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    expect(made.length).toBe(1);
    expect(made[0].observed).toEqual([container]);
    a.unbind();
  });

  it("re-runs the label pass once the resize settles, and re-measures", () => {
    const container = mount();
    let fits = false;
    const a = new ExplorerAdapter(() => !fits);
    a.bind(container);
    a.setChainIndex(DEEP, ON);
    a.apply(SNAP);
    const title = container.querySelector("[data-path]") as HTMLElement;
    expect(title.textContent!.trim()).toBe("../Design/Decisions");

    // The pane is dragged wider: many callbacks, one pass.
    fits = true;
    fire!();
    fire!();
    fire!();
    expect(title.textContent!.trim()).toBe("../Design/Decisions");
    vi.runAllTimers();
    expect(title.textContent!.trim()).toBe(DEEP_FULL);
    expect(title.hasAttribute("aria-label")).toBe(false);
    a.unbind();
  });

  it("disconnects on teardown, and nothing it armed reaches the torn-down tree", () => {
    const container = mount();
    const a = new ExplorerAdapter(() => true);
    a.bind(container);
    a.setChainIndex(DEEP, ON);
    a.apply(SNAP);
    const title = container.querySelector("[data-path]") as HTMLElement;
    expect(prefixOf(title)).not.toBeNull();

    // A resize in flight at the moment the plugin unloads.
    fire!();
    a.unbind();
    expect(made[0].disconnected).toBe(1);
    vi.runAllTimers();
    expect(prefixOf(title)).toBeNull();
    expect(title.hasAttribute("aria-label")).toBe(false);
  });

  it("disconnects the previous observers when the panes are rebound", () => {
    // `bindAll` unbinds first, which is also what keeps a split explorer from
    // accumulating one observer per layout change.
    const container = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.bind(container);
    expect(made.length).toBe(2);
    expect(made[0].disconnected).toBe(1);
    a.unbind();
    expect(made[1].disconnected).toBe(1);
  });
});
