import type { Contour, PathNode, Point, VectorObject, StrokeCap, StrokeSample } from "@/types/geometry";
import type { BrushSettings, BrushType } from "@/types/brush";
import { shortId } from "@/utils/id";
import { simplifyPolyline } from "@/utils/simplify";
import { BRUSH_PRESETS } from "./presets";
import { flattenContour } from "@/editor/objectOps";

function movingAverage(samples: StrokeSample[], windowRadius: number): StrokeSample[] {
  if (windowRadius <= 0) return samples;
  const out: StrokeSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    let sx = 0, sy = 0, sp = 0, n = 0;
    for (let j = Math.max(0, i - windowRadius); j <= Math.min(samples.length - 1, i + windowRadius); j++) {
      sx += samples[j].x; sy += samples[j].y; sp += samples[j].pressure; n++;
    }
    out.push({ x: sx / n, y: sy / n, pressure: sp / n });
  }
  return out;
}

function ellipseRadius(dirAngle: number, axisAngle: number, a: number, b: number): number {
  const rel = dirAngle - axisAngle;
  const cos = Math.cos(rel);
  const sin = Math.sin(rel);
  const denom = Math.sqrt((cos / a) ** 2 + (sin / b) ** 2);
  return denom === 0 ? a : 1 / denom;
}

function taperFactor(s: number, taperStart: number, taperEnd: number): number {
  let f = 1;
  if (taperStart > 0 && s < taperStart) {
    const t = s / taperStart;
    f = Math.min(f, t * t * (3 - 2 * t));
  }
  if (taperEnd > 0 && s > 1 - taperEnd) {
    const t = (1 - s) / taperEnd;
    f = Math.min(f, t * t * (3 - 2 * t));
  }
  return Math.max(0.08, f);
}

/** Deterministic pseudo-noise in [-1,1] — same seed always gives the same value, so a stroke's rough edge doesn't flicker on re-render. */
function pseudoNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** Clean, simplified centerline (font units) from raw samples. */
export function samplesToCenterline(rawSamples: StrokeSample[], settings: BrushSettings): StrokeSample[] {
  if (rawSamples.length < 2) return rawSamples;
  const windowRadius = Math.round(settings.smoothing * 6);
  let smoothed = movingAverage(rawSamples, windowRadius);
  // Grunge needs dense edge events all along the stroke; simplifying a
  // straight gesture down to two endpoints would erase the jagged profile.
  if (settings.type === "grunge") return smoothed;
  // A second, lighter pass approximates a Gaussian kernel far better than a
  // single box-average pass alone — it noticeably rounds out curved
  // gestures (fewer visible facets through bends) without flattening
  // intentional corners, since simplifyPolyline below still preserves
  // sharp turns regardless of how much this smooths the curve itself.
  if (windowRadius > 0) {
    smoothed = movingAverage(smoothed, Math.max(1, Math.round(windowRadius * 0.6)));
  }
  const epsilon = Math.max(0.4, settings.size * 0.03);
  return simplifyPolyline(smoothed, epsilon);
}

/**
 * Open editable brush centerline.
 *
 * Freehand strokes should stay fluid when the user switches to the Node tool.
 * We therefore infer cubic handles from the sampled polyline and mark curved
 * points as `smooth` (collinear handles with independent lengths), not
 * `symmetric`. Very sharp turns stay corners so an intentional cusp is not
 * rounded away. Pixel Brush opts out and keeps exact grid corners.
 */
