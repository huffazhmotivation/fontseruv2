import ImageTracer from "imagetracerjs";
import type { Tracedata, TracePath } from "imagetracerjs";
import type { Contour, GlyphOutline, PathNode, Point, VectorObject } from "@/types/geometry";
import type { FontMetrics } from "@/types/font";
import { shortId } from "@/utils/id";

export type TraceDetail = "low" | "medium" | "high";

export interface TraceSettings {
  /** Luminance (0–255) below which a pixel is treated as ink. */
  threshold: number;
  /** Controls imagetracer's curve-fit error tolerance and minimum path size — the main lever for node count. */
  detail: TraceDetail;
  /** Flip which side of the threshold counts as ink (for light-on-dark source images). */
  invert: boolean;
}

export const DEFAULT_TRACE_SETTINGS: TraceSettings = {
  threshold: 150,
  detail: "medium",
  invert: false,
};

/**
 * Keeps tracing fast and the resulting node count sane regardless of source
 * image resolution. Scaled per detail level: thin line art needs more
 * source pixels across a stroke's width to stay a faithful thin shape
 * instead of blurring/thickening when heavily downscaled.
 */
const MAX_DIMENSION_BY_DETAIL: Record<TraceDetail, number> = {
  low: 800,
  medium: 1000,
  high: 1400,
};

// Tightened vs. the original presets: lower ltres/qtres means imagetracer
// snaps closer to the actual binarized edge instead of smoothing corners
// outward into a fatter shape, which matters most for thin outline/line-art
// strokes. pathomit stays as the "ignore paths shorter than N px" noise
// floor — kept modest since real despeckling now happens on the bitmap
// itself (see despeckleBinary) rather than by discarding whole paths.
const DETAIL_PRESETS: Record<TraceDetail, { ltres: number; qtres: number; pathomit: number }> = {
  // Fewer, smoother nodes — best for clean logo-like shapes.
  low: { ltres: 1.4, qtres: 1.4, pathomit: 12 },
  // Balanced default: tight fit, minimal-but-faithful node count.
  medium: { ltres: 0.6, qtres: 0.6, pathomit: 6 },
  // More nodes, tightest fit — for intricate sketches / thin line art.
  high: { ltres: 0.25, qtres: 0.25, pathomit: 3 },
};

/** Minimum connected-component area (in source px, post-downscale) kept as ink. Smaller specks — JPEG ringing, dust, stray pixels — are scrubbed before tracing so they never become tiny noise shapes. */
const DESPECKLE_MIN_AREA: Record<TraceDetail, number> = {
  low: 10,
  medium: 6,
  high: 3,
};

export class TraceError extends Error {}

/** Loads a File (PNG/JPG) the user picked/dropped into an <img>, ready to draw onto a canvas. */
export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new TraceError("Gagal memuat gambar. Pastikan file berupa PNG atau JPG yang valid."));
    };
    img.src = url;
  });
}

