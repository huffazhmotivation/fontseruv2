import type { Glyph, GlyphMap } from "@/types/glyph";
import { hasOutline } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { outlineBounds, translateObject, cloneObjectWithNewIds } from "@/editor/objectOps";

/**
 * Multilingual Glyphs composer.
 *
 * Builds common accented Latin letters (and a couple of arithmetic symbols)
 * purely by REPOSITIONING clones of already-drawn base + mark outlines —
 * never redrawing or reshaping anything. A composite is only produced when
 * every glyph it needs already has real ink (`hasOutline`); anything that
 * can't be formed yet is left alone so the user's own drawing is what
 * ultimately defines the mark's shape.
 *
 * This intentionally reuses `Glyph.components` (already declared in
 * types/glyph.ts as "an architectural placeholder for composite glyphs" —
 * unused everywhere else in the app) to record the recipe, so re-running
 * the composer can tell a glyph is one of ours and never double-creates or
 * clobbers a hand-drawn glyph of the same character.
 */

type DiacriticPlacement = "capHeight" | "xHeight" | "below";

interface DiacriticRecipe {
  char: string;
  unicode: number;
  base: string;
  mark: string;
  placement: DiacriticPlacement;
}

// Mark characters most fonts won't have drawn yet — registered as empty
// placeholder slots (same as any other undrawn default glyph) so the user
// can draw them once, then every recipe using that mark becomes available.
export const MULTILINGUAL_MARK_SLOTS: { char: string; unicode: number }[] = [
  { char: "´", unicode: 0x00b4 }, // acute
  { char: "`", unicode: 0x0060 }, // grave
  { char: "¨", unicode: 0x00a8 }, // diaeresis
  { char: "¸", unicode: 0x00b8 }, // cedilla
];

// Arithmetic symbols that can't be safely formed by repositioning an
// existing letterform (× ÷ would need genuinely new artwork, not a
// reused "x" or "-") — registered as empty slots too so they're at least
// available to draw, without ever being auto-filled with a wrong shape.
export const MULTILINGUAL_SYMBOL_SLOTS: { char: string; unicode: number }[] = [
  { char: "×", unicode: 0x00d7 },
  { char: "÷", unicode: 0x00f7 },
];

// base + mark → composite. `^` and `~` (circumflex/tilde) and `°` (ring,
// reused for Å/å) already ship in the default Symbols set, so no extra
// mark slot is needed for those three.
const RECIPES: DiacriticRecipe[] = [
  // Acute
  ...pairs("AEIOUYaeiouy", "´", "acute"),
  // Grave
  ...pairs("AEIOUaeiou", "`", "grave"),
  // Diaeresis
  ...pairs("AEIOUaeiouy", "¨", "diaeresis"),
  // Circumflex (mark already in default Symbols)
  ...pairs("AEIOUaeiou", "^", "circumflex"),
  // Tilde (mark already in default Symbols)
  ...pairs("ANOano", "~", "tilde"),
  // Ring above (mark already in default Symbols, as °)
  ...pairs("Aa", "°", "ring"),
  // Cedilla (below)
  { char: "Ç", unicode: 0x00c7, base: "C", mark: "¸", placement: "below" },
  { char: "ç", unicode: 0x00e7, base: "c", mark: "¸", placement: "below" },
];

function accentedCodepoint(base: string, markKind: string): number | null {
  // Precomputed via Unicode NFC composition for the exact base+mark pairs
  // this file uses; kept as a lookup (not String.normalize at runtime)
  // so the recipe table above stays the single source of truth.
  const TABLE: Record<string, Record<string, number>> = {
    acute: { A: 0xc1, E: 0xc9, I: 0xcd, O: 0xd3, U: 0xda, Y: 0xdd, a: 0xe1, e: 0xe9, i: 0xed, o: 0xf3, u: 0xfa, y: 0xfd },
    grave: { A: 0xc0, E: 0xc8, I: 0xcc, O: 0xd2, U: 0xd9, a: 0xe0, e: 0xe8, i: 0xec, o: 0xf2, u: 0xf9 },
    diaeresis: { A: 0xc4, E: 0xcb, I: 0xcf, O: 0xd6, U: 0xdc, a: 0xe4, e: 0xeb, i: 0xef, o: 0xf6, u: 0xfc, y: 0xff },
    circumflex: { A: 0xc2, E: 0xca, I: 0xce, O: 0xd4, U: 0xdb, a: 0xe2, e: 0xea, i: 0xee, o: 0xf4, u: 0xfb },
    tilde: { A: 0xc3, N: 0xd1, O: 0xd5, a: 0xe3, n: 0xf1, o: 0xf5 },
    ring: { A: 0xc5, a: 0xe5 },
  };
  return TABLE[markKind]?.[base] ?? null;
}

