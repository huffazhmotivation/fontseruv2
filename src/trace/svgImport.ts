import type { Contour, Point, VectorObject } from "@/types/geometry";
import { shortId } from "@/utils/id";
import { fitTracedObjectsToGlyph, objectsBoundsPx, type TraceLetterGroup } from "@/trace/imageTrace";
import { useAppStore } from "@/glyph/store";

/**
 * Import SVG errors — kept separate from `TraceError` (imageTrace.ts) since
 * this path never touches the raster tracer, but follows the same
 * "throw a friendly Indonesian message" convention the rest of the Trace
 * Image overlay already relies on.
 */
export class SvgImportError extends Error {}

export interface SvgImportResult {
  /** One group per top-level SVG shape/path, each holding exactly one
   *  VectorObject — matches TraceLetterGroup's shape so the existing
   *  results canvas, drag-to-target, and apply-to-glyph code paths work
   *  completely unchanged. */
  letters: TraceLetterGroup[];
  /** Coordinate-space size the letters' bounds are expressed in — plugs
   *  straight into the same `traceCanvasSize` state the raster tracer
   *  fills, which is all the artboard rendering needs. */
  canvas: { width: number; height: number };
}

// ---------------------------------------------------------------------------
// 2D affine matrix helpers (for <g>/element `transform` attributes).
// ---------------------------------------------------------------------------

interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }

