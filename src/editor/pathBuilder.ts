import type { Contour, Point, VectorObject } from "@/types/geometry";

/** Convert a font-unit point (Y-up, baseline=0) to SVG space (Y-down). */
export function toSvgPoint(p: Point, ascender: number): Point {
  return { x: p.x, y: ascender - p.y };
}

export function fromSvgPoint(p: Point, ascender: number): Point {
  return { x: p.x, y: ascender - p.y };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Builds the `d` attribute for a single contour, in SVG (Y-down) coordinates. */
export function contourToPath(contour: Contour, ascender: number): string {
  if (contour.nodes.length === 0) return "";
  const pts = contour.nodes.map((n) => ({
    svgPoint: toSvgPoint(n.point, ascender),
    svgHandleIn: n.handleIn ? toSvgPoint(n.handleIn, ascender) : null,
    svgHandleOut: n.handleOut ? toSvgPoint(n.handleOut, ascender) : null,
  }));

  let d = `M ${fmt(pts[0].svgPoint.x)} ${fmt(pts[0].svgPoint.y)}`;
  const segmentCount = contour.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const from = pts[i];
    const to = pts[(i + 1) % pts.length];
    const c1 = from.svgHandleOut;
    const c2 = to.svgHandleIn;
    if (c1 || c2) {
      const control1 = c1 ?? from.svgPoint;
      const control2 = c2 ?? to.svgPoint;
      d += ` C ${fmt(control1.x)} ${fmt(control1.y)} ${fmt(control2.x)} ${fmt(control2.y)} ${fmt(to.svgPoint.x)} ${fmt(to.svgPoint.y)}`;
    } else {
      d += ` L ${fmt(to.svgPoint.x)} ${fmt(to.svgPoint.y)}`;
    }
  }
  if (contour.closed) d += " Z";
  return d;
}

/**
 * Compound `d` for a filled object: all its contours concatenated. Combined
 * with fill-rule "nonzero" per object, an inner counter contour must wind
 * the opposite way to punch a hole — a *within-object* decision only.
 */
export function objectFillPath(obj: VectorObject, ascender: number): string {
  return obj.contours.map((c) => contourToPath(c, ascender)).join(" ");
}

/** Centerline `d` for a stroke object (open path, no auto-close). */
export function objectStrokePath(obj: VectorObject, ascender: number): string {
  return obj.contours.map((c) => contourToPath(c, ascender)).join(" ");
}
