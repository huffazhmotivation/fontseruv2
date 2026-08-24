/**
 * Kerning is intentionally kept out of the glyph geometry model
 * (types/geometry.ts) — it's a font-level adjustment between a pair of
 * glyphs, not part of either glyph's outline.
 */
export type KerningPairs = Record<string, number>;

/** Which pair keys were set by the user directly (vs by an auto-kern suggestion). Auto-kern must never overwrite these. */
export type KerningManualFlags = Record<string, boolean>;

import type { FontStyle } from "./glyph";

/**
 * Family kerning stays layered: `kerningPairs` is the shared layer and these
 * maps contain only style-specific differences. They are never materialized
 * into full per-style copies in persisted project state.
 */
export type KerningOverridesByStyle = Partial<Record<FontStyle, KerningPairs>>;
export type KerningOverrideManualByStyle = Partial<Record<FontStyle, KerningManualFlags>>;
export type KerningContext = "shared" | FontStyle;

export function effectiveKerningValue(
  shared: KerningPairs,
  overridesByStyle: KerningOverridesByStyle,
  style: FontStyle,
  left: string,
  right: string
): number {
  const key = kerningKey(left, right);
  return overridesByStyle[style]?.[key] ?? shared[key] ?? 0;
}

/**
 * Runtime-only merged view for layout/preview. The persisted model remains
 * Shared + sparse Style Override layers.
 */
export function effectiveKerningPairs(
  shared: KerningPairs,
  overridesByStyle: KerningOverridesByStyle,
  style: FontStyle
): KerningPairs {
  const override = overridesByStyle[style];
  return override && Object.keys(override).length ? { ...shared, ...override } : shared;
}

export function kerningKey(left: string, right: string): string {
  // URI-encoding keeps the legacy "A|V" form for ordinary glyphs while
  // making pairs containing the literal "|" glyph unambiguous.
  return `${encodeURIComponent(left)}|${encodeURIComponent(right)}`;
}

export function parseKerningKey(key: string): { left: string; right: string } | null {
  const idx = key.indexOf("|");
  if (idx <= 0 || idx === key.length - 1) return null;
  try {
    return { left: decodeURIComponent(key.slice(0, idx)), right: decodeURIComponent(key.slice(idx + 1)) };
  } catch {
    return null;
  }
}

/** Useful pair shortcuts for the Kerning panel. Global auto-kerning is not limited to this list. */
export const AUTO_KERN_PRIORITY_PAIRS: [string, string][] = [
  ["A", "V"], ["V", "A"],
  ["A", "W"], ["W", "A"],
  ["A", "Y"], ["Y", "A"],
  ["A", "T"], ["T", "A"],
  ["T", "o"], ["T", "a"], ["T", "e"], ["T", "y"],
  ["Y", "o"],
  ["L", "T"], ["L", "Y"], ["L", "V"],
  ["F", "A"], ["P", "A"],
  ["R", "A"], ["R", "T"],
  ["K", "O"], ["O", "O"],
];
