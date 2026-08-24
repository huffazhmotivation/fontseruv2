import type { Point } from "@/types/geometry";

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function subtract(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(a: Point, s: number): Point {
  return { x: a.x * s, y: a.y * s };
}

export function length(a: Point): number {
  return Math.hypot(a.x, a.y);
}

/** Mirror `p` through `center` — used to keep symmetric handles opposite. */
export function reflect(p: Point, center: Point): Point {
  return { x: center.x * 2 - p.x, y: center.y * 2 - p.y };
}

/**
 * Reflects `p` through `center`, but keeps the *original length* of the
 * opposite handle rather than mirroring `p`'s length. Used for "smooth"
 * nodes, where handles stay collinear but may have independent lengths.
 */
export function reflectDirection(p: Point, center: Point, keepLength: number): Point {
  const dir = subtract(center, p);
  const len = length(dir);
  if (len === 0) return center;
  const unit = scale(dir, 1 / len);
  return add(center, scale(unit, keepLength));
}

/** Snap an angle to the nearest multiple of `stepDeg` degrees, relative to `origin`. */
export function snapAngle(origin: Point, p: Point, stepDeg: number): Point {
  const d = subtract(p, origin);
  const dist = length(d);
  if (dist === 0) return p;
  const angle = Math.atan2(d.y, d.x);
  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(angle / step) * step;
  return {
    x: origin.x + Math.cos(snapped) * dist,
    y: origin.y + Math.sin(snapped) * dist,
  };
}

export function snapToGrid(p: Point, gridSize: number): Point {
  return {
    x: Math.round(p.x / gridSize) * gridSize,
    y: Math.round(p.y / gridSize) * gridSize,
  };
}
