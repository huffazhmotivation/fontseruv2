import type { Contour, GlyphOutline, PathNode, Point, VectorObject } from "@/types/geometry";
import { hasOutline, type Glyph, type GlyphMap } from "@/types/glyph";
import { flattenContour, skewObject, cloneObjectWithNewIds } from "@/editor/objectOps";

export interface FamilyGenerationResult {
  glyphs: GlyphMap;
  generated: number;
  replaced: number;
  preserved: number;
  skippedRegular: number;
}

function signedArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function normalized(v: Point): Point {
  const length = Math.hypot(v.x, v.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: v.x / length, y: v.y / length };
}

function nodeTangentIn(nodes: PathNode[], index: number): Point {
  const node = nodes[index];
  const prev = nodes[(index - 1 + nodes.length) % nodes.length];
  const from = node.handleIn ?? prev.point;
  return normalized({ x: node.point.x - from.x, y: node.point.y - from.y });
}

function nodeTangentOut(nodes: PathNode[], index: number): Point {
  const node = nodes[index];
  const next = nodes[(index + 1) % nodes.length];
  const to = node.handleOut ?? next.point;
  return normalized({ x: to.x - node.point.x, y: to.y - node.point.y });
}

function outwardNormal(tangent: Point, orientation: number): Point {
  // Y-up font coordinates: the exterior is on the right of a CCW contour
  // and on the left of a CW contour.
  return orientation >= 0
    ? { x: tangent.y, y: -tangent.x }
    : { x: -tangent.y, y: tangent.x };
}

function contourOffsetLimit(contour: Contour): number {
  const points = flattenContour(contour, 8);
  if (points.length < 2) return Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const minDimension = Math.min(maxX - minX, maxY - minY);
  return Math.max(0, minDimension * 0.35);
}

/**
 * Approximate a clean geometric offset while keeping the existing Bézier nodes
 * editable. Each node and its handles move together along a mitered local normal,
 * so curve tangents stay intact. Hole contours move inward instead of outward.
 */
function offsetClosedContour(contour: Contour, amount: number, isHole: boolean): Contour {
  if (!contour.closed || contour.nodes.length < 2 || amount <= 0) return contour;

  const flattened = flattenContour(contour, 10);
  const area = signedArea(flattened);
  if (Math.abs(area) < 1e-6) return contour;

  const orientation = area >= 0 ? 1 : -1;
  // Never let a counter collapse completely. This keeps O/B/P/R/a/e-style
  // holes editable even when the requested bold amount is aggressive.
  const distance = isHole ? -Math.min(amount, contourOffsetLimit(contour)) : amount;

  return {
    ...contour,
    nodes: contour.nodes.map((node, index, nodes) => {
      const inNormal = outwardNormal(nodeTangentIn(nodes, index), orientation);
      const outNormal = outwardNormal(nodeTangentOut(nodes, index), orientation);
      let miter = normalized({ x: inNormal.x + outNormal.x, y: inNormal.y + outNormal.y });

      if (Math.hypot(miter.x, miter.y) < 1e-6) {
        miter = Math.hypot(outNormal.x, outNormal.y) > 0 ? outNormal : inNormal;
      }

      // A true line offset intersects adjacent offset edges at distance /
      // dot(miter, normal). Clamp acute joins to avoid runaway spikes and the
      // self-intersections they tend to create.
      const dot = Math.abs(miter.x * outNormal.x + miter.y * outNormal.y);
      const scale = Math.min(Math.abs(distance) * 3, Math.abs(distance) / Math.max(0.34, dot));
      const signedScale = distance < 0 ? -scale : scale;
      const delta = { x: miter.x * signedScale, y: miter.y * signedScale };

      return {
        ...node,
        point: { x: node.point.x + delta.x, y: node.point.y + delta.y },
        handleIn: node.handleIn
          ? { x: node.handleIn.x + delta.x, y: node.handleIn.y + delta.y }
          : null,
        handleOut: node.handleOut
          ? { x: node.handleOut.x + delta.x, y: node.handleOut.y + delta.y }
          : null,
      };
    }),
  };
}

