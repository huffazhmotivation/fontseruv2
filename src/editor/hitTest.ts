import type { GlyphOutline, Point } from "@/types/geometry";
import { distance } from "@/utils/geometry";

export interface HitResult {
  contourId: string;
  nodeId: string;
  part: "point" | "handleIn" | "handleOut";
}

/**
 * Finds the closest node/handle within `radius` of `p` across all objects.
 * On-curve points win ties over handles.
 */
export function hitTestOutline(outline: GlyphOutline, p: Point, radius: number): HitResult | null {
  let best: HitResult | null = null;
  let bestDist = radius;
  let bestIsPoint = false;

  for (const obj of outline.objects) {
    for (const contour of obj.contours) {
      for (const node of contour.nodes) {
        const dPoint = distance(node.point, p);
        if (dPoint <= bestDist && (!bestIsPoint || dPoint < bestDist)) {
          best = { contourId: contour.id, nodeId: node.id, part: "point" };
          bestDist = dPoint;
          bestIsPoint = true;
        }
        if (!bestIsPoint || bestDist === radius) {
          if (node.handleIn) {
            const d = distance(node.handleIn, p);
            if (d <= bestDist) {
              best = { contourId: contour.id, nodeId: node.id, part: "handleIn" };
              bestDist = d;
            }
          }
          if (node.handleOut) {
            const d = distance(node.handleOut, p);
            if (d <= bestDist) {
              best = { contourId: contour.id, nodeId: node.id, part: "handleOut" };
              bestDist = d;
            }
          }
        }
      }
    }
  }
  return best;
}
