import type { Point } from "@/types/geometry";
import { add, scale, subtract, length } from "@/utils/geometry";

function lerp(a: Point, b: Point, t: number): Point {
  return add(a, scale(subtract(b, a), t));
}

/** Evaluates a cubic Bézier (p0..p3) at parameter t in [0,1]. */
export function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  return lerp(d, e, t);
}

/** Tangent direction (not normalized to unit length beyond the derivative scale) at t. */
export function cubicTangent(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x:
      3 * mt * mt * (p1.x - p0.x) +
      6 * mt * t * (p2.x - p1.x) +
      3 * t * t * (p3.x - p2.x),
    y:
      3 * mt * mt * (p1.y - p0.y) +
      6 * mt * t * (p2.y - p1.y) +
      3 * t * t * (p3.y - p2.y),
  };
}

export interface CubicSplit {
  left: [Point, Point, Point, Point];
  right: [Point, Point, Point, Point];
}

/** De Casteljau subdivision — splits one cubic into two cubics at t, exactly preserving shape. */
export function splitCubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): CubicSplit {
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return {
    left: [p0, p01, p012, p0123],
    right: [p0123, p123, p23, p3],
  };
}

/**
 * Approximates the closest point on a cubic Bézier to `target` by sampling,
 * then refining around the best sample. Good enough for interactive
 * "click near this segment" hit-testing; not a general-purpose root-finder.
 */
export function closestPointOnCubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  target: Point,
  samples = 24
): { t: number; point: Point; distance: number } {
  let bestT = 0;
  let bestPoint = p0;
  let bestDist = length(subtract(p0, target));

  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const pt = cubicPoint(p0, p1, p2, p3, t);
    const d = length(subtract(pt, target));
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
      bestPoint = pt;
    }
  }

  // One pass of local refinement around the best coarse sample.
  const step = 1 / samples;
  let lo = Math.max(0, bestT - step);
  let hi = Math.min(1, bestT + step);
  for (let iter = 0; iter < 6; iter++) {
    const midA = lo + (hi - lo) / 3;
    const midB = hi - (hi - lo) / 3;
    const da = length(subtract(cubicPoint(p0, p1, p2, p3, midA), target));
    const db = length(subtract(cubicPoint(p0, p1, p2, p3, midB), target));
    if (da < db) hi = midB;
    else lo = midA;
  }
  const refinedT = (lo + hi) / 2;
  const refinedPoint = cubicPoint(p0, p1, p2, p3, refinedT);
  const refinedDist = length(subtract(refinedPoint, target));
  if (refinedDist < bestDist) {
    return { t: refinedT, point: refinedPoint, distance: refinedDist };
  }
  return { t: bestT, point: bestPoint, distance: bestDist };
}

/** Closest point on a straight segment a-b (for line segments, where t is trivial). */
export function closestPointOnLine(a: Point, b: Point, target: Point): { t: number; point: Point; distance: number } {
  const ab = subtract(b, a);
  const abLenSq = ab.x * ab.x + ab.y * ab.y;
  if (abLenSq === 0) return { t: 0, point: a, distance: length(subtract(a, target)) };
  const t = Math.max(0, Math.min(1, ((target.x - a.x) * ab.x + (target.y - a.y) * ab.y) / abLenSq));
  const point = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { t, point, distance: length(subtract(point, target)) };
}
