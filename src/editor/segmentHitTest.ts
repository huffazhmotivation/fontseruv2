import type { GlyphOutline, Point } from "@/types/geometry";
import { closestPointOnCubic, closestPointOnLine } from "./bezier";

export interface SegmentHit {
  contourId: string;
  fromIndex: number;
  t: number;
  point: Point;
  distance: number;
}

export function hitTestSegments(outline: GlyphOutline, target: Point, radius: number): SegmentHit | null {
  let best: SegmentHit | null = null;

  for (const obj of outline.objects) {
    for (const contour of obj.contours) {
      const n = contour.nodes.length;
      const segmentCount = contour.closed ? n : n - 1;
      for (let i = 0; i < segmentCount; i++) {
        const from = contour.nodes[i];
        const to = contour.nodes[(i + 1) % n];
        const isCurve = Boolean(from.handleOut || to.handleIn);
        const result = isCurve
          ? closestPointOnCubic(from.point, from.handleOut ?? from.point, to.handleIn ?? to.point, to.point, target)
          : closestPointOnLine(from.point, to.point, target);

        if (result.distance <= radius && (!best || result.distance < best.distance)) {
          best = { contourId: contour.id, fromIndex: i, t: result.t, point: result.point, distance: result.distance };
        }
      }
    }
  }
  return best;
}
