/**
 * The color conversions and pointer mapping, pure.
 *
 * Exists because the picker is EMBEDDED: `<input type="color">` was the first
 * implementation and it hands off to the operating system's own dialog, which
 * is a second window on top of the popover — the opposite of putting the
 * picker in the popover. Drawing the field ourselves means owning the maths,
 * and maths belongs somewhere it can be tested.
 */

export interface Hsv {
  /** Degrees, 0–360. */
  h: number;
  /** 0–1. */
  s: number;
  /** 0–1. */
  v: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Wraps rather than clamps: hue is a circle, and 370° is 10°. */
export function wrapHue(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const h = deg % 360;
  return h < 0 ? h + 360 : h;
}

function toHex2(n: number): string {
  return Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, "0");
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = wrapHue(h) / 60;
  const sat = clamp01(s);
  const val = clamp01(v);
  const c = val * sat;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = val - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 1) [r, g, b] = [c, x, 0];
  else if (hue < 2) [r, g, b] = [x, c, 0];
  else if (hue < 3) [r, g, b] = [0, c, x];
  else if (hue < 4) [r, g, b] = [0, x, c];
  else if (hue < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `#${toHex2(r + m)}${toHex2(g + m)}${toHex2(b + m)}`;
}

/**
 * Null for anything that is not a 6-digit hex — the caller decides what to do
 * with an unparseable field rather than being handed a silent black.
 */
export function hexToHsv(hex: string): Hsv | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: wrapHue(h), s: max === 0 ? 0 : d / max, v: max };
}

/**
 * Saturation/value from a pointer inside the field.
 *
 * Left is white and bottom is black, matching how the gradient is painted, so
 * `s` runs with x and `v` runs against y. Clamped, because a pointer captured
 * during a drag reports coordinates outside the element and the swatch should
 * pin to the edge rather than wrap or go blank.
 */
export function svFromPoint(x: number, y: number, width: number, height: number): Pick<Hsv, "s" | "v"> {
  if (!(width > 0) || !(height > 0)) return { s: 0, v: 0 };
  return { s: clamp01(x / width), v: clamp01(1 - y / height) };
}

/** Hue from a pointer along the bar. Clamped for the same reason. */
export function hueFromPoint(x: number, width: number): number {
  if (!(width > 0)) return 0;
  return clamp01(x / width) * 360;
}