export function centerlineToContour(
  centerline: { x: number; y: number }[],
  autoSmooth = true
): Contour | null {
  if (centerline.length < 2) return null;

  const points = centerline.map((p) => ({ x: p.x, y: p.y }));
  const nodes: PathNode[] = points.map((point) => ({
    id: shortId("node"),
    point,
    handleIn: null,
    handleOut: null,
    type: "corner",
  }));

  if (!autoSmooth || points.length < 3) {
    return { id: shortId("contour"), closed: false, nodes };
  }

  const unit = (dx: number, dy: number) => {
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  };
  const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

  // Freehand gestures are biased toward smoothness: even a fairly strong
  // bend should remain a smooth node. Only very sharp cusp-like changes stay
  // corners so the brush never turns a deliberate point into a loop/overshoot.
  const maxSmoothTurn = (120 * Math.PI) / 180;
  const smoothFlags = new Array(points.length).fill(false);

  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const u0 = unit(b.x - a.x, b.y - a.y);
    const u1 = unit(c.x - b.x, c.y - b.y);
    const dot = Math.max(-1, Math.min(1, u0.x * u1.x + u0.y * u1.y));
    const turn = Math.acos(dot);
    smoothFlags[i] = turn <= maxSmoothTurn;
  }

  // Give endpoints a one-sided smooth handle when the adjacent section is
  // smooth. This avoids a visibly straight first/last segment on a curved
  // freehand stroke without pretending the endpoint has two equal handles.
  smoothFlags[0] = smoothFlags[1] ?? false;
  smoothFlags[points.length - 1] = smoothFlags[points.length - 2] ?? false;

  for (let i = 0; i < points.length; i++) {
    if (!smoothFlags[i]) continue;
    const prev = points[Math.max(0, i - 1)];
    const cur = points[i];
    const next = points[Math.min(points.length - 1, i + 1)];

    let tangent: Point;
    if (i === 0) tangent = unit(next.x - cur.x, next.y - cur.y);
    else if (i === points.length - 1) tangent = unit(cur.x - prev.x, cur.y - prev.y);
    else tangent = unit(next.x - prev.x, next.y - prev.y);

    // Independent incoming/outgoing lengths are deliberate: this is a
    // `smooth` node, not a `symmetric` node. The 0.30 factor keeps the fitted
    // curve close to the user's gesture and avoids overshoot on dense samples.
    const inLen = i > 0 ? Math.max(0.5, dist(prev, cur) * 0.30) : 0;
    const outLen = i < points.length - 1 ? Math.max(0.5, dist(cur, next) * 0.30) : 0;

    nodes[i].type = "smooth";
    if (inLen > 0) {
      nodes[i].handleIn = { x: cur.x - tangent.x * inLen, y: cur.y - tangent.y * inLen };
    }
    if (outLen > 0) {
      nodes[i].handleOut = { x: cur.x + tangent.x * outLen, y: cur.y + tangent.y * outLen };
    }
  }

  return { id: shortId("contour"), closed: false, nodes };
}

/**
 * Builds a closed variable-width outline polygon from a centerline with
 * per-point pressure, using the elliptical nib model.
 */
export function centerlineToOutline(centerline: StrokeSample[], settings: BrushSettings): Contour | null {
  if (centerline.length < 2) return null;

  const cumulative: number[] = [0];
  for (let i = 1; i < centerline.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(centerline[i].x - centerline[i - 1].x, centerline[i].y - centerline[i - 1].y));
  }
  const totalLength = cumulative[cumulative.length - 1] || 1;

  const nibAngleRad = (settings.angle * Math.PI) / 180;
  const semiMajor = Math.max(0.5, settings.size / 2);
  const semiMinor = Math.max(0.3, (settings.size / 2) * settings.roundness);

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < centerline.length; i++) {
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(centerline.length - 1, i + 1)];
    const tangent = { x: next.x - prev.x, y: next.y - prev.y };
    const tLen = Math.hypot(tangent.x, tangent.y) || 1;
    const normal = { x: -tangent.y / tLen, y: tangent.x / tLen };
    const normalAngle = Math.atan2(normal.y, normal.x);

    const pressure = settings.pressureEnabled ? centerline[i].pressure : 1;
    const widthFromPressure = settings.minSize + (settings.maxSize - settings.minSize) * pressure;
    const s = cumulative[i] / totalLength;
    const taper = taperFactor(s, settings.taperStart, settings.taperEnd);
    const halfWidthBase = (widthFromPressure / 2) * taper;
    const scale = halfWidthBase / Math.max(0.001, semiMajor);
    let r = ellipseRadius(normalAngle, nibAngleRad, semiMajor * scale, semiMinor * scale);

    // Grunge (and any future preset with `jitter`): a distressed edge is
    // still just a per-sample radius perturbation on the same real vector
    // outline — no raster texture involved. Two blended noise octaves keep
    // it from reading as a simple periodic wobble.
    const jitterAmt = settings.jitter ?? 0;
    if (jitterAmt > 0) {
      const n1 = pseudoNoise(i * 12.37);
      const n2 = pseudoNoise(i * 7.91 + 100);
      r *= 1 + jitterAmt * (n1 * 0.6 + n2 * 0.4) * 0.5;
      r = Math.max(r, semiMajor * 0.12);
    }

    const leftBase = { x: centerline[i].x + normal.x * r, y: centerline[i].y + normal.y * r };
    const rightBase = { x: centerline[i].x - normal.x * r, y: centerline[i].y - normal.y * r };

    if (settings.type === "grunge") {
      // Insert a sharp outward projection at nearly every centerline sample
      // on BOTH edges. These are real corner nodes, so the distressed spikes
      // remain editable vector geometry rather than a raster/noise effect.
      const tx = tangent.x / tLen;
      const ty = tangent.y / tLen;
      const leftNoise = pseudoNoise(i * 19.17 + 3.1);
      const rightNoise = pseudoNoise(i * 23.73 + 77.7);
      const leftSpike = 1.25 + Math.abs(leftNoise) * 1.35;
      const rightSpike = 1.25 + Math.abs(rightNoise) * 1.35;
      const tangentJitter = settings.size * 0.28;

      left.push(leftBase);
      left.push({
        x: centerline[i].x + normal.x * r * leftSpike + tx * leftNoise * tangentJitter,
        y: centerline[i].y + normal.y * r * leftSpike + ty * leftNoise * tangentJitter,
      });

      right.push(rightBase);
      right.push({
        x: centerline[i].x - normal.x * r * rightSpike + tx * rightNoise * tangentJitter,
        y: centerline[i].y - normal.y * r * rightSpike + ty * rightNoise * tangentJitter,
      });
    } else {
      left.push(leftBase);
      right.push(rightBase);
    }
  }

  const polygon = [...left, ...right.reverse()];
  if (polygon.length < 3) return null;
  return {
    id: shortId("contour"),
    closed: true,
    nodes: polygon.map((p) => ({ id: shortId("node"), point: p, handleIn: null, handleOut: null, type: "corner" as const })),
  };
}