/** Draws the loaded image onto a right-sized canvas (downscaled if needed) for consistent, fast tracing. */
export function imageToCanvas(img: HTMLImageElement, detail: TraceDetail = "medium"): HTMLCanvasElement {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new TraceError("Gambar tidak valid atau kosong.");
  const scale = Math.min(1, MAX_DIMENSION_BY_DETAIL[detail] / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new TraceError("Canvas 2D tidak didukung di browser ini.");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Reduces the canvas to pure black/white ImageData based on a luminance
 * threshold (transparent pixels always count as background). Binarizing
 * ourselves — instead of letting imagetracer's own color quantization pick
 * a palette — keeps the result deterministic and gives the user a single,
 * predictable "Threshold" control.
 */
export function binarize(canvas: HTMLCanvasElement, settings: TraceSettings): ImageData {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new TraceError("Canvas 2D tidak didukung di browser ini.");
  const imgd = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgd.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    let isInk = a > 32 && luminance < settings.threshold;
    if (settings.invert) isInk = !isInk;
    if (isInk) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    } else {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  return imgd;
}

/**
 * Removes small ink specks from an already-binarized ImageData via
 * connected-component labeling (4-connectivity flood fill): any ink island
 * smaller than `minArea` pixels is painted back to background. This is the
 * "noise" half of accuracy — JPEG ringing, scan dust, and stray dark
 * pixels around thin strokes all tend to show up as tiny isolated islands,
 * and left in, each becomes its own spurious traced shape. Genuine strokes
 * (even 1–2px thin ones) survive because they run for many connected
 * pixels along their length, well above the area floor.
 */
export function despeckleBinary(imgd: ImageData, minArea: number): ImageData {
  if (minArea <= 1) return imgd;
  const { width, height, data } = imgd;
  const total = width * height;
  const isInk = new Uint8Array(total);
  for (let p = 0; p < total; p++) isInk[p] = data[p * 4] < 128 ? 1 : 0;

  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const componentBuf = new Int32Array(total);

  for (let start = 0; start < total; start++) {
    if (!isInk[start] || visited[start]) continue;
    let sp = 0;
    let count = 0;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      componentBuf[count++] = p;
      const x = p % width;
      const y = (p - x) / width;
      // 4-connected neighbors.
      if (x > 0) { const n = p - 1; if (isInk[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
      if (x < width - 1) { const n = p + 1; if (isInk[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
      if (y > 0) { const n = p - width; if (isInk[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
      if (y < height - 1) { const n = p + width; if (isInk[n] && !visited[n]) { visited[n] = 1; stack[sp++] = n; } }
    }
    if (count < minArea) {
      for (let i = 0; i < count; i++) {
        const p = componentBuf[i];
        const o = p * 4;
        data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = 255;
      }
    }
  }
  return imgd;
}

function pointsClose(a: Point, b: Point, eps = 0.05): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

// ---------------------------------------------------------------------------
// Winding normalization for traced contours.
//
// The whole app fills shapes with SVG fill-rule "nonzero" (see
// pathBuilder.ts). Under that rule, a hole/counter only stays open when its
// contour winds the OPPOSITE direction from the contour that contains it.
// imagetracer already tells us which paths are "holechildren" of which, but
// it does not guarantee the two paths' winding directions actually oppose
// each other for every source image/threshold combination — when they
// happen to match, the "hole" fills in solid instead of punching through
// (e.g. the counter of "A" or "O" disappearing). Rather than trust
// imagetracer's own winding, we recompute it geometrically: for every
// contour in an object, figure out its true nesting depth against the
// OTHER contours of that same object (by point-in-polygon containment), and
// force alternating winding by depth. This is deterministic and independent
// of whatever direction imagetracer happened to emit.
// ---------------------------------------------------------------------------

function cubicPointAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Flattens a contour to plain points (curves sampled) purely for area/containment math — never used for the actual rendered/exported geometry. */
function flattenTracedContour(contour: Contour, curveSteps = 12): Point[] {
  const nodes = contour.nodes ?? [];
  if (!nodes.length) return [];
  const points: Point[] = [{ ...nodes[0].point }];
  const segmentCount = contour.closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const from = nodes[i];
    const to = nodes[(i + 1) % nodes.length];
    if (from.handleOut || to.handleIn) {
      const c1 = from.handleOut ?? from.point;
      const c2 = to.handleIn ?? to.point;
      for (let step = 1; step <= curveSteps; step++) {
        points.push(cubicPointAt(from.point, c1, c2, to.point, step / curveSteps));
      }
    } else {
      points.push({ ...to.point });
    }
  }
  return points;
}

function tracedSignedArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

interface TracedBounds { minX: number; minY: number; maxX: number; maxY: number }

function tracedBoundsOf(points: Point[]): TracedBounds {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = points[0].x, minY = points[0].y, maxX = points[0].x, maxY = points[0].y;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function tracedBoundsContain(outer: TracedBounds, inner: TracedBounds): boolean {
  const eps = 1e-6;
  return outer.minX <= inner.minX + eps && outer.minY <= inner.minY + eps
    && outer.maxX >= inner.maxX - eps && outer.maxY >= inner.maxY - eps;
}

function tracedPointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Reverses a contour's traversal direction without changing its curve shape (incoming/outgoing handles swap roles at every node). */
function reverseTracedContour(contour: Contour): Contour {
  return {
    ...contour,
    nodes: [...contour.nodes].reverse().map((node) => ({
      ...node,
      point: { ...node.point },
      handleIn: node.handleOut ? { ...node.handleOut } : null,
      handleOut: node.handleIn ? { ...node.handleIn } : null,
    })),
  };
}

/**
 * Forces correct alternating winding (by true geometric nesting depth)
 * across one traced object's contours, so its outer shape and any counters
 * render correctly under the app's nonzero fill rule regardless of what
 * direction imagetracer emitted them in.
 */
function normalizeTracedWinding(contours: Contour[]): Contour[] {
  if (contours.length <= 1) return contours;

  const geometry = contours.map((contour) => {
    const pts = flattenTracedContour(contour);
    const area = tracedSignedArea(pts);
    return { contour, pts, area, absArea: Math.abs(area), bounds: tracedBoundsOf(pts) };
  });

  // The largest contour defines the reference "outer" winding sign.
  let outerSign = 1;
  let maxArea = -1;
  for (const g of geometry) {
    if (g.absArea > maxArea) { maxArea = g.absArea; outerSign = g.area >= 0 ? 1 : -1; }
  }

  return geometry.map((item, index) => {
    if (item.pts.length < 3 || item.absArea <= 1e-6) return item.contour;
    const probe = item.pts[0];
    let depth = 0;
    for (let j = 0; j < geometry.length; j++) {
      if (j === index) continue;
      const other = geometry[j];
      if (other.absArea <= item.absArea + 1e-6) continue;
      if (!tracedBoundsContain(other.bounds, item.bounds)) continue;
      if (tracedPointInPolygon(probe, other.pts)) depth++;
    }
    const desiredSign = depth % 2 === 0 ? outerSign : -outerSign;
    const currentSign = item.area >= 0 ? 1 : -1;
    return desiredSign === currentSign ? item.contour : reverseTracedContour(item.contour);
  });
}

/**
 * Converts one traced path's L/Q segments into a closed Contour of cubic
 * PathNodes. Quadratic control points are elevated to the exact equivalent
 * cubic handles (standard degree-elevation formula) since the app's
 * PathNode model is cubic-only. Node count stays exactly what imagetracer
 * fit — no extra points are introduced here.
 */
function pathToContour(path: TracePath, idPrefix: string): Contour {
  const segs = path.segments;
  if (segs.length === 0) return { id: shortId(idPrefix), nodes: [], closed: true };

  const nodes: PathNode[] = [
    { id: shortId("tn"), point: { x: segs[0].x1, y: segs[0].y1 }, handleIn: null, handleOut: null, type: "corner" },
  ];

  segs.forEach((seg, i) => {
    const fromNode = nodes[nodes.length - 1];
    const isLast = i === segs.length - 1;

    if (seg.type === "Q" && seg.x3 !== undefined && seg.y3 !== undefined) {
      const p0 = fromNode.point;
      const qc: Point = { x: seg.x2, y: seg.y2 };
      const p3: Point = { x: seg.x3, y: seg.y3 };
      // Exact quadratic → cubic degree elevation.
      const c1: Point = { x: p0.x + (2 / 3) * (qc.x - p0.x), y: p0.y + (2 / 3) * (qc.y - p0.y) };
      const c2: Point = { x: p3.x + (2 / 3) * (qc.x - p3.x), y: p3.y + (2 / 3) * (qc.y - p3.y) };
      fromNode.handleOut = c1;
      if (isLast && pointsClose(p3, nodes[0].point)) {
        nodes[0].handleIn = c2;
      } else {
        nodes.push({ id: shortId("tn"), point: p3, handleIn: c2, handleOut: null, type: "corner" });
      }
    } else {
      const p2: Point = { x: seg.x2, y: seg.y2 };
      if (!(isLast && pointsClose(p2, nodes[0].point))) {
        nodes.push({ id: shortId("tn"), point: p2, handleIn: null, handleOut: null, type: "corner" });
      }
    }
  });

  return { id: shortId(idPrefix), nodes, closed: true };
}

/**
 * Groups an ink layer's paths into VectorObjects: each outer (non-hole)
 * path becomes its own object, carrying any of its counters (holes) as
 * additional contours — matching the app's "shape objects hold multiple
 * contours only for intentional compound counters" convention, and letting
 * separate ink islands (e.g. the dot and stem of "i") stay independently
 * selectable/editable objects, just like drawing them by hand would.
 */
function pathsToVectorObjects(paths: TracePath[]): VectorObject[] {
  const objects: VectorObject[] = [];
  const consumedHoles = new Set<number>();

  paths.forEach((path, idx) => {
    if (path.isholepath) return;
    const contours: Contour[] = [pathToContour(path, "trace_c")];
    for (const holeIdx of path.holechildren ?? []) {
      const holePath = paths[holeIdx];
      if (holePath) {
        contours.push(pathToContour(holePath, "trace_c"));
        consumedHoles.add(holeIdx);
      }
    }
    objects.push({ id: shortId("trace_obj"), kind: "shape", contours: normalizeTracedWinding(contours) });
  });

  // Safety net: any hole path never claimed by a parent above still becomes
  // its own filled object, so no traced ink is ever silently dropped even
  // if a particular tracer version's holechildren indices don't line up.
  paths.forEach((path, idx) => {
    if (path.isholepath && !consumedHoles.has(idx)) {
      objects.push({ id: shortId("trace_obj"), kind: "shape", contours: [pathToContour(path, "trace_c")] });
    }
  });

  return objects.filter((o) => o.contours.some((c) => c.nodes.length >= 3));
}

/** Runs imagetracer against already-binarized (pure black/white) ImageData and returns the ink shapes, in raw pixel space (Y-down, origin top-left). */
export function traceBinaryImage(imgd: ImageData, detail: TraceDetail): VectorObject[] {
  const preset = DETAIL_PRESETS[detail];
  const tracedata: Tracedata = ImageTracer.imagedataToTracedata(imgd, {
    ltres: preset.ltres,
    qtres: preset.qtres,
    pathomit: preset.pathomit,
    rightangleenhance: true,
    roundcoords: 2,
    // imagetracer's own single-pixel edge-noise filter — a second,
    // complementary pass to despeckleBinary (which removes whole isolated
    // islands; this smooths jagged single-pixel steps along real edges so
    // thin strokes trace as clean parallel lines instead of a "gemuk"
    // (fattened) or ragged outline).
    linefilter: true,
    // Fixed 2-color palette (white background, black ink) keeps the result
    // deterministic — no run-to-run color-quantization variance.
    pal: [
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 0, g: 0, b: 0, a: 255 },
    ],
  });
  const inkPaths = tracedata.layers[1] ?? [];
  return pathsToVectorObjects(inkPaths);
}

function fmtPx(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Builds an SVG `d` attribute for one traced contour directly in its native
 * raw pixel space (Y-down, top-left origin) — unlike pathBuilder.ts's
 * contourToPath, no Y-flip is needed since pixel space already matches SVG's
 * own coordinate convention. Used to render the unified trace canvas, where
 * every detected shape must line up in the same coordinate system it was
 * traced in.
 */
export function tracedContourPath(contour: Contour): string {
  const nodes = contour.nodes;
  if (nodes.length === 0) return "";
  let d = `M ${fmtPx(nodes[0].point.x)} ${fmtPx(nodes[0].point.y)}`;
  const segmentCount = contour.closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const from = nodes[i];
    const to = nodes[(i + 1) % nodes.length];
    const c1 = from.handleOut;
    const c2 = to.handleIn;
    if (c1 || c2) {
      const control1 = c1 ?? from.point;
      const control2 = c2 ?? to.point;
      d += ` C ${fmtPx(control1.x)} ${fmtPx(control1.y)} ${fmtPx(control2.x)} ${fmtPx(control2.y)} ${fmtPx(to.point.x)} ${fmtPx(to.point.y)}`;
    } else {
      d += ` L ${fmtPx(to.point.x)} ${fmtPx(to.point.y)}`;
    }
  }
  if (contour.closed) d += " Z";
  return d;
}

/** Compound `d` for a whole traced object (all its contours) in raw pixel space — pair with fillRule="nonzero" so counters normalized by `normalizeTracedWinding` render as actual holes. */
export function tracedObjectFillPath(obj: VectorObject): string {
  return obj.contours.map(tracedContourPath).join(" ");
}

export interface PxBounds { minX: number; minY: number; maxX: number; maxY: number }

export function objectsBoundsPx(objects: VectorObject[]): PxBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const obj of objects) {
    for (const contour of obj.contours) {
      for (const node of contour.nodes) {
        found = true;
        minX = Math.min(minX, node.point.x);
        minY = Math.min(minY, node.point.y);
        maxX = Math.max(maxX, node.point.x);
        maxY = Math.max(maxY, node.point.y);
      }
    }
  }
  return found ? { minX, minY, maxX, maxY } : null;
}

/** One detected letter/shape cluster: a set of traced ink islands (e.g. the dot + stem of "i") that visually belong together, in raw pixel space. */
export interface TraceLetterGroup {
  id: string;
  objects: VectorObject[];
  bounds: PxBounds;
}

/** Gap between two 1D ranges: 0 when they overlap, otherwise the distance separating them. */
function rangeGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (aMax < bMin) return bMin - aMax;
  if (bMax < aMin) return aMin - bMax;
  return 0;
}

/** Overlap length between two 1D ranges (0 when they don't overlap). */
function rangeOverlap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}

/**
 * Splits a flat list of traced ink islands into per-letter groups so the
 * UI can offer each detected character as its own selectable/draggable
 * result instead of one big lump. Uses union-find over each object's pixel
 * bounding box, joining two islands under either of two targeted rules
 * rather than one loose "close in X and close in Y" test:
 *
 *  - Same-line neighbors: their vertical extents overlap substantially
 *    (they clearly sit on the same baseline) and the horizontal gap
 *    between them is small — this reconnects a single letter that got
 *    split into multiple ink islands (a thin bridge lost to thresholding)
 *    without also swallowing the next letter over, since genuinely
 *    separate letters normally leave a wider horizontal gap than an
 *    accidental break inside one.
 *  - Stacked parts (dot + stem of "i"/"j", diacritics/accents): their
 *    horizontal extents overlap substantially (the small mark sits above
 *    or below the body it belongs to) and the vertical gap between them
 *    is within a size-relative allowance.
 *
 * Both thresholds scale with the detected shapes' own median size, so this
 * adapts to the source image's resolution and letter size instead of using
 * fixed pixel constants.
 */
export function groupTracedObjectsIntoLetters(objects: VectorObject[]): TraceLetterGroup[] {
  if (objects.length === 0) return [];
  const bounds = objects.map((o) => objectsBoundsPx([o])!);

  const widths = bounds.map((b) => b.maxX - b.minX).sort((a, b) => a - b);
  const heights = bounds.map((b) => b.maxY - b.minY).sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)] || 1;
  const medianHeight = heights[Math.floor(heights.length / 2)] || 1;
  // Same-line horizontal bridge: tight, since it only needs to reconnect an
  // accidental break inside one letter (a thin bridge lost to thresholding,
  // typically just a few px regardless of letter size) — real letter-to-
  // letter spacing must never be bridged, even in tightly kerned or
  // touching handwritten/brush-script samples. Capped in absolute pixels
  // (not just scaled by letter width) so this stays tiny even for large
  // median widths — otherwise two genuinely separate, adjacent letters
  // (e.g. "A" and "B" sitting close together) get fused into one selectable
  // object instead of staying independently selectable.
  const gapXNeighbor = Math.min(6, Math.max(2, medianWidth * 0.05));
  // Stacked-part vertical bridge: generous, to reliably span the gap
  // between a dot/accent and the body it sits above or below.
  const gapYStacked = Math.max(4, medianHeight * 0.6);

  const n = objects.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bounds[i];
      const b = bounds[j];
      const widthA = a.maxX - a.minX;
      const widthB = b.maxX - b.minX;
      const heightA = a.maxY - a.minY;
      const heightB = b.maxY - b.minY;

      const gapX = rangeGap(a.minX, a.maxX, b.minX, b.maxX);
      const gapY = rangeGap(a.minY, a.maxY, b.minY, b.maxY);
      const overlapX = rangeOverlap(a.minX, a.maxX, b.minX, b.maxX);
      const overlapY = rangeOverlap(a.minY, a.maxY, b.minY, b.maxY);

      const sameLineNeighbor = overlapY >= 0.4 * Math.min(heightA, heightB) && gapX <= gapXNeighbor;
      const stackedPart = overlapX >= 0.35 * Math.min(widthA, widthB) && gapY <= gapYStacked;

      if (sameLineNeighbor || stackedPart) union(i, j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = clusters.get(root) ?? [];
    arr.push(i);
    clusters.set(root, arr);
  }

  const groups: TraceLetterGroup[] = Array.from(clusters.values()).map((indices) => {
    const groupObjects = indices.map((i) => objects[i]);
    const groupBounds = objectsBoundsPx(groupObjects)!;
    return { id: shortId("trace_letter"), objects: groupObjects, bounds: groupBounds };
  });

  // Reading order: left to right, tie-broken top to bottom.
  groups.sort((a, b) => a.bounds.minX - b.bounds.minX || a.bounds.minY - b.bounds.minY);
  return groups;
}

/**
 * Maps traced VectorObjects from pixel space (Y-down, top-left origin) into
 * the glyph's font-unit space (Y-up, baseline at 0): scaled uniformly to
 * the font's cap height (falling back to ascender), anchored on the
 * baseline, and centered within the target glyph's advance width. The
 * glyph's own metrics (advance width, sidebearings) are left untouched —
 * only the outline is replaced — so they stay editable afterward exactly
 * like any hand-drawn glyph.
 */
export function fitTracedObjectsToGlyph(
  objects: VectorObject[],
  metrics: FontMetrics,
  advanceWidth: number
): GlyphOutline {
  const bounds = objectsBoundsPx(objects);
  if (!bounds) return { objects: [] };

  const traceW = Math.max(1e-6, bounds.maxX - bounds.minX);
  const traceH = Math.max(1e-6, bounds.maxY - bounds.minY);
  const targetH = metrics.capHeight > 0 ? metrics.capHeight : metrics.ascender;
  const scale = targetH / traceH;
  const targetW = traceW * scale;
  const marginX = Math.max(0, (advanceWidth - targetW) / 2);

  const transformPoint = (p: Point): Point => ({
    x: (p.x - bounds.minX) * scale + marginX,
    y: (bounds.maxY - p.y) * scale,
  });

  const transformedObjects: VectorObject[] = objects.map((obj) => ({
    ...obj,
    id: shortId("trace_obj"),
    contours: obj.contours.map((c) => ({
      ...c,
      id: shortId("trace_c"),
      nodes: c.nodes.map((n) => ({
        ...n,
        id: shortId("tn"),
        point: transformPoint(n.point),
        handleIn: n.handleIn ? transformPoint(n.handleIn) : null,
        handleOut: n.handleOut ? transformPoint(n.handleOut) : null,
      })),
    })),
  }));

  return { objects: transformedObjects };
}

/**
 * End-to-end: File → binarized + despeckled canvas → traced VectorObjects,
 * in raw pixel space, plus those objects clustered into per-letter groups.
 * Fitting into a specific glyph happens separately via
 * `fitTracedObjectsToGlyph`, per letter group or across all of them.
 */
export async function traceImageFile(
  file: File,
  settings: TraceSettings
): Promise<{ objects: VectorObject[]; letters: TraceLetterGroup[]; canvas: HTMLCanvasElement }> {
  const img = await loadImageFile(file);
  const canvas = imageToCanvas(img, settings.detail);
  const imgd = binarize(canvas, settings);
  despeckleBinary(imgd, DESPECKLE_MIN_AREA[settings.detail]);
  const objects = traceBinaryImage(imgd, settings.detail);
  if (objects.length === 0) {
    throw new TraceError("Tidak ada garis yang terdeteksi. Coba sesuaikan Threshold atau gunakan gambar lain.");
  }
  const letters = groupTracedObjectsIntoLetters(objects);
  return { objects, letters, canvas };
}
