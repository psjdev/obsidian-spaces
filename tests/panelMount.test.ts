// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isStillCovering, resyncInertSiblings } from "../src/ui/panelMount";

/**
 * `isStillCovering` and `resyncInertSiblings` are the only two rules in the
 * create-space panel that needed two correctness revisions each — a
 * container-identity fix, and a sibling-inert re-sync fix — and had zero test
 * coverage either time: `container === mountedContainer` could be weakened
 * to `container !== null` and the suite stayed green. These tests exist
 * specifically to make each of the three named regressions fail a test, not
 * just to exercise the happy path.
 *
 * DOM built by hand — a parent (`leafRoot`) with `.nav-files-container`, a
 * header, a switcher, and the panel's own element — rather than importing
 * `CreateSpacePanel.ts`, which imports `"obsidian"` (a types-only package
 * with no runtime module: `"main": ""` in its `package.json`) and would
 * throw at import time in a plain Vitest run.
 */

function buildPane(): { parent: HTMLElement; navFiles: HTMLElement; header: HTMLElement; el: HTMLElement } {
  const parent = document.createElement("div");
  const header = document.createElement("div");
  header.className = "nav-header";
  const navFiles = document.createElement("div");
  navFiles.className = "nav-files-container";
  const el = document.createElement("div");
  el.className = "spaces-create-panel";
  parent.append(header, navFiles, el);
  document.body.appendChild(parent);
  return { parent, navFiles, header, el };
}

describe("isStillCovering", () => {
  it("is true when the panel is still parented under leafRoot AND covering the same container it recorded", () => {
    const { parent, navFiles, el } = buildPane();
    expect(isStillCovering(el, navFiles, parent, navFiles)).toBe(true);
  });

  it("is false when the container was rebuilt (a new node), even though leafRoot itself is unchanged", () => {
    // The regression this guards: changeLayout() can destroy and recreate
    // .nav-files-container while containerEl (leafRoot) persists. A
    // parent-identity-only check (the earlier `isMountedIn`) stayed true
    // here, which is exactly what let a rebuilt, un-inerted tree sit live
    // behind the panel.
    const { parent, navFiles, el } = buildPane();
    const mountedContainer = navFiles;
    // Simulate the rebuild: the OLD container is replaced by a new one
    // under the SAME parent. `el` (the panel) is untouched — it is a
    // sibling of .nav-files-container, not a descendant of it.
    const rebuiltContainer = document.createElement("div");
    rebuiltContainer.className = "nav-files-container";
    navFiles.replaceWith(rebuiltContainer);

    // Named mutation (Important 3): `container === mountedContainer` ->
    // `container !== null`. Under that mutation this assertion fails,
    // because `rebuiltContainer` is non-null and the weakened check would
    // return true.
    expect(isStillCovering(el, mountedContainer, parent, rebuiltContainer)).toBe(false);
  });

  it("is false when the panel's own element is no longer parented under leafRoot", () => {
    const { parent, navFiles, el } = buildPane();
    el.remove();
    expect(isStillCovering(el, navFiles, parent, navFiles)).toBe(false);
  });
});

describe("resyncInertSiblings", () => {
  it("does not take ownership of a sibling that was already inert for an unrelated reason", () => {
    // Named mutation (Important 3): removing "|| child.inert" from the
    // second loop's skip condition, leaving only the "already recorded"
    // check. Under that mutation this externally-inert sibling — never
    // recorded by this panel — gets swept into inertSiblings anyway, and
    // the assertion below fails.
    const { parent, navFiles, header, el } = buildPane();
    const external = document.createElement("div");
    external.inert = true; // set by someone else, before resync ever runs
    parent.appendChild(external);

    const inertSiblings: HTMLElement[] = [];
    resyncInertSiblings(el, inertSiblings, parent);

    expect(inertSiblings).not.toContain(external);
    // The normal job still happens for siblings that are NOT already inert.
    expect(inertSiblings).toContain(header);
    expect(inertSiblings).toContain(navFiles);
    expect(header.inert).toBe(true);
    expect(navFiles.inert).toBe(true);
  });

  it("drops and un-inerts a recorded sibling no longer parented under leafRoot, and picks up its live replacement", () => {
    // Named mutation (Important 3): removing the cleanup loop (the one
    // that drops/un-inerts siblings whose parentElement !== parent).
    // Under that mutation, `switcherV1.inert` is never reset to `false` —
    // stranding `inert` on the detached node exactly as the review
    // described — and this assertion fails.
    const { parent, el } = buildPane();
    const switcherV1 = document.createElement("div");
    switcherV1.className = "spaces-switcher";
    switcherV1.inert = true;
    parent.appendChild(switcherV1);
    const inertSiblings: HTMLElement[] = [switcherV1];

    // Simulate SwitcherView.mount(): destroy the old element, append a
    // brand-new one — this happens on EVERY layout-change, independent of
    // whether the panel is being kept open.
    switcherV1.remove();
    const switcherV2 = document.createElement("div");
    switcherV2.className = "spaces-switcher";
    parent.appendChild(switcherV2);

    resyncInertSiblings(el, inertSiblings, parent);

    expect(switcherV1.inert).toBe(false);
    expect(inertSiblings).not.toContain(switcherV1);
    expect(inertSiblings).toContain(switcherV2);
    expect(switcherV2.inert).toBe(true);
  });

  it("does nothing when there is no panel element (the null guard)", () => {
    const { parent } = buildPane();
    const sibling = document.createElement("div");
    parent.appendChild(sibling);
    const inertSiblings: HTMLElement[] = [];
    resyncInertSiblings(null, inertSiblings, parent);
    expect(inertSiblings).toHaveLength(0);
    // jsdom returns `undefined`, not the spec's default `false`, for
    // `.inert` on an element it was never set on — `toBeFalsy` avoids
    // asserting an exactness this jsdom version does not provide (the
    // real point of this test is the early-return; the untouched sibling
    // is just evidence the function never got that far).
    expect(sibling.inert).toBeFalsy();
  });
});