function cloneGeneratedObject(source: VectorObject): VectorObject {
  const cloned = cloneObjectWithNewIds(source);
  return cloned.brushSettings
    ? { ...cloned, brushSettings: { ...cloned.brushSettings } }
    : cloned;
}

function offsetFilledObject(source: VectorObject, amount: number): VectorObject {
  const cloned = cloneGeneratedObject(source);
  const polygons = cloned.contours.map((contour) => flattenContour(contour, 10));

  return {
    ...cloned,
    contours: cloned.contours.map((contour, index) => {
      if (!contour.closed || contour.nodes.length < 2) return contour;
      const probe = contour.nodes[0]?.point;
      if (!probe) return contour;

      let nestingDepth = 0;
      for (let other = 0; other < polygons.length; other++) {
        if (other === index || polygons[other].length < 3) continue;
        if (pointInPolygon(probe, polygons[other])) nestingDepth++;
      }
      return offsetClosedContour(contour, amount, nestingDepth % 2 === 1);
    }),
  };
}

export function autoBoldOutline(source: GlyphOutline, rawAmount: number): GlyphOutline {
  const amount = Math.max(0, Number.isFinite(rawAmount) ? rawAmount : 0);
  return {
    objects: source.objects.map((object) => {
      if (object.kind === "line" || object.kind === "brush") {
        const cloned = cloneGeneratedObject(object);
        return {
          ...cloned,
          // Increasing by 2× amount expands the rendered stroke by `amount`
          // on each side of its editable centerline.
          strokeWidth: Math.max(1, (object.strokeWidth ?? 20) + amount * 2),
        };
      }
      return offsetFilledObject(object, amount);
    }),
  };
}

export function autoItalicOutline(source: GlyphOutline, rawAngle: number): GlyphOutline {
  const angle = Math.max(-30, Math.min(30, Number.isFinite(rawAngle) ? rawAngle : 0));
  const shearX = Math.tan((angle * Math.PI) / 180);
  return {
    objects: source.objects.map((object) =>
      skewObject(cloneGeneratedObject(object), { x: 0, y: 0 }, shearX, 0)
    ),
  };
}

function generateStyle(
  regular: GlyphMap,
  target: GlyphMap,
  replaceExisting: boolean,
  transform: (outline: GlyphOutline) => GlyphOutline
): FamilyGenerationResult {
  let generated = 0;
  let replaced = 0;
  let preserved = 0;
  let skippedRegular = 0;
  let next = target;

  for (const [char, regularGlyph] of Object.entries(regular)) {
    if (!hasOutline(regularGlyph)) {
      skippedRegular++;
      continue;
    }

    const current = target[char];
    const hasExisting = Boolean(current && hasOutline(current));
    if (hasExisting && !replaceExisting) {
      preserved++;
      continue;
    }

    if (next === target) next = { ...target };
    const base: Glyph = current ?? regularGlyph;
    next[char] = {
      ...base,
      outline: transform(regularGlyph.outline),
      // Generated family vectors must never share mutable component arrays with Regular.
      components: [...base.components],
      unicodes: base.unicodes ? [...base.unicodes] : undefined,
    };
    if (hasExisting) replaced++;
    else generated++;
  }

  return { glyphs: next, generated, replaced, preserved, skippedRegular };
}

export function generateBoldFromRegular(
  regular: GlyphMap,
  bold: GlyphMap,
  amount: number,
  replaceExisting = false
): FamilyGenerationResult {
  return generateStyle(regular, bold, replaceExisting, (outline) => autoBoldOutline(outline, amount));
}

export function generateItalicFromRegular(
  regular: GlyphMap,
  italic: GlyphMap,
  angle: number,
  replaceExisting = false
): FamilyGenerationResult {
  return generateStyle(regular, italic, replaceExisting, (outline) => autoItalicOutline(outline, angle));
}
