import type { Glyph } from "@/types/glyph";
import { kerningKey } from "@/types/kerning";

export interface PlacedChar {
  char: string;
  /** Pen position (font units) where this glyph's advance box starts. */
  x: number;
  /** The glyph's own advance width in font units (tracking is between glyphs). */
  advance: number;
}

export interface LineLayout {
  placed: PlacedChar[];
  /** Total horizontal advance of the line, in font units (>= 0). */
  totalAdvance: number;
}

/** Fallback advance for characters with no glyph (space, or unsupported input) so layout doesn't collapse. */
export function fallbackAdvance(char: string, unitsPerEm: number): number {
  return char === " " ? unitsPerEm * 0.27 : unitsPerEm * 0.5;
}

/**
 * One shared text-layout source of truth for FontSeru rendering and editing.
 * Tracking lives BETWEEN glyphs, then pair kerning is applied immediately
 * before the following glyph. The renderer, caret, hit-testing and Kerning
 * Lab all consume these exact positions.
 */
export function layoutLine(
  text: string,
  glyphs: Record<string, Glyph | undefined>,
  unitsPerEm: number,
  kerningPairs: Record<string, number>,
  trackingUnits = 0
): LineLayout {
  const chars = Array.from(text);
  let penX = 0;
  const placed: PlacedChar[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (i > 0) {
      const prev = chars[i - 1];
      penX += trackingUnits;
      penX += kerningPairs[kerningKey(prev, ch)] ?? 0;
    }

    const g = glyphs[ch];
    const advance = g ? g.advanceWidth : fallbackAdvance(ch, unitsPerEm);
    placed.push({ char: ch, x: penX, advance });
    penX += advance;
  }

  return { placed, totalAdvance: Math.max(0, penX) };
}

/**
 * Font-unit X of the visual insertion caret. Between two glyphs the caret
 * sits halfway through the tracking/kerning gap instead of being pinned to
 * the next glyph origin. This prevents the caret from visually crowding the
 * following outline while preserving the exact FontSeru layout.
 */
export function caretX(placed: PlacedChar[], col: number): number {
  if (placed.length === 0 || col <= 0) return 0;
  if (col >= placed.length) {
    const last = placed[placed.length - 1];
    return last.x + last.advance;
  }
  const prev = placed[col - 1];
  const next = placed[col];
  const prevEnd = prev.x + prev.advance;
  return (prevEnd + next.x) / 2;
}

/**
 * Character index (0..placed.length) nearest to a client-derived x in font
 * units. Hit-testing uses the same insertion boundaries as the visual caret.
 */
export function nearestCaretColumn(placed: PlacedChar[], xUnits: number): number {
  if (placed.length === 0) return 0;
  let bestCol = 0;
  let bestDist = Math.abs(xUnits - caretX(placed, 0));
  for (let col = 1; col <= placed.length; col++) {
    const dist = Math.abs(xUnits - caretX(placed, col));
    if (dist < bestDist) {
      bestDist = dist;
      bestCol = col;
    }
  }
  return bestCol;
}

/** Glyph index nearest to x, used by the glyph-centric kerning workflow. */
export function nearestGlyphIndex(placed: PlacedChar[], xUnits: number): number {
  if (placed.length === 0) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const center = p.x + p.advance / 2;
    const dist = Math.abs(xUnits - center);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}
