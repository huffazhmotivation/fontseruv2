import type { Glyph, GlyphGroup, GlyphMap } from "@/types/glyph";
import { emptyOutline } from "@/types/geometry";

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const DIGITS = "0123456789".split("");
const PUNCT = ".,:;!?'\"-–—()[]{}/\\@#&*_%".split("");
const SYMBOLS = "+=<>~^$€£¥§©®™°|".split("");

export const GLYPH_GROUPS: GlyphGroup[] = [
  { id: "upper", label: "Uppercase", chars: UPPER },
  { id: "lower", label: "Lowercase", chars: LOWER },
  { id: "digits", label: "Numbers", chars: DIGITS },
  { id: "punct", label: "Punctuation", chars: PUNCT },
  { id: "symbols", label: "Symbols", chars: SYMBOLS },
  // Populated on demand by "+ Multilingual Glyphs" (src/glyph/multilingual.ts).
  // Starts empty like every other group's base list — glyphs show up here
  // via the same "extras by category" mechanism already used for imported
  // chars, so no other file needs to know this group exists.
  { id: "multilingual", label: "Multilingual", chars: [] },
];

/**
 * Flattened glyph order the whole app agrees on: Uppercase → Lowercase →
 * Numbers → Punctuation → Symbols, each group's own imported extras sorted
 * by code point, followed by anything left over. Mirrors the grouping
 * GlyphNav already renders (see its `filteredGroups`), just without the
 * search-query filter, so Prev/Next glyph navigation always agrees with
 * what's shown in the glyph list.
 */
export function getOrderedChars(glyphs: GlyphMap): string[] {
  const baseChars = new Set(GLYPH_GROUPS.flatMap((g) => g.chars));
  const extrasByCategory = new Map<string, string[]>();
  for (const [ch, glyph] of Object.entries(glyphs)) {
    if (baseChars.has(ch)) continue;
    const arr = extrasByCategory.get(glyph.category) ?? [];
    arr.push(ch);
    extrasByCategory.set(glyph.category, arr);
  }
  const ordered: string[] = [];
  for (const group of GLYPH_GROUPS) {
    for (const ch of group.chars) if (glyphs[ch]) ordered.push(ch);
    const extras = (extrasByCategory.get(group.id) ?? []).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
    ordered.push(...extras);
  }
  const assigned = new Set(ordered);
  const remaining = Object.keys(glyphs)
    .filter((ch) => !assigned.has(ch))
    .sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
  ordered.push(...remaining);
  return ordered;
}

export function buildDefaultGlyphs(): GlyphMap {
  const map: GlyphMap = {};
  for (const group of GLYPH_GROUPS) {
    for (const ch of group.chars) {
      const glyph: Glyph = {
        char: ch,
        unicode: ch.codePointAt(0) ?? 0,
        category: group.id,
        advanceWidth: 600,
        lsb: 60,
        rsb: 60,
        outline: emptyOutline(),
        components: [],
      };
      map[ch] = glyph;
    }
  }
  return map;
}
