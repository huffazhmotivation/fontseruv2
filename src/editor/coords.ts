import type { Point } from "@/types/geometry";

/** Converts a mouse/pointer client position into font-unit space (Y-up, baseline=0). */
export function clientToFontPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  ascender: number
): Point {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const svgP = pt.matrixTransform(ctm.inverse());
  return { x: svgP.x, y: ascender - svgP.y };
}
