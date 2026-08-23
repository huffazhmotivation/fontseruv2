import type { Contour, GlyphOutline, Point, VectorObject } from "@/types/geometry";
import { cubicPoint, closestPointOnCubic, closestPointOnLine } from "./bezier";
import { shortId } from "@/utils/id";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function boundsValid(b: Bounds): boolean {
  return b.minX <= b.maxX && b.minY <= b.maxY;
}

export function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Flattens a contour into a polyline by sampling any Bézier segments. */
export function flattenContour(contour: Contour, steps = 16): Point[] {
  const pts: Point[] = [];
  const n = contour.nodes.length;
  if (n === 0) return pts;
  const segCount = contour.closed ? n : n - 1;
  pts.push({ ...contour.nodes[0].point });
  for (let i = 0; i < segCount; i++) {
    const from = contour.nodes[i];
    const to = contour.nodes[(i + 1) % n];
    if (from.handleOut || to.handleIn) {
      const c1 = from.handleOut ?? from.point;
      const c2 = to.handleIn ?? to.point;
      for (let s = 1; s <= steps; s++) pts.push(cubicPoint(from.point, c1, c2, to.point, s / steps));
    } else {
      pts.push({ ...to.point });
    }
  }
  return pts;
}

export function objectBounds(obj: VectorObject): Bounds {
  let b = emptyBounds();
  for (const c of obj.contours) {
    for (const p of flattenContour(c)) {
      b = { minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) };
    }
  }
  // pad strokes by half their width so the selection box wraps the ink
  if ((obj.kind === "line" || obj.kind === "brush") && obj.strokeWidth) {
    const h = obj.strokeWidth / 2;
    b = { minX: b.minX - h, minY: b.minY - h, maxX: b.maxX + h, maxY: b.maxY + h };
  }
  return b;
}

export function objectsBounds(outline: GlyphOutline, ids: string[]): Bounds | null {
  let b = emptyBounds();
  for (const obj of outline.objects) {
    if (!ids.includes(obj.id)) continue;
    b = mergeBounds(b, objectBounds(obj));
  }
  return boundsValid(b) ? b : null;
}

export function outlineBounds(outline: GlyphOutline): Bounds | null {
  let b = emptyBounds();
  for (const obj of outline.objects) b = mergeBounds(b, objectBounds(obj));
  return boundsValid(b) ? b : null;
}

function mapObjectPoints(obj: VectorObject, fn: (p: Point) => Point): VectorObject {
  return {
    ...obj,
    contours: obj.contours.map((c) => ({
      ...c,
      nodes: c.nodes.map((node) => ({
        ...node,
        point: fn(node.point),
        handleIn: node.handleIn ? fn(node.handleIn) : null,
        handleOut: node.handleOut ? fn(node.handleOut) : null,
      })),
    })),
    samples: obj.samples ? obj.samples.map((s) => ({ ...fn(s), pressure: s.pressure })) : undefined,
  };
}

export function translateObject(obj: VectorObject, dx: number, dy: number): VectorObject {
  return mapObjectPoints(obj, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function scaleObject(obj: VectorObject, anchor: Point, sx: number, sy: number, preserveStrokeWidth = false): VectorObject {
  const next = mapObjectPoints(obj, (p) => ({ x: anchor.x + (p.x - anchor.x) * sx, y: anchor.y + (p.y - anchor.y) * sy }));
  if (next.strokeWidth && !preserveStrokeWidth) next.strokeWidth = next.strokeWidth * (Math.abs(sx) + Math.abs(sy)) / 2;
  return next;
}

export function rotateObject(obj: VectorObject, center: Point, angleRad: number): VectorObject {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return mapObjectPoints(obj, (p) => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
  });
}

/**
 * Shears an object around an anchor in font-unit space.
 * `shearX` moves X as Y changes; `shearY` moves Y as X changes.
 * Handles and brush samples are transformed together with the outline.
 */
export function skewObject(obj: VectorObject, anchor: Point, shearX: number, shearY: number): VectorObject {
  return mapObjectPoints(obj, (p) => {
    const dx = p.x - anchor.x;
    const dy = p.y - anchor.y;
    return {
      x: p.x + shearX * dy,
      y: p.y + shearY * dx,
    };
  });
}

/** Deep-clones an object, assigning fresh ids to it, its contours and nodes. */
export function cloneObjectWithNewIds(obj: VectorObject): VectorObject {
  return {
    ...obj,
    id: shortId("obj"),
    contours: obj.contours.map((c) => ({
      id: shortId("contour"),
      closed: c.closed,
      nodes: c.nodes.map((n) => ({
        id: shortId("node"),
        point: { ...n.point },
        handleIn: n.handleIn ? { ...n.handleIn } : null,
        handleOut: n.handleOut ? { ...n.handleOut } : null,
        type: n.type,
      })),
    })),
    samples: obj.samples ? obj.samples.map((s) => ({ ...s })) : undefined,
  };
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function distToContour(p: Point, contour: Contour): number {
  let best = Infinity;
  const n = contour.nodes.length;
  const segCount = contour.closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const from = contour.nodes[i];
    const to = contour.nodes[(i + 1) % n];
    const r =
      from.handleOut || to.handleIn
        ? closestPointOnCubic(from.point, from.handleOut ?? from.point, to.handleIn ?? to.point, to.point, p)
        : closestPointOnLine(from.point, to.point, p);
    if (r.distance < best) best = r.distance;
  }
  return best;
}

/** Whether `p` selects `obj`: inside a filled shape, or near a stroke centerline. */
export function pointHitsObject(obj: VectorObject, p: Point, tolerance: number): boolean {
  if (obj.kind === "shape" || obj.kind === "expanded") {
    // odd count of filled contours = inside; keeps counters (holes) excluded
    let winding = 0;
    for (const c of obj.contours) if (pointInPolygon(p, flattenContour(c))) winding++;
    if (winding % 2 === 1) return true;
    // also allow grabbing by the outline edge
    for (const c of obj.contours) if (distToContour(p, c) <= tolerance) return true;
    return false;
  }
  const half = (obj.strokeWidth ?? 0) / 2 + tolerance;
  for (const c of obj.contours) if (distToContour(p, c) <= half) return true;
  return false;
}

export function boundsIntersectRect(b: Bounds, rx: number, ry: number, rw: number, rh: number): boolean {
  return b.minX <= rx + rw && b.maxX >= rx && b.minY <= ry + rh && b.maxY >= ry;
}
