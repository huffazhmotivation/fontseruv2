import type { Point, PathNode, Contour, VectorObject } from "@/types/geometry";
import { isFilledObject } from "@/types/geometry";
import { flattenContour } from "./objectOps";
import { simplifyPolyline } from "@/utils/simplify";
import { shortId } from "@/utils/id";

export type BooleanOp = "union" | "subtract" | "intersect";

/** Only closed filled shapes can take part in a boolean operation. */
export function isBooleanEligible(obj: VectorObject): boolean {
  return isFilledObject(obj) && obj.contours.length > 0;
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

/** Even-odd membership across one object's own contours (respects existing counters/holes). */
function insideObject(polys: Point[][], p: Point): boolean {
  let winding = 0;
  for (const poly of polys) if (pointInPolygon(p, poly)) winding++;
  return winding % 2 === 1;
}

function objectPolys(obj: VectorObject): Point[][] {
  return obj.contours.map((c) => flattenContour(c, 20)).filter((poly) => poly.length >= 3);
}

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

function unionBounds(objs: VectorObject[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objs) {
    for (const c of o.contours) {
      for (const p of flattenContour(c, 20)) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

// Marching-squares case table (bits NW=8, NE=4, SE=2, SW=1) -> pairs of edges
// crossed by the boundary. Edge direction doesn't matter here since final
// contour orientation is fixed afterwards from nesting depth, not tracing
// order — that lets us skip the usual directional bookkeeping.
const CASE_EDGES: Record<number, [string, string][]> = {
  1: [["W", "S"]],
  2: [["S", "E"]],
  3: [["W", "E"]],
  4: [["N", "E"]],
  6: [["N", "S"]],
  7: [["N", "W"]],
  8: [["N", "W"]],
  9: [["N", "S"]],
  11: [["N", "E"]],
  12: [["W", "E"]],
  13: [["S", "E"]],
  14: [["S", "W"]],
};

function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return a / 2;
}

/**
 * Applies a boolean op to 2+ eligible objects (in z-order, back-to-front).
 * Rather than exact polygon clipping (which would need a new dependency),
 * this samples the combined inside/outside field on a grid, finds the
 * boundary with marching squares (refining each crossing with a bisection
 * against the real membership test for accuracy), and rebuilds simplified,
 * correctly-nested closed contours from the traced loops. Returns null when
 * fewer than 2 eligible objects are given or the result is empty.
 */
export function applyBooleanOp(objectsInZOrder: VectorObject[], op: BooleanOp): VectorObject | null {
  const eligible = objectsInZOrder.filter(isBooleanEligible);
  if (eligible.length < 2) return null;

  const polysPerObject = eligible.map(objectPolys);
  const bounds = unionBounds(eligible);
  if (!isFinite(bounds.minX)) return null;

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const maxDim = Math.max(width, height);
  if (maxDim <= 0) return null;

  const membership = (p: Point): boolean => {
    if (op === "union") {
      for (const polys of polysPerObject) if (insideObject(polys, p)) return true;
      return false;
    }
    if (op === "intersect") {
      for (const polys of polysPerObject) if (!insideObject(polys, p)) return false;
      return true;
    }
    // subtract: front-most (last in z-order) object cut away from the rest
    const front = polysPerObject[polysPerObject.length - 1];
    if (insideObject(front, p)) return false;
    for (let i = 0; i < polysPerObject.length - 1; i++) if (insideObject(polysPerObject[i], p)) return true;
    return false;
  };

  const TARGET_CELLS = 160;
  const step = Math.min(8, Math.max(1.25, maxDim / TARGET_CELLS));
  const pad = step * 2;
  const minX = bounds.minX - pad, minY = bounds.minY - pad;
  const maxX = bounds.maxX + pad, maxY = bounds.maxY + pad;
  const nx = Math.max(2, Math.ceil((maxX - minX) / step));
  const ny = Math.max(2, Math.ceil((maxY - minY) / step));
  const cols = nx + 1;
  const rows = ny + 1;

  const grid = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      grid[j * cols + i] = membership({ x: minX + i * step, y: minY + j * step }) ? 1 : 0;
    }
  }

  function bisect(a: Point, b: Point, aInside: boolean): Point {
    let lo = a, hi = b;
    for (let k = 0; k < 8; k++) {
      const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
      if (membership(mid) === aInside) lo = mid; else hi = mid;
    }
    return { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 };
  }

  const pointCache = new Map<string, Point>();
  function edgePoint(key: string, a: Point, b: Point, aInside: boolean): Point {
    let p = pointCache.get(key);
    if (!p) { p = bisect(a, b, aInside); pointCache.set(key, p); }
    return p;
  }

  type SegPair = [string, string];
  const segs: SegPair[] = [];

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = minX + i * step, x1 = x0 + step;
      const y0 = minY + j * step, y1 = y0 + step;
      const tl = grid[j * cols + i];
      const tr = grid[j * cols + i + 1];
      const br = grid[(j + 1) * cols + i + 1];
      const bl = grid[(j + 1) * cols + i];
      const caseIdx = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (caseIdx === 0 || caseIdx === 15) continue;

      const keyN = `h:${i}:${j}`, keyS = `h:${i}:${j + 1}`, keyW = `v:${i}:${j}`, keyE = `v:${i + 1}:${j}`;
      const edgeAt = (edge: string): string => {
        switch (edge) {
          case "N": edgePoint(keyN, { x: x0, y: y0 }, { x: x1, y: y0 }, !!tl); return keyN;
          case "S": edgePoint(keyS, { x: x0, y: y1 }, { x: x1, y: y1 }, !!bl); return keyS;
          case "W": edgePoint(keyW, { x: x0, y: y0 }, { x: x0, y: y1 }, !!tl); return keyW;
          default: edgePoint(keyE, { x: x1, y: y0 }, { x: x1, y: y1 }, !!tr); return keyE;
        }
      };

      if (caseIdx === 5 || caseIdx === 10) {
        // Saddle case — disambiguate with an extra sample at the cell center.
        const centerIn = membership({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
        if (caseIdx === 5) {
          if (centerIn) segs.push([edgeAt("N"), edgeAt("W")], [edgeAt("S"), edgeAt("E")]);
          else segs.push([edgeAt("N"), edgeAt("E")], [edgeAt("S"), edgeAt("W")]);
        } else {
          if (centerIn) segs.push([edgeAt("N"), edgeAt("E")], [edgeAt("S"), edgeAt("W")]);
          else segs.push([edgeAt("N"), edgeAt("W")], [edgeAt("S"), edgeAt("E")]);
        }
        continue;
      }

      const pairs = CASE_EDGES[caseIdx];
      if (!pairs) continue;
      for (const [ea, eb] of pairs) segs.push([edgeAt(ea), edgeAt(eb)]);
    }
  }

  if (segs.length === 0) return null;

  const adj = new Map<string, string[]>();
  const addAdj = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  };
  for (const [a, b] of segs) addAdj(a, b);

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const usedPairs = new Set<string>();
  const loops: string[][] = [];

  for (const [a0, b0] of segs) {
    const startKey = pairKey(a0, b0);
    if (usedPairs.has(startKey)) continue;
    usedPairs.add(startKey);
    const loop = [a0, b0];
    let cur = b0;
    let guard = 0;
    while (cur !== a0 && guard < 20000) {
      guard++;
      const neighbors = adj.get(cur) ?? [];
      let next: string | null = null;
      for (const n of neighbors) {
        const k = pairKey(cur, n);
        if (!usedPairs.has(k)) { next = n; usedPairs.add(k); break; }
      }
      if (next == null) break;
      loop.push(next);
      cur = next;
    }
    if (cur === a0 && loop.length >= 4) loops.push(loop.slice(0, -1));
  }

  if (loops.length === 0) return null;

  const minLoopArea = Math.max(4, step * step * 1.5);
  const rings = loops
    .map((keys) => keys.map((k) => pointCache.get(k)!).filter(Boolean))
    .filter((pts) => pts.length >= 3 && Math.abs(polygonArea(pts)) > minLoopArea);

  if (rings.length === 0) return null;

  // Nesting depth via containment against the other rings' first point.
  const depths = rings.map((ring, idx) => {
    let depth = 0;
    for (let k = 0; k < rings.length; k++) {
      if (k === idx) continue;
      if (pointInPolygon(ring[0], rings[k])) depth++;
    }
    return depth;
  });

  const contours: Contour[] = rings.map((ring, idx) => {
    const wantPositive = depths[idx] % 2 === 0;
    const area = polygonArea(ring);
    const oriented = (area > 0) === wantPositive ? ring : [...ring].reverse();
    const simplified = simplifyPolyline(oriented, Math.max(0.75, step * 0.6));
    const nodes: PathNode[] = simplified.map((p) => ({ id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" }));
    return { id: shortId("contour"), nodes, closed: true };
  });

  return { id: shortId("obj"), kind: "shape", contours };
}
