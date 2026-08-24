import type { GlyphOutline } from "./geometry";
import { totalNodeCount } from "./geometry";

export type GlyphCategory = "upper" | "lower" | "digits" | "punct" | "symbols" | "multilingual";

/**
 * One glyph in the working (master/Regular) font. `components` is left as
 * an architectural placeholder for composite glyphs added in a later phase.
 */
export interface Glyph {
  char: string;
  unicode: number;
  /** All Unicode code points mapped to this glyph; `unicode` is the primary mapping. */
  unicodes?: number[];
  /** Original glyph name when imported from an OpenType font. */
  name?: string;
  category: GlyphCategory;
  advanceWidth: number;
  lsb: number;
  rsb: number;
  outline: GlyphOutline;
  components: string[];
}

export type GlyphMap = Record<string, Glyph>;

export type FontStyle = "regular" | "bold" | "italic";
export type GlyphFamily = Record<FontStyle, GlyphMap>;

export const FONT_STYLES: ReadonlyArray<{ id: FontStyle; label: "Regular" | "Bold" | "Italic" }> = [
  { id: "regular", label: "Regular" },
  { id: "bold", label: "Bold" },
  { id: "italic", label: "Italic" },
];

export function fontStyleLabel(style: FontStyle): "Regular" | "Bold" | "Italic" {
  return FONT_STYLES.find((item) => item.id === style)?.label ?? "Regular";
}

export interface GlyphGroup {
  id: GlyphCategory;
  label: string;
  chars: string[];
}

export function hasOutline(glyph: Glyph): boolean {
  return totalNodeCount(glyph.outline) > 0;
}