function pairs(bases: string, markChar: string, markKind: string): DiacriticRecipe[] {
  const out: DiacriticRecipe[] = [];
  for (const base of bases) {
    const unicode = accentedCodepoint(base, markKind);
    if (unicode === null) continue;
    const isLower = base === base.toLowerCase() && base !== base.toUpperCase();
    out.push({
      char: String.fromCodePoint(unicode),
      unicode,
      base,
      mark: markChar,
      placement: isLower ? "xHeight" : "capHeight",
    });
  }
  return out;
}

export interface MultilingualResult {
  glyphs: GlyphMap;
  created: number;
  markSlotsAdded: number;
  symbolSlotsAdded: number;
  skippedExisting: number;
}

function emptySlotGlyph(char: string, unicode: number, template: Glyph | undefined): Glyph {
  return {
    char,
    unicode,
    category: "multilingual",
    advanceWidth: template?.advanceWidth ?? 600,
    lsb: template?.lsb ?? 60,
    rsb: template?.rsb ?? 60,
    outline: { objects: [] },
    components: [],
  };
}

function composeOne(base: Glyph, mark: Glyph, recipe: DiacriticRecipe, metrics: FontMetrics): Glyph | null {
  const baseBounds = outlineBounds(base.outline);
  const markBounds = outlineBounds(mark.outline);
  if (!baseBounds || !markBounds) return null;

  const gap = metrics.unitsPerEm * 0.02;
  const baseCenterX = (baseBounds.minX + baseBounds.maxX) / 2;
  const markCenterX = (markBounds.minX + markBounds.maxX) / 2;
  const dx = baseCenterX - markCenterX;
  const dy =
    recipe.placement === "below"
      ? metrics.baseline - markBounds.maxY
      : (recipe.placement === "capHeight" ? metrics.capHeight : metrics.xHeight) + gap - markBounds.minY;

  const baseObjects = base.outline.objects.map((o) => cloneObjectWithNewIds(o));
  const markObjects = mark.outline.objects.map((o) => translateObject(cloneObjectWithNewIds(o), dx, dy));

  return {
    char: recipe.char,
    unicode: recipe.unicode,
    category: "multilingual",
    advanceWidth: base.advanceWidth,
    lsb: base.lsb,
    rsb: base.rsb,
    outline: { objects: [...baseObjects, ...markObjects] },
    components: [recipe.base, recipe.mark],
  };
}

/**
 * Pure function: given the current Regular glyph map + font metrics,
 * returns an updated map with every composable multilingual glyph added,
 * plus empty placeholder slots for marks/symbols that don't exist yet.
 * Never overwrites a glyph that already has an outline (hand-drawn or
 * composed earlier) — safe to call repeatedly with zero duplicates.
 */
export function composeMultilingualGlyphs(glyphs: GlyphMap, metrics: FontMetrics): MultilingualResult {
  const next: GlyphMap = { ...glyphs };
  let created = 0;
  let markSlotsAdded = 0;
  let symbolSlotsAdded = 0;
  let skippedExisting = 0;

  for (const slot of MULTILINGUAL_MARK_SLOTS) {
    if (!next[slot.char]) {
      next[slot.char] = emptySlotGlyph(slot.char, slot.unicode, next["a"]);
      markSlotsAdded++;
    }
  }
  for (const slot of MULTILINGUAL_SYMBOL_SLOTS) {
    if (!next[slot.char]) {
      next[slot.char] = emptySlotGlyph(slot.char, slot.unicode, next["a"]);
      symbolSlotsAdded++;
    }
  }

  for (const recipe of RECIPES) {
    const existing = next[recipe.char];
    if (existing && hasOutline(existing)) {
      skippedExisting++;
      continue;
    }
    const base = next[recipe.base];
    const mark = next[recipe.mark];
    if (!base || !hasOutline(base)) continue;
    if (!mark || !hasOutline(mark)) continue;
    const composite = composeOne(base, mark, recipe, metrics);
    if (!composite) continue;
    next[recipe.char] = composite;
    created++;
  }

  return { glyphs: next, created, markSlotsAdded, symbolSlotsAdded, skippedExisting };
}
