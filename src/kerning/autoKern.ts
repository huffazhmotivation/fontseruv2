import type { GlyphMap } from "@/types/glyph";
import type { FontMetrics } from "@/types/font";
import { outlineBounds } from "@/editor/objectOps";
import { kerningKey } from "@/types/kerning";

/**
 * A geometry-based kerning suggestion.
 *
 * This deliberately analyzes the *whole-glyph ink bounding box* (via the
 * same `outlineBounds` used elsewhere for selection/fit — it flattens
 * Bézier segments, so curve bulges count) rather than a true per-scanline
 * optical kerning profile. A profile-based approach would catch things
 * like a diagonal stroke's varying protrusion at different heights; this
 * bounding-box approximation can't. It's a real analysis of the user's
 * actual letterforms, not a static pair table — but, matching the
 * original project brief's own framing, it's meant as "a strong starting
 * point, not perfect professional typography."
 *
 * For a glyph with no outline drawn yet, falls back to its side-bearing
 * metrics (advanceWidth/lsb/rsb) so a sensible suggestion still exists
 * before anything has been drawn.
 */
const TARGET_GAP_RATIO = 0.09; // ~ comfortable optical gap, as a fraction of UPM
const MIN_KERN_RATIO = -0.22;
const MAX_KERN_RATIO = 0.08;

export function suggestKerningPair(glyphs: GlyphMap, metrics: FontMetrics, left: string, right: string): number {
  const l = glyphs[left];
  const r = glyphs[right];
  if (!l || !r) return 0;

  const lBounds = outlineBounds(l.outline);
  const rBounds = outlineBounds(r.outline);

  const leftInkRight = lBounds ? lBounds.maxX : l.advanceWidth - l.rsb;
  const leftGap = Math.max(0, l.advanceWidth - leftInkRight);

  const rightInkLeft = rBounds ? rBounds.minX : r.lsb;
  const rightGap = Math.max(0, rightInkLeft);

  const naturalGap = leftGap + rightGap;
  const targetGap = metrics.unitsPerEm * TARGET_GAP_RATIO;

  let suggestion = targetGap - naturalGap;
  const min = metrics.unitsPerEm * MIN_KERN_RATIO;
  const max = metrics.unitsPerEm * MAX_KERN_RATIO;
  suggestion = Math.max(min, Math.min(max, suggestion));
  return Math.round(suggestion / 5) * 5;
}


export interface GlobalAutoKernResult {
  pairs: Record<string, number>;
  manual: Record<string, boolean>;
  processed: number;
  updated: number;
  preservedManual: number;
}

/**
 * Process every ordered pair in the currently available glyph set.
 * Manual overrides are treated as user-owned and survive subsequent passes.
 * Zero-valued automatic pairs are omitted to keep persisted state compact.
 * When `fallbackPairs` is supplied for a layered style, an explicit zero is
 * retained only when it is needed to override a non-zero inherited value.
 * Existing callers omit this argument and keep the exact original behavior.
 */
export function autoKernAllAvailablePairs(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  currentPairs: Record<string, number>,
  manualFlags: Record<string, boolean>,
  fallbackPairs?: Record<string, number>
): GlobalAutoKernResult {
  const chars = Object.keys(glyphs);
  const pairs = { ...currentPairs };
  const manual = { ...manualFlags };
  let processed = 0;
  let updated = 0;
  let preservedManual = 0;

  for (const left of chars) {
    for (const right of chars) {
      processed++;
      const key = kerningKey(left, right);
      if (manual[key]) {
        preservedManual++;
        continue;
      }
      const suggestion = suggestKerningPair(glyphs, metrics, left, right);
      if (suggestion === 0) {
        const needsExplicitZero = (fallbackPairs?.[key] ?? 0) !== 0;
        if (needsExplicitZero) {
          if (pairs[key] !== 0) updated++;
          pairs[key] = 0;
          manual[key] = false;
        } else {
          if (key in pairs) {
            delete pairs[key];
            updated++;
          }
          delete manual[key];
        }
      } else {
        if (pairs[key] !== suggestion) updated++;
        pairs[key] = suggestion;
        manual[key] = false;
      }
    }
  }

  return { pairs, manual, processed, updated, preservedManual };
}
