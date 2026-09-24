import { Notice, setIcon } from "obsidian";
import { AnchoredPopover } from "./AnchoredPopover";
import { swatchPaint } from "./spaceIconColor";
import { PALETTE, PALETTE_NAMES } from "../actions/spaceLifecycle";
import {
  addCustomColor,
  colorSwatches,
  normalizeHex,
  removeCustomColor,
} from "./colorPicker";
import { hexToHsv, hsvToHex, hueFromPoint, svFromPoint, type Hsv } from "./colorMath";

/**
 * The "Change Space Colour…" picker.
 *
 * Two views in one popover, in the manner of the icon picker: the
 * palette plus any custom chips, and — behind a `+` — a colour picker for
 * making a new chip. Positioning and dismissal come from `AnchoredPopover`, so
 * both pickers behave identically and cannot drift apart.
 *
 * It decides nothing: which chips exist, how a custom one is added and
 * de-duplicated, and what counts as a colour are all in `colorPicker.ts`,
 * tested in plain node.
 */
interface ColorPickerDeps {
  anchor: HTMLElement;
  /** Passed through to `AnchoredPopover`; see its `placement`. */
  placement?: "above" | "below";
  current: string;
  customs: readonly string[];
  /** Apply a colour to the space. Rejects on a failed write. */
  apply(color: string): Promise<void>;
  /** Persist the custom chip list. Rejects on a failed write. */
  saveCustoms(customs: string[]): Promise<void>;
}