function identityMatrix(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** Combined matrix such that `multiply(A, B) * p === A * (B * p)` — i.e. B is applied first. */
function multiplyMatrix(A: Matrix, B: Matrix): Matrix {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

function applyMatrix(m: Matrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** Parses a `transform="translate(..) scale(..) rotate(..) matrix(..) skewX(..) skewY(..)"` attribute into one combined matrix. */
function parseTransformAttr(value: string | null): Matrix {
  if (!value) return identityMatrix();
  let m = identityMatrix();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    const fn = match[1];
    const args = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let fm = identityMatrix();
    switch (fn) {
      case "matrix":
        if (args.length === 6) fm = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
        break;
      case "translate":
        fm = { a: 1, b: 0, c: 0, d: 1, e: args[0] ?? 0, f: args[1] ?? 0 };
        break;
      case "scale": {
        const sx = args[0] ?? 1;
        const sy = args.length > 1 ? args[1] : sx;
        fm = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
        break;
      }
      case "rotate": {
        const deg = args[0] ?? 0;
        const rad = (deg * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rot: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        if (args.length >= 3) {
          const cx = args[1];
          const cy = args[2];
          fm = multiplyMatrix(multiplyMatrix({ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy }, rot), { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy });
        } else {
          fm = rot;
        }
        break;
      }
      case "skewX": {
        const rad = ((args[0] ?? 0) * Math.PI) / 180;
        fm = { a: 1, b: 0, c: Math.tan(rad), d: 1, e: 0, f: 0 };
        break;
      }
      case "skewY": {
        const rad = ((args[0] ?? 0) * Math.PI) / 180;
        fm = { a: 1, b: Math.tan(rad), c: 0, d: 1, e: 0, f: 0 };
        break;
      }
    }
    m = multiplyMatrix(m, fm);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Elliptical-arc → cubic Bézier segments (endpoint-to-center parameterization,
// per the SVG spec appendix), split into <=90° pieces.
// ---------------------------------------------------------------------------

interface CubicSeg { x1: number; y1: number; x2: number; y2: number; x: number; y: number }

function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1e-12;
  let angle = Math.acos(Math.min(1, Math.max(-1, dot / len)));
  if (ux * vy - uy * vx < 0) angle = -angle;
  return angle;
}

function arcToCubicSegments(
  x1: number, y1: number,
  rxIn: number, ryIn: number,
  xAxisRotationDeg: number,
  largeArcFlag: boolean, sweepFlag: boolean,
  x2: number, y2: number
): CubicSeg[] {
  if (rxIn === 0 || ryIn === 0 || (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9)) {
    // Degenerate arc: draw it as a straight line (linear "cubic" whose
    // control points sit on the line, visually identical to L).
    return [{ x1, y1, x2, y2, x: x2, y: y2 }];
  }

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = ((((xAxisRotationDeg % 360) + 360) % 360) * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rxSq = rx * rx;
  let rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const radiiCheck = x1pSq / rxSq + y1pSq / rySq;
  if (radiiCheck > 1) {
    const s = Math.sqrt(radiiCheck);
    rx *= s;
    ry *= s;
    rxSq = rx * rx;
    rySq = ry * ry;
  }

  const sign = largeArcFlag !== sweepFlag ? 1 : -1;
  const num = Math.max(0, rxSq * rySq - rxSq * y1pSq - rySq * x1pSq);
  const denom = rxSq * y1pSq + rySq * x1pSq;
  const coef = denom === 0 ? 0 : sign * Math.sqrt(num / denom);
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = vectorAngle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweepFlag && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweepFlag && dtheta < 0) dtheta += 2 * Math.PI;

  const numSegs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / numSegs;
  const segs: CubicSeg[] = [];
  let theta = theta1;
  for (let i = 0; i < numSegs; i++) {
    const theta2 = theta + delta;
    const alpha = (Math.sin(delta) * (Math.sqrt(4 + 3 * Math.tan(delta / 2) * Math.tan(delta / 2)) - 1)) / 3;
    const cosT1 = Math.cos(theta), sinT1 = Math.sin(theta);
    const cosT2 = Math.cos(theta2), sinT2 = Math.sin(theta2);

    const p1: Point = { x: cx + rx * cosPhi * cosT1 - ry * sinPhi * sinT1, y: cy + rx * sinPhi * cosT1 + ry * cosPhi * sinT1 };
    const p2: Point = { x: cx + rx * cosPhi * cosT2 - ry * sinPhi * sinT2, y: cy + rx * sinPhi * cosT2 + ry * cosPhi * sinT2 };
    const dp1: Point = { x: -rx * cosPhi * sinT1 - ry * sinPhi * cosT1, y: -rx * sinPhi * sinT1 + ry * cosPhi * cosT1 };
    const dp2: Point = { x: -rx * cosPhi * sinT2 - ry * sinPhi * cosT2, y: -rx * sinPhi * sinT2 + ry * cosPhi * cosT2 };

    segs.push({
      x1: p1.x + alpha * dp1.x, y1: p1.y + alpha * dp1.y,
      x2: p2.x - alpha * dp2.x, y2: p2.y - alpha * dp2.y,
      x: p2.x, y: p2.y,
    });
    theta = theta2;
  }
  return segs;
}

// ---------------------------------------------------------------------------
// SVG path-data ("d") parsing into subpaths of on-curve nodes with optional
// cubic handles — the same node shape as the app's PathNode, just without
// ids yet (assigned once at final Contour build time).
// ---------------------------------------------------------------------------

interface RawNode { point: Point; handleIn: Point | null; handleOut: Point | null }

function tokenizePathData(d: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.\d+(?:[eE][-+]?\d+)?|-?\d+(?:[eE][-+]?\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(d))) {
    if (match[1]) tokens.push(match[1]);
    else tokens.push(parseFloat(match[2]));
  }
  return tokens;
}

function parsePathData(d: string): RawNode[][] {
  const tokens = tokenizePathData(d);
  const subpaths: RawNode[][] = [];
  let current: RawNode[] = [];
  let cur: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let lastCurveType: "C" | "Q" | null = null;
  let lastCtrl: Point | null = null;

  function flushSubpath() {
    if (current.length >= 2) {
      const first = current[0];
      const last = current[current.length - 1];
      if (Math.hypot(last.point.x - first.point.x, last.point.y - first.point.y) < 1e-3) {
        first.handleIn = last.handleIn ?? first.handleIn;
        current.pop();
      }
      if (current.length >= 2) subpaths.push(current);
    }
    current = [];
  }

  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i];
    if (typeof cmd !== "string") { i++; continue; } // stray/malformed number — skip defensively
    i++;
    const upper = cmd.toUpperCase();
    const relative = cmd !== upper;
    const readNum = (): number => {
      const v = tokens[i];
      i++;
      return typeof v === "number" ? v : 0;
    };
    const hasMoreArgs = () => i < tokens.length && typeof tokens[i] === "number";

    switch (upper) {
      case "M": {
        let first = true;
        do {
          const x = readNum(), y = readNum();
          const pt: Point = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
          if (first) {
            flushSubpath();
            current = [{ point: pt, handleIn: null, handleOut: null }];
            subpathStart = pt;
          } else {
            current.push({ point: pt, handleIn: null, handleOut: null });
          }
          cur = pt;
          lastCurveType = null;
          lastCtrl = null;
          first = false;
        } while (hasMoreArgs());
        break;
      }
      case "L": {
        do {
          const x = readNum(), y = readNum();
          const pt: Point = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
          current.push({ point: pt, handleIn: null, handleOut: null });
          cur = pt;
          lastCurveType = null;
          lastCtrl = null;
        } while (hasMoreArgs());
        break;
      }
      case "H": {
        do {
          const x = readNum();
          const pt: Point = relative ? { x: cur.x + x, y: cur.y } : { x, y: cur.y };
          current.push({ point: pt, handleIn: null, handleOut: null });
          cur = pt;
          lastCurveType = null;
          lastCtrl = null;
        } while (hasMoreArgs());
        break;
      }
      case "V": {
        do {
          const y = readNum();
          const pt: Point = relative ? { x: cur.x, y: cur.y + y } : { x: cur.x, y };
          current.push({ point: pt, handleIn: null, handleOut: null });
          cur = pt;
          lastCurveType = null;
          lastCtrl = null;
        } while (hasMoreArgs());
        break;
      }
      case "C": {
        do {
          const x1 = readNum(), y1 = readNum(), x2 = readNum(), y2 = readNum(), x = readNum(), y = readNum();
          const c1: Point = relative ? { x: cur.x + x1, y: cur.y + y1 } : { x: x1, y: y1 };
          const c2: Point = relative ? { x: cur.x + x2, y: cur.y + y2 } : { x: x2, y: y2 };
          const end: Point = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
          if (current.length) current[current.length - 1].handleOut = c1;
          current.push({ point: end, handleIn: c2, handleOut: null });
          cur = end;
          lastCurveType = "C";
          lastCtrl = c2;
        } while (hasMoreArgs());
        break;
      }
      case "S": {
        do {
          const x2 = readNum(), y2 = readNum(), x = readNum(), y = readNum();
          const c1: Point = lastCurveType === "C" && lastCtrl ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : { ...cur };
          const c2: Point = relative ? { x: cur.x + x2, y: cur.y + y2 } : { x: x2, y: y2 };
          const end: Point = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
          if (current.length) current[current.length - 1].handleOut = c1;
          current.push({ point: end, handleIn: c2, handleOut: null });
          cur = end;
          lastCurveType = "C";
          lastCtrl = c2;
        } while (hasMoreArgs());
        break;
      }
      case "Q": {
        do {
          const qx = readNum(), qy = readNum(), x = readNum(), y = readNum();
          const q: Point = relative ? { x: cur.x + qx, y: cur.y + qy } : { x: qx, y: qy };
          const end: Point = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
          const c1: Point = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
          const c2: Point = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
          if (current.length) current[current.length - 1].handleOut = c1;
          current.push({ point: end, handleIn: c2, handleOut: null });
          cur = end;
          lastCurveType = "Q";
          lastCtrl = q;
        } while (hasMoreArgs());
        break;
      }
      case "T": {
        do {
          const x = readNum(), y = readNum();
          const end: Point = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
          const q: Point = lastCurveType === "Q" && lastCtrl ? { x: 2 * cur.x - lastCtrl.x, y: 2 * cur.y - lastCtrl.y } : { ...cur };
          const c1: Point = { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) };
          const c2: Point = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
          if (current.length) current[current.length - 1].handleOut = c1;
          current.push({ point: end, handleIn: c2, handleOut: null });
          cur = end;
          lastCurveType = "Q";
          lastCtrl = q;
        } while (hasMoreArgs());
        break;
      }
      case "A": {
        do {
          const rx = readNum(), ry = readNum(), xrot = readNum(), laf = readNum(), sf = readNum(), x = readNum(), y = readNum();
          const end: Point = relative ? { x: cur.x + x, y: cur.y + y } : { x, y };
          const segs = arcToCubicSegments(cur.x, cur.y, rx, ry, xrot, laf !== 0, sf !== 0, end.x, end.y);
          for (const seg of segs) {
            if (current.length) current[current.length - 1].handleOut = { x: seg.x1, y: seg.y1 };
            current.push({ point: { x: seg.x, y: seg.y }, handleIn: { x: seg.x2, y: seg.y2 }, handleOut: null });
          }
          cur = end;
          lastCurveType = null;
          lastCtrl = null;
        } while (hasMoreArgs());
        break;
      }
      case "Z": {
        flushSubpath();
        current = [{ point: subpathStart, handleIn: null, handleOut: null }];
        cur = subpathStart;
        lastCurveType = null;
        lastCtrl = null;
        break;
      }
      default:
        break;
    }
  }
  flushSubpath();
  return subpaths;
}

// ---------------------------------------------------------------------------
// Basic shape elements (<rect>, <circle>, <ellipse>, <polygon>, <polyline>)
// are each reduced to an equivalent path `d` string so they flow through the
// exact same parser above instead of duplicating node/handle bookkeeping.
// ---------------------------------------------------------------------------

function shapeElementToPathD(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const num = (name: string, def = 0): number => {
    const v = el.getAttribute(name);
    if (v == null) return def;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
  };

  switch (tag) {
    case "path":
      return el.getAttribute("d");
    case "rect": {
      const x = num("x"), y = num("y"), w = num("width"), h = num("height");
      if (w <= 0 || h <= 0) return null;
      const hasRx = el.hasAttribute("rx");
      const hasRy = el.hasAttribute("ry");
      let rx = hasRx ? num("rx") : hasRy ? num("ry") : 0;
      let ry = hasRy ? num("ry") : hasRx ? num("rx") : 0;
      rx = Math.min(Math.max(0, rx), w / 2);
      ry = Math.min(Math.max(0, ry), h / 2);
      if (rx > 0 && ry > 0) {
        return `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
      }
      return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
    }
    case "circle": {
      const cx = num("cx"), cy = num("cy"), r = num("r");
      if (r <= 0) return null;
      return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
    }
    case "ellipse": {
      const cx = num("cx"), cy = num("cy"), rx = num("rx"), ry = num("ry");
      if (rx <= 0 || ry <= 0) return null;
      return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
    }
    case "polygon":
    case "polyline": {
      const raw = (el.getAttribute("points") || "").trim();
      if (!raw) return null;
      const nums = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
      if (nums.length < 4) return null;
      let d = `M ${nums[0]} ${nums[1]}`;
      for (let i = 2; i + 1 < nums.length; i += 2) d += ` L ${nums[i]} ${nums[i + 1]}`;
      d += " Z";
      return d;
    }
    case "line": {
      // A bare <line> has zero fill area on its own (it's stroke-only), so
      // taking it literally would silently vanish under this app's
      // nonzero-fill model. Expand it into a thin filled quad along its
      // stroke-width instead, so it survives import as a real, visible,
      // editable shape rather than being dropped.
      const x1 = num("x1"), y1 = num("y1"), x2 = num("x2"), y2 = num("y2");
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return null;
      const swAttr = parseFloat(el.getAttribute("stroke-width") || "");
      const sw = Number.isFinite(swAttr) && swAttr > 0 ? swAttr : 1;
      const hx = (-dy / len) * (sw / 2);
      const hy = (dx / len) * (sw / 2);
      return `M ${x1 + hx} ${y1 + hy} L ${x2 + hx} ${y2 + hy} L ${x2 - hx} ${y2 - hy} L ${x1 - hx} ${y1 - hy} Z`;
    }
    default:
      return null;
  }
}

const DRAWABLE_TAGS = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline", "line"]);
// Non-rendering containers (defs/symbols/patterns and their contents never
// render directly) plus purely-descriptive leaf tags — never treated as
// shapes and never recursed into for shapes either.
const SKIP_SUBTREE_TAGS = new Set(["defs", "symbol", "clippath", "mask", "pattern", "title", "desc", "metadata", "style", "filter"]);

function isHiddenElement(el: Element): boolean {
  if (el.getAttribute("display") === "none") return true;
  const style = el.getAttribute("style");
  if (style && /display\s*:\s*none/i.test(style)) return true;
  return false;
}

interface WalkedShape { subpaths: RawNode[][] }

function transformRawNode(n: RawNode, m: Matrix): RawNode {
  return {
    point: applyMatrix(m, n.point),
    handleIn: n.handleIn ? applyMatrix(m, n.handleIn) : null,
    handleOut: n.handleOut ? applyMatrix(m, n.handleOut) : null,
  };
}

/**
 * Length attribute parser shared by the root `<svg>` and any nested
 * `<svg>` viewport resolution below. Deliberately rejects percentage
 * values (e.g. `width="100%"`, extremely common on hand-authored and
 * design-tool-exported root SVGs) instead of doing `parseFloat("100%") →
 * 100`: treating "100%" as a literal 100 user-unit length silently
 * replaces the real viewBox size with an unrelated number, non-uniformly
 * squashing/stretching every shape (e.g. a 235×210 viewBox forced into a
 * bogus 100×100 canvas). Returning null here instead lets the caller fall
 * back to the viewBox's own size, which is what a percentage actually
 * means ("fill whatever container/viewport you're placed in").
 */
function parseLen(v: string | null): number | null {
  if (!v) return null;
  if (/%\s*$/.test(v.trim())) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface ViewportResolution { matrix: Matrix; size: { width: number; height: number } | null }

/**
 * Resolves an `<svg>` element's own viewport — its `viewBox` plus (for a
 * nested `<svg>`) its `x`/`y`/`width`/`height` placement — into a matrix
 * mapping that element's local coordinate space into its parent's space.
 * Shared by the root `<svg>` and by any nested `<svg>` found while
 * walking the tree (icon sprites and multi-artboard exports commonly
 * embed one), since both establish a viewport the exact same way.
 */
function resolveViewportMatrix(el: Element, isNested: boolean): ViewportResolution {
  const viewBoxAttr = el.getAttribute("viewBox");
  const attrWidth = parseLen(el.getAttribute("width"));
  const attrHeight = parseLen(el.getAttribute("height"));
  const offsetX = isNested ? parseLen(el.getAttribute("x")) ?? 0 : 0;
  const offsetY = isNested ? parseLen(el.getAttribute("y")) ?? 0 : 0;
  const placeM: Matrix = { a: 1, b: 0, c: 0, d: 1, e: offsetX, f: offsetY };

  let vb: { minX: number; minY: number; width: number; height: number } | null = null;
  if (viewBoxAttr) {
    const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      vb = { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
    }
  }

  if (vb) {
    const width = attrWidth ?? vb.width;
    const height = attrHeight ?? vb.height;
    const scaleM: Matrix = { a: width / vb.width, b: 0, c: 0, d: height / vb.height, e: 0, f: 0 };
    const translateM: Matrix = { a: 1, b: 0, c: 0, d: 1, e: -vb.minX, f: -vb.minY };
    return { matrix: multiplyMatrix(placeM, multiplyMatrix(scaleM, translateM)), size: { width, height } };
  }
  if (attrWidth && attrHeight) {
    return { matrix: placeM, size: { width: attrWidth, height: attrHeight } };
  }
  // No viewBox/width/height at all — no local rescaling; nested content
  // just inherits the parent's units 1:1 (still offset by x/y, if any).
  return { matrix: placeM, size: null };
}

function walkSvgTree(el: Element, parentMatrix: Matrix, out: WalkedShape[]): void {
  const tag = el.tagName.toLowerCase();
  if (SKIP_SUBTREE_TAGS.has(tag) || isHiddenElement(el)) return;

  const localMatrix = multiplyMatrix(parentMatrix, parseTransformAttr(el.getAttribute("transform")));

  if (tag === "svg") {
    // A nested <svg> starts its own viewport (x/y/width/height/viewBox)
    // inside the parent's coordinate space. Without resolving that here,
    // its children would inherit the outer coordinate system directly —
    // landing at completely wrong positions/scale, since a nested
    // viewport's whole point is to remap its contents. Common in icon
    // sprites and multi-artboard exports.
    const { matrix: viewportMatrix } = resolveViewportMatrix(el, true);
    const combined = multiplyMatrix(localMatrix, viewportMatrix);
    for (const child of Array.from(el.children)) walkSvgTree(child, combined, out);
    return;
  }

  if (DRAWABLE_TAGS.has(tag)) {
    const d = shapeElementToPathD(el);
    if (d) {
      const subpaths = parsePathData(d);
      if (subpaths.length) {
        out.push({ subpaths: subpaths.map((sp) => sp.map((n) => transformRawNode(n, localMatrix))) });
      }
    }
  }

  for (const child of Array.from(el.children)) walkSvgTree(child, localMatrix, out);
}

/**
 * Parses an uploaded .svg file straight into vector objects — no tracing,
 * no threshold/detail/invert. Every top-level shape/path becomes its own
 * TraceLetterGroup (one VectorObject each) so it stays independently
 * selectable in the results canvas, exactly like a traced letter; a single
 * <path> with multiple subpaths keeps them as one object's multiple
 * contours, preserving intentional compound shapes (e.g. a letter "O"'s
 * counter) as real holes under the app's nonzero fill rule.
 */
export async function importSvgFile(file: File): Promise<SvgImportResult> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new SvgImportError("Gagal membaca file SVG.");
  }
  return parseSvgMarkup(text);
}

/**
 * Same parser `importSvgFile` uses, factored out so pasted clipboard markup
 * (no File object involved) goes through the exact same, already-hardened
 * path — viewBox/transform resolution, nested-viewport handling, compound
 * shapes, auto-fit — instead of a second parallel implementation.
 */
export function parseSvgMarkup(text: string): SvgImportResult {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "image/svg+xml");
  } catch {
    throw new SvgImportError("Gagal membaca file SVG. Pastikan file berupa SVG yang valid.");
  }
  if (doc.querySelector("parsererror")) {
    throw new SvgImportError("Gagal membaca file SVG. Pastikan file berupa SVG yang valid.");
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    throw new SvgImportError("File ini bukan SVG yang valid.");
  }

  const { matrix } = resolveViewportMatrix(root, false);
  const shapes: WalkedShape[] = [];
  for (const child of Array.from(root.children)) walkSvgTree(child, matrix, shapes);

  if (shapes.length === 0) {
    throw new SvgImportError("Tidak ada bentuk vektor yang terdeteksi di SVG ini.");
  }

  const letters: TraceLetterGroup[] = [];
  for (const shape of shapes) {
    const contours: Contour[] = shape.subpaths
      .filter((sp) => sp.length >= 2)
      .map((sp) => ({
        id: shortId("trace_c"),
        closed: true,
        nodes: sp.map((n) => ({ id: shortId("tn"), point: n.point, handleIn: n.handleIn, handleOut: n.handleOut, type: "corner" as const })),
      }));
    if (!contours.length) continue;
    const obj: VectorObject = { id: shortId("trace_obj"), kind: "shape", contours };
    const bounds = objectsBoundsPx([obj]);
    if (!bounds) continue;
    letters.push({ id: shortId("trace_letter"), objects: [obj], bounds });
  }

  if (letters.length === 0) {
    throw new SvgImportError("Tidak ada bentuk vektor yang terdeteksi di SVG ini.");
  }

  // Auto-fit/center: always re-derive the results canvas from the UNION
  // of what actually got parsed, then shift everything to start at
  // (0,0) with a small margin — regardless of what the source SVG
  // declared as its viewBox/width/height. This is what guarantees the
  // imported vector is immediately visible and centered on the "Canvas
  // Hasil Tracing" the moment import finishes, instead of silently
  // landing off-screen whenever a file's real content lives outside its
  // own declared viewBox (surprisingly common in real-world exports —
  // e.g. this very project's own favicon.svg/logo-thumbnail.svg carry
  // legacy wordmark paths hundreds of units past their declared viewBox,
  // which used to parse "successfully" while rendering nowhere near the
  // visible artboard).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of letters) {
    minX = Math.min(minX, l.bounds.minX);
    minY = Math.min(minY, l.bounds.minY);
    maxX = Math.max(maxX, l.bounds.maxX);
    maxY = Math.max(maxY, l.bounds.maxY);
  }
  const rawWidth = Math.max(1e-6, maxX - minX);
  const rawHeight = Math.max(1e-6, maxY - minY);
  // Small breathing room so shapes never touch the artboard's edge.
  const margin = Math.max(rawWidth, rawHeight) * 0.04;
  const shiftX = -minX + margin;
  const shiftY = -minY + margin;
  for (const l of letters) {
    for (const obj of l.objects) {
      for (const contour of obj.contours) {
        for (const node of contour.nodes) {
          node.point = { x: node.point.x + shiftX, y: node.point.y + shiftY };
          if (node.handleIn) node.handleIn = { x: node.handleIn.x + shiftX, y: node.handleIn.y + shiftY };
          if (node.handleOut) node.handleOut = { x: node.handleOut.x + shiftX, y: node.handleOut.y + shiftY };
        }
      }
    }
    l.bounds = { minX: l.bounds.minX + shiftX, minY: l.bounds.minY + shiftY, maxX: l.bounds.maxX + shiftX, maxY: l.bounds.maxY + shiftY };
  }
  const finalCanvasSize = { width: rawWidth + margin * 2, height: rawHeight + margin * 2 };

  return { letters, canvas: finalCanvasSize };
}

// ---------------------------------------------------------------------------
// Paste-from-clipboard (Affinity Designer / Adobe Illustrator, etc.)
// ---------------------------------------------------------------------------

/**
 * Pulls the first `<svg ...>...</svg>` document out of an arbitrary clipboard
 * text payload. Affinity Designer and Illustrator both write a vector
 * selection to the system clipboard as an SVG fragment (sometimes bare,
 * sometimes wrapped in extra HTML when the OS clipboard exposes it as
 * text/html), so this looks for the outermost `<svg>` tag rather than
 * requiring the whole string to be a clean, standalone document.
 */
function extractSvgMarkup(text: string): string | null {
  if (!text || text.indexOf("<svg") === -1) return null;
  const start = text.indexOf("<svg");
  const end = text.lastIndexOf("</svg>");
  if (end === -1 || end < start) return null;
  return text.slice(start, end + "</svg>".length);
}

/**
 * Tries to turn whatever is currently on the OS clipboard into vector art
 * dropped into the active glyph, additively (existing artwork is kept).
 * Used as the first attempt on Cmd/Ctrl+V, ahead of FontSeru's own internal
 * object clipboard (`pasteClipboard`) — so copying a shape inside FontSeru
 * still pastes normally, and copying a shape from Affinity/Illustrator into
 * FontSeru just works the same way.
 *
 * Returns true only once real vector shapes were actually inserted; any
 * other outcome (no clipboard permission, no SVG on the clipboard, an SVG
 * with no usable shapes, no active glyph) returns false so the caller falls
 * back to the normal paste path without showing an error — most pastes
 * genuinely aren't vector art, and that's not a failure.
 */
export async function pasteSvgFromSystemClipboard(): Promise<boolean> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard || typeof clipboard.readText !== "function") return false;

  let text: string;
  try {
    text = await clipboard.readText();
  } catch {
    return false; // no permission, or nothing text-readable — silently defer to normal paste
  }

  const markup = extractSvgMarkup(text);
  if (!markup) return false;

  let parsed: SvgImportResult;
  try {
    parsed = parseSvgMarkup(markup);
  } catch {
    return false; // looked like SVG but didn't parse — never block the normal paste over this
  }

  const objects = parsed.letters.flatMap((letter) => letter.objects);
  if (objects.length === 0) return false;

  const s = useAppStore.getState();
  const glyph = s.glyphs[s.activeChar];
  if (!glyph) return false;

  // Same pixel-space -> font-unit fit the raster/SVG Trace Image results use:
  // scaled to cap height and centered in the glyph's advance width, so a
  // pasted shape lands at a sensible size instead of at its source app's
  // native units.
  const fitted = fitTracedObjectsToGlyph(objects, s.metrics, glyph.advanceWidth);
  if (fitted.objects.length === 0) return false;

  s.pasteExternalObjects(fitted.objects);
  return true;
}
