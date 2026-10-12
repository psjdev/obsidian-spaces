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

/**
 * The SAME tip, reached by a shorter run.
 *
 * A note appears beside `2026` under `Research`, so `Research` no longer leads
 * onward alone and the run starts one folder lower. The tip's path does not
 * move, so the row is the same row -- and `../Design/Decisions` is what BOTH
 * runs draw when shortened, because the last two segments are fixed by the
 * path. Nothing about the row itself says the question is open again.
 */
const SHALLOWER: ChainIndex = buildChainIndex(DEEP_CHAIN, {
  visibleChildrenOf: (p: string) => {
    if (p === "Research") return ["Research/2026", "Research/Archive.md"];
    const i = DEEP_CHAIN.indexOf(p);
    if (i > 0 && i < DEEP_CHAIN.length - 1) return [DEEP_CHAIN[i + 1]];
    if (p === DEEP_TIP) return [`${DEEP_TIP}/a.md`];
    return [];
  },
  isFolder: (p: string) => DEEP_CHAIN.includes(p),
  isScaffold: (p: string) => DEEP_CHAIN.includes(p),
  parentOf: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : null),
  nameOf: (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p),
});
/** What the shorter run draws in full: `Research/` is no longer part of it. */
const SHALLOWER_FULL = "2026/Q4/Projects/Atlas/Design/Decisions";

/** Everything visible and scaffold, which is all `applyNow` asks of a snapshot. */
const SNAP: VisibilitySnapshot = {
  decisionFor: () => ({
    visible: true,
    reason: "scaffold",
    canRemoveMembership: false,
    overridesIgnore: false,
  }),
  visiblePaths: () => new Set(DEEP_CHAIN),
};

/** One deep row in a real container, which is what an adapter needs to bind. */
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

/** Every observer this window handed out, so teardown can be audited. */
interface FakeRO {
  observed: Element[];
  disconnected: number;
}

/**
 * A ResizeObserver this test can FIRE, in place of the one jsdom does not
 * implement.
 *
 * `tests/helpers/jsdomGaps.ts` installs a no-op for every suite, which is the
 * honest model when nothing can be resized. These tests need the opposite: to
 * say "the pane moved" without a layout engine, and to count what the adapter
 * did about it.
 */