/** Returns the popover so its opener can close it (see `AnchoredPopover`). */
export function openColorPicker(deps: ColorPickerDeps): AnchoredPopover {
  let customs = [...deps.customs];
  let mode: "palette" | "custom" = "palette";

  const popover = new AnchoredPopover({
    anchor: deps.anchor,
    placement: deps.placement,
    className: "spaces-color-popover",
    ariaLabel: "Choose a colour",
    build: (root, pop) => render(root, pop),
  });

  function fail(err: unknown): void {
    new Notice(`Spaces: could not change the colour (${String(err)})`);
  }

  function render(root: HTMLElement, pop: AnchoredPopover): void {
    root.replaceChildren();
    const doc = root.ownerDocument;

    if (mode === "custom") {
      renderCustom(root, doc, pop);
    } else {
      renderPalette(root, doc, pop);
    }
    // The two views differ in height, so the anchor-relative position has to be
    // recomputed or switching leaves the popover floating off the strip.
    pop.reposition();
  }

  function renderPalette(root: HTMLElement, doc: Document, pop: AnchoredPopover): void {
    const grid = doc.win.createDiv();
    grid.className = "spaces-color-grid";

    for (const sw of colorSwatches({
      palette: PALETTE,
      paletteNames: PALETTE_NAMES,
      customs,
      current: deps.current,
    })) {
      const cell = doc.win.createDiv();
      cell.className = "spaces-color-cell";
      cell.setAttribute("role", "button");
      cell.setAttribute("tabindex", "0");
      // A name, never the colour alone — a swatch announces nothing.
      cell.setAttribute("aria-label", sw.label);
      cell.setAttribute("aria-pressed", String(sw.selected));
      // `swatchPaint`, not `sw.color`: the neutral chip previews the theme's
      // icon colour, which is what a space on it renders in. `sw.color` is
      // still what gets applied on click, because that is what is stored.
      cell.style.backgroundColor = swatchPaint(sw.color);
      if (sw.selected) cell.classList.add("is-selected");
      const choose = (): void => {
        void deps.apply(sw.color).catch(fail);
        pop.close();
      };
      cell.addEventListener("click", choose);

      if (sw.removable) {
        const remove = (): void => {
          customs = removeCustomColor(customs, sw.color);
          void deps.saveCustoms(customs).catch(fail);
          // Only the chip goes. A space wearing this colour KEEPS it: the
          // colour is stored on the space, not a reference to the chip, and
          // `colorSwatches` still shows it as the current selection. Changing
          // a space's appearance as a side effect of tidying a palette would
          // be a surprise.
          render(root, pop);
        };

        const del = doc.win.createDiv();
        del.className = "spaces-color-remove";
        del.setAttribute("role", "button");
        del.setAttribute("tabindex", "0");
        del.setAttribute("aria-label", `Delete colour ${sw.label}`);
        // An SVG, not a text "×". The character's ink box is not vertically
        // centred in its em box — measured at 0.7px high in a 14px badge,
        // because flex centres the LINE box and the glyph sits above it. A
        // lucide icon is symmetric by construction and takes an exact size.
        setIcon(del, "x");
        del.addEventListener("click", (e) => {
          // Without this the click also reaches the chip and applies the very
          // colour being deleted.
          e.stopPropagation();
          remove();
        });
        del.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            remove();
          }
        });
        cell.appendChild(del);

        // Keyboard route that does not require reaching the × itself.
        cell.addEventListener("keydown", (e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            remove();
          }
        });
      }

      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose();
        }
      });
      grid.appendChild(cell);
    }

    // The + that opens the colour picker, styled as a chip so it reads as one
    // more slot in the palette rather than a control bolted beside it.
    const add = doc.win.createDiv();
    add.className = "spaces-color-cell spaces-color-add";
    add.setAttribute("role", "button");
    add.setAttribute("tabindex", "0");
    add.setAttribute("aria-label", "Add a custom colour");
    add.textContent = "+";
    const openCustom = (): void => {
      mode = "custom";
      render(root, pop);
    };
    add.addEventListener("click", openCustom);
    add.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCustom();
      }
    });
    grid.appendChild(add);
    root.appendChild(grid);
  }

  function renderCustom(root: HTMLElement, doc: Document, pop: AnchoredPopover): void {
    // EMBEDDED, not `<input type="color">`: that opens the operating system's
    // own dialog on top of this popover, which is a second window rather than
    // a picker in the popover.
    let hsv: Hsv = hexToHsv(normalizeHex(deps.current) ?? "#5b5bff") ?? {
      h: 240,
      s: 0.64,
      v: 1,
    };

    const wrap = doc.win.createDiv();
    wrap.className = "spaces-color-custom";

    // --- saturation / value field ---
    const field = doc.win.createDiv();
    field.className = "spaces-sv-field";
    const fieldDot = doc.win.createDiv();
    fieldDot.className = "spaces-picker-dot";
    field.appendChild(fieldDot);
    wrap.appendChild(field);

    // --- hue bar ---
    const hue = doc.win.createDiv();
    hue.className = "spaces-hue-bar";
    const hueDot = doc.win.createDiv();
    hueDot.className = "spaces-picker-dot";
    hue.appendChild(hueDot);
    wrap.appendChild(hue);

    // --- preview + hex ---
    const row = doc.win.createDiv();
    row.className = "spaces-color-row";
    const preview = doc.win.createDiv();
    preview.className = "spaces-color-preview";
    const hex = doc.win.createEl("input");
    hex.type = "text";
    hex.className = "spaces-color-hex";
    hex.setAttribute("aria-label", "Colour hex value");
    // "Hex value" rather than a "#5b5bff" sample: Obsidian lints UI text for
    // sentence case, and the only spelling of a hex sample that rule accepts
    // is "#5B5bff", which reads as a typo. The aria-label carries the rest.
    hex.placeholder = "Hex value";
    row.appendChild(preview);
    row.appendChild(hex);
    wrap.appendChild(row);

    /** Paints every control from `hsv`. `skipHex` while the user is typing. */
    const paint = (skipHex = false): void => {
      const hexValue = hsvToHex(hsv);
      field.style.backgroundColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
      fieldDot.style.left = `${hsv.s * 100}%`;
      fieldDot.style.top = `${(1 - hsv.v) * 100}%`;
      fieldDot.style.backgroundColor = hexValue;
      hueDot.style.left = `${(hsv.h / 360) * 100}%`;
      hueDot.style.backgroundColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
      preview.style.backgroundColor = hexValue;
      if (!skipHex) hex.value = hexValue;
      hex.removeClass("is-invalid");
    };

    /**
     * Pointer capture, so a drag that leaves the element keeps updating —
     * without it the swatch freezes the moment the pointer crosses the edge,
     * which is exactly when someone is reaching for pure white or black.
     */
    const track = (el: HTMLElement, onPoint: (e: PointerEvent, r: DOMRect) => void): void => {
      const handle = (e: PointerEvent): void => {
        onPoint(e, el.getBoundingClientRect());
        paint();
      };
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        handle(e);
      });
      el.addEventListener("pointermove", (e) => {
        if (!el.hasPointerCapture(e.pointerId)) return;
        handle(e);
      });
      el.addEventListener("pointerup", (e) => el.releasePointerCapture(e.pointerId));
    };

    track(field, (e, r) => {
      const { s: sat, v } = svFromPoint(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
      hsv = { ...hsv, s: sat, v };
    });
    track(hue, (e, r) => {
      hsv = { ...hsv, h: hueFromPoint(e.clientX - r.left, r.width) };
    });

    hex.addEventListener("input", () => {
      const parsed = normalizeHex(hex.value);
      const next = parsed ? hexToHsv(parsed) : null;
      if (!next) {
        hex.addClass("is-invalid");
        return;
      }
      hsv = next;
      // skipHex: rewriting the field mid-keystroke would fight the caret.
      paint(true);
    });

    const actions = doc.win.createDiv();
    actions.className = "spaces-color-actions";

    const addBtn = doc.win.createEl("button");
    addBtn.className = "mod-cta";
    addBtn.textContent = "Add colour";
    addBtn.addEventListener("click", () => {
      const parsed = normalizeHex(hex.value) ?? hsvToHex(hsv);
      // Persist the chip AND apply it: adding a colour you then have to click
      // again would be a pointless second step.
      customs = addCustomColor(customs, PALETTE, parsed);
      void deps.saveCustoms(customs).catch(fail);
      void deps.apply(parsed).catch(fail);
      pop.close();
    });

    const back = doc.win.createEl("button");
    back.textContent = "Back";
    back.addEventListener("click", () => {
      mode = "palette";
      render(root, pop);
    });

    actions.appendChild(addBtn);
    actions.appendChild(back);
    wrap.appendChild(actions);
    root.appendChild(wrap);
    paint();
  }

  popover.open();
  return popover;
}
