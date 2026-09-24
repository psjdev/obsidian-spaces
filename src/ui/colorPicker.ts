/**
 * The color picker rules, pure (no DOM, no `"obsidian"` import).
 *
 * A space's color has always been a 6-digit hex string, validated by
 * `schema.ts`'s `COLOR` regex; everything here keeps that shape so a custom
 * color is indistinguishable from a palette one once stored.
 */

import { normalizeHex } from "../definitions/appearance";

/**
 * `normalizeHex` moved to `definitions/appearance.ts`. It decides what
 * may be written to `data.json` as a space color, which is domain validation
 * — the same category as `schema.ts`'s `isSafeVaultPath` — and
 * `actions/spaceLifecycle.ts` was importing it up out of this layer.
 * Re-exported because `ui/ColorPickerPopover.ts`, owned by another branch of
 * this fix wave, imports it from here.
 */
export { normalizeHex } from "../definitions/appearance";

/** How many custom chips are kept. Oldest is evicted, newest first. */
export const MAX_CUSTOM_COLORS = 12;

const HEX6 = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: string): boolean {
  return HEX6.test(value);
}

/**
 * Adds a custom color, newest first, de-duplicated against the built-in
 * palette as well as the existing customs — a chip that duplicates a palette
 * swatch is a second button that does the same thing.
 */
export function addCustomColor(
  customs: readonly string[],
  palette: readonly string[],
  color: string,
  max = MAX_CUSTOM_COLORS
): string[] {
  const hex = normalizeHex(color);
  if (!hex) return [...customs];
  const paletteSet = new Set(palette.map((c) => c.toLowerCase()));
  if (paletteSet.has(hex)) return [...customs];
  const without = customs.filter((c) => c.toLowerCase() !== hex);
  return [hex, ...without].slice(0, max);
}

export function removeCustomColor(customs: readonly string[], color: string): string[] {
  const hex = normalizeHex(color);
  if (!hex) return [...customs];
  return customs.filter((c) => c.toLowerCase() !== hex);
}

interface ColorSwatch {
  color: string;
  /** Palette swatches carry a name; a custom one has only its hex. */
  label: string;
  selected: boolean;
  custom: boolean;
  /**
   * Whether this chip can be deleted. Distinct from `custom` on purpose: the
   * chip synthesised for a current color that nothing else lists is NOT in
   * `customs`, so offering to delete it would be a button that does nothing.
   * Built-in palette colors are never removable — they are the floor the
   * picker always falls back to.
   */
  removable: boolean;
}

/**
 * The chips to render: the built-in palette first, then any custom colors.
 *
 * The current color is marked even when it is neither — a space created
 * before a palette change, or a hand-edited `data.json` — because showing
 * nothing selected would suggest the space has no color at all.
 */
export function colorSwatches(args: {
  palette: readonly string[];
  paletteNames: readonly string[];
  customs: readonly string[];
  current: string;
}): ColorSwatch[] {
  const current = normalizeHex(args.current) ?? args.current.toLowerCase();
  const out: ColorSwatch[] = args.palette.map((color, i) => ({
    color,
    label: args.paletteNames[i] ?? color,
    selected: color.toLowerCase() === current,
    custom: false,
    removable: false,
  }));
  const seen = new Set(args.palette.map((c) => c.toLowerCase()));
  for (const color of args.customs) {
    const hex = normalizeHex(color);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push({
      color: hex,
      label: hex,
      selected: hex === current,
      custom: true,
      removable: true,
    });
  }
  // The stored color belongs on screen even if nothing else lists it.
  if (!out.some((s) => s.selected)) {
    const hex = normalizeHex(args.current);
    // Shown for reference, not saved — so not removable.
    if (hex) {
      out.push({ color: hex, label: hex, selected: true, custom: true, removable: false });
    }
  }
  return out;
}