function installFakeResizeObserver(): {
  made: FakeRO[];
  fire: () => void;
  restore: () => void;
} {
  const made: FakeRO[] = [];
  let callback: (() => void) | null = null;
  const original = window.ResizeObserver;
  window.ResizeObserver = class {
    private readonly me: FakeRO = { observed: [], disconnected: 0 };
    constructor(cb: () => void) {
      made.push(this.me);
      callback = cb;
    }
    observe(el: Element): void {
      this.me.observed.push(el);
    }
    unobserve(): void {}
    disconnect(): void {
      this.me.disconnected++;
    }
  } as unknown as typeof ResizeObserver;
  return {
    made,
    fire: () => callback?.(),
    restore: () => {
      window.ResizeObserver = original;
    },
  };
}

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

  it("measures every row before it shortens any of them, in every round", () => {
    // The other half of the batching: inside a round the writes come after
    // ALL the reads, so no measurement is taken against a tree half of which
    // has already moved. The climb makes this a per-ROUND property -- the
    // second round does measure rows the first round shortened, which is the
    // point of it -- so what has to hold is that every measurement within one
    // round sees the same tree.
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
    // Three rows measured per round, and nothing drawn short in the first.
    expect(shortenedAtEachMeasurement.length % titles.length).toBe(0);
    expect(shortenedAtEachMeasurement.slice(0, 3)).toEqual([0, 0, 0]);
    for (let i = 0; i < shortenedAtEachMeasurement.length; i += titles.length) {
      const round = shortenedAtEachMeasurement.slice(i, i + titles.length);
      expect(new Set(round).size).toBe(1);
    }
    // A pane that fits nothing pushes every row to the floor and stops there.
    for (const t of titles) expect(t.textContent).toBe("../Design/Decisions");
  });

  /**
   * THE CLIMB, measured: a row gives up what the pane took and no more.
   *
   * The probe models a pane as a character budget, which is the only kind of
   * width jsdom can offer. It is enough for the property under test: the pass
   * must try the whole label first, then one folder less, and stop at the
   * first label inside the budget.
   */
  describe("one folder at a time", () => {
    /** A pane that fits `chars` characters of label and no more. */
    const fits = (chars: number): OverflowProbe => (title) =>
      (title.textContent ?? "").length > chars;

    // 48 characters whole, then 42, 37, 34, 25 and 19 as the folders go.
    for (const [budget, label] of [
      [60, "Research/2026/Q4/Projects/Atlas/Design/Decisions"],
      [48, "Research/2026/Q4/Projects/Atlas/Design/Decisions"],
      [45, "../2026/Q4/Projects/Atlas/Design/Decisions"],
      [40, "../Q4/Projects/Atlas/Design/Decisions"],
      [36, "../Projects/Atlas/Design/Decisions"],
      [30, "../Atlas/Design/Decisions"],
      [20, "../Design/Decisions"],
      [4, "../Design/Decisions"],
    ] as const) {
      it(`keeps every folder a ${budget} character pane has room for`, () => {
        const title = deepRow();
        applyCompactLabels([title], DEEP, ON, { overflows: fits(budget) });
        expect(title.textContent).toBe(label);
      });
    }

    it("stops at the parent rather than measuring forever", () => {
      // A pane narrower than the shortest label this run can draw. The row
      // settles at the floor, and the pass ENDS -- the count is the assertion,
      // because a climb with no ceiling would call the probe until the stack
      // or the test runner gave out.
      const title = deepRow();
      let calls = 0;
      applyCompactLabels([title], DEEP, ON, {
        overflows: () => {
          calls++;
          return true;
        },
      });
      expect(title.textContent).toBe("../Design/Decisions");
      // Six measurements: the whole label and the five levels below it.
      expect(calls).toBe(6);
    });

    it("gives folders BACK one at a time when the pane grows", () => {
      // The other direction, which is the one a user drags toward. A remeasure
      // re-opens the decision from the whole label, so the row lands on the
      // longest label the wider pane now fits rather than on whatever it was
      // showing.
      const title = deepRow();
      applyCompactLabels([title], DEEP, ON, { overflows: fits(20) });
      expect(title.textContent).toBe("../Design/Decisions");

      applyCompactLabels([title], DEEP, ON, { overflows: fits(40), remeasure: true });
      expect(title.textContent).toBe("../Q4/Projects/Atlas/Design/Decisions");

      applyCompactLabels([title], DEEP, ON, { overflows: fits(60), remeasure: true });
      expect(title.textContent).toBe("Research/2026/Q4/Projects/Atlas/Design/Decisions");
      expect(title.hasAttribute("aria-label")).toBe(false);
    });

    it("keeps a part-way level across an ordinary pass, and measures nothing", () => {
      // The keep-short guard has to recognise a row shortened by THREE
      // folders, not only one shortened to the floor. A guard that compared
      // against the floor label alone would call this row undecided, draw it
      // whole and climb again on every mutation the observer sees.
      const title = deepRow();
      applyCompactLabels([title], DEEP, ON, { overflows: fits(36) });
      expect(title.textContent).toBe("../Projects/Atlas/Design/Decisions");

      const probe = vi.fn(() => true);
      applyCompactLabels([title], DEEP, ON, { overflows: probe });
      expect(probe).not.toHaveBeenCalled();
      expect(title.textContent).toBe("../Projects/Atlas/Design/Decisions");
    });

    it("carries the tooltip at every level that hides a folder", () => {
      // The row says less than the path at every level above zero, so the
      // hover has to answer at every one of them -- not only at the floor.
      for (const [budget, label] of [
        [45, "../2026/Q4/Projects/Atlas/Design/Decisions"],
        [30, "../Atlas/Design/Decisions"],
        [20, "../Design/Decisions"],
      ] as const) {
        const title = deepRow();
        applyCompactLabels([title], DEEP, ON, { overflows: fits(budget) });
        expect(title.textContent).toBe(label);
        expect(title.getAttribute("aria-label")).toBe(DEEP_TIP);
      }
    });
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

  it("never mistakes a row drawn WHOLE for one already decided to shorten", () => {
    // WHAT THE KEEP-SHORT GUARD HAS TO GET RIGHT. It recognises "already
    // decided" by the prefix reading what a SHORTENING would draw, and the
    // cheaper test -- is there a prefix at all -- is wrong in exactly one
    // direction: it reads a row drawn whole as a decision to shorten. The
    // skip path then draws it short without measuring anything, so the second
    // ordinary pass over a row that FITS would shorten it, and no later pass
    // would put it back.
    const fitting = deepRow();
    applyCompactLabels([fitting], DEEP, ON, { overflows: NEVER });
    expect(fitting.textContent).toBe(DEEP_FULL);
    applyCompactLabels([fitting], DEEP, ON, { overflows: NEVER });
    expect(fitting.textContent).toBe(DEEP_FULL);
    expect(fitting.hasAttribute("aria-label")).toBe(false);

    // The same row drawn whole because the SETTING is off, then turned on: it
    // is measured, not assumed.
    const title = deepRow();
    applyCompactLabels([title], DEEP, OFF, { overflows: ALWAYS });
    expect(title.textContent).toBe(DEEP_FULL);
    applyCompactLabels([title], DEEP, ON, { overflows: ALWAYS });
    expect(title.textContent).toBe("../Design/Decisions");
    expect(title.getAttribute("aria-label")).toBe(DEEP_FULL);
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

  it("allows a single pixel of slack, because both widths are rounded", () => {
    const title = deepRow();
    widths(title, 223, 222);
    widths(title.querySelector(SEL.rowText) as HTMLElement, 60, 60);
    expect(rowOverflows(title)).toBe(false);
  });

  it("allows ONE pixel and not two, so the slack cannot quietly widen", () => {
    // Pinned from above as well as below: a slack of 2 passes every other
    // assertion in this file, and each pixel of it is a row that overflows and
    // is left long.
    const title = deepRow();
    widths(title, 224, 222);
    widths(title.querySelector(SEL.rowText) as HTMLElement, 60, 60);
    expect(rowOverflows(title)).toBe(true);

    const inner = deepRow();
    widths(inner, 200, 222);
    widths(inner.querySelector(SEL.rowText) as HTMLElement, 62, 60);
    expect(rowOverflows(inner)).toBe(true);
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
  let ro: ReturnType<typeof installFakeResizeObserver>;
  const made = (): FakeRO[] => ro.made;
  const fire = (): void => ro.fire();

  beforeEach(() => {
    ro = installFakeResizeObserver();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    ro.restore();
    document.body.innerHTML = "";
  });

  it("watches the container it was bound to", () => {
    const container = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    expect(made().length).toBe(1);
    expect(made()[0].observed).toEqual([container]);
    a.unbind();
  });

  it("re-runs the label pass on the next frame, and re-measures", () => {
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
    fire();
    fire();
    fire();
    expect(title.textContent!.trim()).toBe("../Design/Decisions");
    vi.runAllTimers();
    expect(title.textContent!.trim()).toBe(DEEP_FULL);
    expect(title.hasAttribute("aria-label")).toBe(false);
    a.unbind();
  });

  it("relabels within a frame of the resize, not a tenth of a second after it", () => {
    // WHAT THIS PINS, AND WHY IT IS A TEST RATHER THAN A COMMENT. The pass
    // used to be debounced 120ms: a sidebar drag relabelled nothing while it
    // moved and then snapped once the pointer stopped, which reads as the
    // plugin lagging the app. One frame is the budget now, and restoring any
    // settle timer longer than a frame fails here.
    const container = mount();
    let fits = false;
    const a = new ExplorerAdapter(() => !fits);
    a.bind(container);
    a.setChainIndex(DEEP, ON);
    a.apply(SNAP);
    const title = container.querySelector("[data-path]") as HTMLElement;
    expect(title.textContent!.trim()).toBe("../Design/Decisions");

    fits = true;
    fire();
    // One frame's worth of time, and nothing like 120ms.
    vi.advanceTimersByTime(20);
    expect(title.textContent!.trim()).toBe(DEEP_FULL);
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

    // A resize in flight at the moment the plugin unloads. The armed pass is
    // asserted by COUNT, because the repainting half of this test is
    // satisfied by `applyNow`'s own "no containers" guard whether or not the
    // timer was cleared -- so without the count, dropping the clear from
    // `unbind()` passes.
    const armed = vi.getTimerCount();
    fire();
    expect(vi.getTimerCount()).toBe(armed + 1);
    a.unbind();
    expect(made()[0].disconnected).toBe(1);
    expect(vi.getTimerCount()).toBe(armed);

    vi.runAllTimers();
    expect(prefixOf(title)).toBeNull();
    expect(title.hasAttribute("aria-label")).toBe(false);
  });

  it("re-opens the decision when the RUNS change, not only on a resize", () => {
    // The keep-short guard reads the prefix, and `../Design/Decisions` is what
    // every run ending at this tip draws when shortened -- the last two
    // segments are fixed by the path. So a run whose head moved would keep a
    // decision taken about a label it no longer has. `setChainIndex` is where
    // that is caught, because `main.ts` hands over the same index OBJECT while
    // the runs are unchanged.
    const container = mount();
    let fits = false;
    const a = new ExplorerAdapter(() => !fits);
    a.bind(container);
    a.setChainIndex(DEEP, ON);
    a.apply(SNAP);
    const title = container.querySelector("[data-path]") as HTMLElement;
    expect(title.textContent!.trim()).toBe("../Design/Decisions");

    // A sibling appears under `Research`: the run now starts at `2026`, and
    // the full label is short enough to fit.
    fits = true;
    a.setChainIndex(SHALLOWER, ON);
    a.apply(SNAP);
    expect(title.textContent!.trim()).toBe(SHALLOWER_FULL);
    expect(title.hasAttribute("aria-label")).toBe(false);
    a.unbind();
  });

  it("disconnects the previous observers when the panes are rebound", () => {
    // `bindAll` unbinds first, which is also what keeps a split explorer from
    // accumulating one observer per layout change.
    const container = mount();
    const a = new ExplorerAdapter();
    a.bind(container);
    a.bind(container);
    expect(made().length).toBe(2);
    expect(made()[0].disconnected).toBe(1);
    a.unbind();
    expect(made()[1].disconnected).toBe(1);
  });
});

/**
 * THE PASS MUST STOP, and nothing else in this file can tell that it does.
 *
 * Every other test here drives `applyCompactLabels` or `applyNow` by hand, one
 * call at a time, so none of them can see a pass that SCHEDULES ANOTHER ONE.
 * The adapter's MutationObserver watches the container the pass writes into,
 * so a pass that keeps rewriting the prefix feeds that observer, which calls
 * `schedule()`, which runs the pass again, for as long as the plugin is
 * loaded. Measured on this branch with `remeasure` left latched: 17 label
 * passes in 600ms of an idle explorer, against 2 when it is cleared.
 *
 * What makes the chain terminate is one line -- `applyNow` consuming
 * `this.remeasure` rather than reading it -- and deleting that line passed the
 * whole suite before this test existed.
 *
 * REAL TIMERS, deliberately. The loop runs on the adapter's own
 * `requestAnimationFrame` and on the microtask turn a MutationObserver is
 * delivered in. A fake clock would have to be ASKED to advance, and a test
 * that asks for each iteration cannot notice the one it did not ask for.
 */
describe("the label pass settles", () => {
  let ro: ReturnType<typeof installFakeResizeObserver>;

  beforeEach(() => {
    ro = installFakeResizeObserver();
  });

  afterEach(() => {
    ro.restore();
    document.body.innerHTML = "";
  });

  /** Many animation frames wide, which is what a runaway pass would use. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

  it("stops after a resize instead of relabelling for as long as it is loaded", async () => {
    const container = mount();
    // Two independent counters: what the pass READ, and what it WROTE. The
    // loop shows up in both, and either one alone could be satisfied by an
    // adapter that had stopped doing the other.
    let measured = 0;
    let writes = 0;
    const a = new ExplorerAdapter(() => {
      measured++;
      return true;
    });
    const spy = new MutationObserver((records) => {
      writes += records.length;
    });
    try {
      a.bind(container);
      a.setChainIndex(DEEP, ON);
      a.apply(SNAP);
      const title = container.querySelector("[data-path]") as HTMLElement;
      expect(title.textContent!.trim()).toBe("../Design/Decisions");
      await settle();
      const idle = { measured, writes };

      spy.observe(container, { childList: true, subtree: true });
      ro.fire();
      await settle();
      // The resize was answered: the row was drawn in full, measured and
      // drawn short again, so both counters moved exactly once.
      const answered = { measured, writes };
      expect(answered.measured).toBeGreaterThan(idle.measured);
      expect(answered.writes).toBeGreaterThan(0);

      // And then nothing, through two further settles. An adapter that has
      // latched `remeasure` is measuring and rewriting on every frame by now.
      await settle();
      await settle();
      expect(measured).toBe(answered.measured);
      expect(writes).toBe(answered.writes);
      expect(title.textContent!.trim()).toBe("../Design/Decisions");
    } finally {
      spy.disconnect();
      a.unbind();
    }
  });
});