/**
 * Pixel Brush's outline. This deliberately does NOT go through the
 * elliptical nib model above — a smoothed nib swept along grid-snapped
 * points would still look like a rounded line that merely tracks the grid.
 * Instead, every grid cell the stroke actually passes through becomes its
 * own axis-aligned square contour, so the result is genuinely made of
 * blocks (true grid-cell fill), which is what a pixel-font tool needs.
 * A Bresenham walk over cell indices between consecutive points fills in
 * any cell a fast or diagonal move would otherwise skip, so the blocks
 * always stay connected. This path is reached ONLY when `settings.gridSnap`
 * is set (Pixel Brush exclusively) — see `centerlineToOutlineContours`.
 */
export function pixelBlockOutline(centerline: { x: number; y: number }[], cellSize: number): Contour[] {
  if (centerline.length === 0 || cellSize <= 0) return [];

  // Pointer samples sit at CELL CENTERS (never on grid-line intersections).
  // floor() maps each center back to its containing cell; each square's edges
  // then land exactly on the visible grid lines.
  const toCell = (p: { x: number; y: number }) => ({
    cx: Math.floor(p.x / cellSize),
    cy: Math.floor(p.y / cellSize),
  });

  const seen = new Set<string>();
  const cells: { cx: number; cy: number }[] = [];
  const addCell = (cx: number, cy: number) => {
    const key = `${cx},${cy}`;
    if (seen.has(key)) return;
    seen.add(key);
    cells.push({ cx, cy });
  };

  let prevCell = toCell(centerline[0]);
  addCell(prevCell.cx, prevCell.cy);
  for (let i = 1; i < centerline.length; i++) {
    const cur = toCell(centerline[i]);
    let x0 = prevCell.cx;
    let y0 = prevCell.cy;
    const x1 = cur.cx;
    const y1 = cur.cy;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (x0 !== x1 || y0 !== y1) {
      addCell(x0, y0);
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    addCell(x1, y1);
    prevCell = cur;
  }

  return cells.map(({ cx, cy }) => {
    const x0 = cx * cellSize;
    const y0 = cy * cellSize;
    const x1 = x0 + cellSize;
    const y1 = y0 + cellSize;
    const corners: Point[] = [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    return {
      id: shortId("contour"),
      closed: true,
      nodes: corners.map((point) => ({ id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" as const })),
    };
  });
}

/**
 * Multi-contour outline for a centerline. Every preset except Pixel Brush
 * uses the single elliptical-nib contour above; Pixel Brush forks entirely
 * into `pixelBlockOutline`, isolated behind `settings.gridSnap` so no other
 * brush can ever pick up block/grid behavior.
 */
export function centerlineToOutlineContours(centerline: StrokeSample[], settings: BrushSettings): Contour[] {
  if (settings.type === "pixel" && settings.gridSnap === true) {
    return pixelBlockOutline(centerline, settings.cellSize ?? settings.size);
  }
  const single = centerlineToOutline(centerline, settings);
  return single ? [single] : [];
}

/** Live/committed brush outline (kept for the immediate preview during drawing). */
export function strokeToContour(rawSamples: StrokeSample[], settings: BrushSettings): Contour | null {
  const centerline = samplesToCenterline(rawSamples, settings);
  return centerlineToOutline(centerline, settings);
}

/**
 * Reconstructs the effective brush settings for a stored brush object from its
 * preset (brushType) scaled to the object's current strokeWidth. This is what
 * lets each preset keep its OWN nib shape / taper / pressure response — the
 * geometry, not just a label — when we (re)build its outline.
 */
export function brushSettingsForObject(obj: VectorObject): BrushSettings {
  if (obj.brushSettings) {
    const base = obj.brushSettings;
    const k = (obj.strokeWidth ?? base.size) / Math.max(1, base.size);
    return { ...base, size: base.size * k, minSize: base.minSize * k, maxSize: base.maxSize * k };
  }
  const width = obj.strokeWidth ?? 20;
  const preset = obj.brushType ? BRUSH_PRESETS[obj.brushType as BrushType] : undefined;
  const base = preset
    ? preset.settings
    : { size: 20, minSize: 12, maxSize: 20, opacity: 1, spacing: 4, smoothing: 0.4, roundness: 1, angle: 0, taperStart: 0.1, taperEnd: 0.1, pressureEnabled: true };
  const k = width / Math.max(1, base.size);
  return {
    type: (obj.brushType as BrushType) ?? "round",
    ...base,
    size: width,
    minSize: base.minSize * k,
    maxSize: base.maxSize * k,
  };
}

function resamplePressure(n: number, samples?: StrokeSample[]): number[] {
  if (!samples || samples.length === 0) return new Array(n).fill(0.6);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const frac = n <= 1 ? 0 : i / (n - 1);
    out.push(samples[Math.round(frac * (samples.length - 1))].pressure);
  }
  return out;
}

/**
 * The LIVE variable-width outline of a brush object, derived from its CURRENT
 * editable centerline (so it follows node edits) plus its brush profile. The
 * object's stored geometry stays a centerline — this is only for rendering and
 * thumbnails. Different presets => visibly different silhouettes on the same path.
 */
export function brushOutlineContours(obj: VectorObject): Contour[] {
  const settings = brushSettingsForObject(obj);
  const contours: Contour[] = [];
  for (const c of obj.contours) {
    const flattened = flattenContour(c, 10);
    const poly =
      settings.type === "grunge"
        ? flattened
        : simplifyPolyline(flattened, Math.max(0.5, settings.size * 0.025));
    if (poly.length < 2) continue;
    const pressures = resamplePressure(poly.length, obj.samples);
    const centerline: StrokeSample[] = poly.map((p, i) => ({ x: p.x, y: p.y, pressure: pressures[i] }));
    contours.push(...centerlineToOutlineContours(centerline, settings));
  }
  return contours;
}


function normalized(dx: number, dy: number): Point {
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function arcControl(center: Point, radius: number, a0: number, a1: number) {
  const delta = a1 - a0;
  const k = (4 / 3) * Math.tan(delta / 4);
  const p0 = { x: center.x + Math.cos(a0) * radius, y: center.y + Math.sin(a0) * radius };
  const p1 = { x: center.x + Math.cos(a1) * radius, y: center.y + Math.sin(a1) * radius };
  const t0 = { x: -Math.sin(a0), y: Math.cos(a0) };
  const t1 = { x: -Math.sin(a1), y: Math.cos(a1) };
  return {
    p0,
    p1,
    c1: { x: p0.x + t0.x * radius * k, y: p0.y + t0.y * radius * k },
    c2: { x: p1.x - t1.x * radius * k, y: p1.y - t1.y * radius * k },
  };
}

/**
 * Clean uniform-width outline for Pen Line / Monoline brush.
 * Uses the editable centerline geometry, keeps node density bounded, and
 * represents round caps with cubic arcs so the expanded result stays smooth
 * without dozens of cap points.
 */
export function uniformCenterlineToOutline(contour: Contour, width: number, cap: StrokeCap): Contour | null {
  const flattened = flattenContour(contour, 8);
  if (flattened.length < 2) return null;
  const pts = simplifyPolyline(flattened, Math.max(0.5, width * 0.025));
  if (pts.length < 2) return null;

  const r = Math.max(0.5, width / 2);
  const tangents = pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    return normalized(next.x - prev.x, next.y - prev.y);
  });

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const t = tangents[i];
    let base = pts[i];
    if (cap === "square") {
      if (i === 0) base = { x: base.x - t.x * r, y: base.y - t.y * r };
      if (i === pts.length - 1) base = { x: base.x + t.x * r, y: base.y + t.y * r };
    }
    const n = { x: -t.y, y: t.x };
    left.push({ x: base.x + n.x * r, y: base.y + n.y * r });
    right.push({ x: base.x - n.x * r, y: base.y - n.y * r });
  }

  const nodes: PathNode[] = left.map((point) => ({
    id: shortId("node"), point, handleIn: null as Point | null, handleOut: null as Point | null, type: "corner" as const,
  }));

  if (cap === "round") {
    const end = pts[pts.length - 1];
    const theta = Math.atan2(tangents[tangents.length - 1].y, tangents[tangents.length - 1].x);
    const a = arcControl(end, r, theta + Math.PI / 2, theta);
    const b = arcControl(end, r, theta, theta - Math.PI / 2);
    const leftEnd = nodes[nodes.length - 1];
    leftEnd.handleOut = a.c1;
    const mid = { id: shortId("node"), point: a.p1, handleIn: a.c2, handleOut: b.c1, type: "smooth" as const };
    nodes.push(mid);
    const rightEnd = {
      id: shortId("node"), point: b.p1, handleIn: b.c2, handleOut: null as Point | null, type: "smooth" as const,
    };
    nodes.push(rightEnd);
  } else {
    const point = right[right.length - 1];
    nodes.push({ id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" as const });
  }

  for (let i = right.length - 2; i >= 0; i--) {
    nodes.push({ id: shortId("node"), point: right[i], handleIn: null, handleOut: null, type: "corner" as const });
  }

  if (cap === "round") {
    const start = pts[0];
    const theta = Math.atan2(tangents[0].y, tangents[0].x);
    const a = arcControl(start, r, theta - Math.PI / 2, theta - Math.PI);
    const b = arcControl(start, r, theta - Math.PI, theta - (3 * Math.PI) / 2);
    const rightStart = nodes[nodes.length - 1];
    rightStart.handleOut = a.c1;
    const mid = { id: shortId("node"), point: a.p1, handleIn: a.c2, handleOut: b.c1, type: "smooth" as const };
    nodes.push(mid);
    // The closing segment lands on left[0]; give that first node the incoming
    // Bézier handle so the cap joins with no tiny fill seam/gap.
    nodes[0].handleIn = b.c2;
    nodes[0].type = "smooth";
  }

  return { id: shortId("contour"), closed: true, nodes };
}

/**
 * "Expand Stroke": convert a centerline stroke object (line or brush) into a
 * closed, filled "expanded" object. Non-destructive source stays editable
 * until this is invoked.
 */
export function expandStrokeObject(obj: VectorObject): VectorObject | null {
  const width = obj.strokeWidth ?? 20;

  // Uniform centerlines (Pen Line + Monoline Brush) expand from the CURRENT
  // centerline, so node edits, width and cap appearance are all preserved.
  if (obj.kind === "line" || (obj.kind === "brush" && obj.brushType === "monoline")) {
    const contours = obj.contours
      .map((c) => uniformCenterlineToOutline(c, width, obj.cap ?? "round"))
      .filter((c): c is Contour => Boolean(c));
    return contours.length ? { id: shortId("obj"), kind: "expanded", contours } : null;
  }

  if (obj.kind === "brush") {
    // Variable-profile brushes also expand from their current editable
    // centerline. brushOutlineContours resamples captured pressure onto the
    // edited path, avoiding the old "snap back to raw samples" behavior.
    const contours = brushOutlineContours(obj);
    if (contours.length) return { id: shortId("obj"), kind: "expanded", contours };
    return null;
  }

  return null;
}
