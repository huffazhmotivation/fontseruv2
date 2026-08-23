import type { BrushSettings } from "./brush";

/**
 * Coordinate space: font units, Y-up, origin at glyph baseline (0,0).
 * Matches the OpenType / opentype.js convention so outlines map directly
 * onto font export later without conversion.
 */
export interface Point {
  x: number;
  y: number;
}

export type NodeType = "corner" | "smooth" | "symmetric";

/**
 * A single on-curve point of a contour, with optional cubic Bézier
 * control points. `handleIn` controls the curve arriving at this node;
 * `handleOut` controls the curve leaving it. Both are absolute font-unit
 * coordinates, or null when the adjoining segment is a straight line.
 */
export interface PathNode {
  id: string;
  point: Point;
  handleIn: Point | null;
  handleOut: Point | null;
  type: NodeType;
}

export interface Contour {
  id: string;
  nodes: PathNode[];
  closed: boolean;
}

/**
 * Geometry kind of a vector object. This distinction is intentional and
 * load-bearing (see architecture requirement): it decides how the object
 * is rendered and whether it participates in fill/winding at all.
 *
 *  - "shape"    Closed filled outline. May hold multiple contours to form
 *               an *intentional* compound counter (e.g. the hole in "O").
 *  - "line"     Open centerline (monoline) stroke drawn with the Pen. Kept
 *               as a real centerline with an adjustable width — never
 *               auto-outlined.
 *  - "brush"    Editable centerline produced by the Brush, carrying brush
 *               settings + the raw pressure samples so it can be expanded
 *               later without losing information.
 *  - "expanded" Closed filled outline generated from a stroke via
 *               "Expand Stroke".
 */
export type ObjectKind = "shape" | "line" | "brush" | "expanded";

export type StrokeCap = "butt" | "round" | "square";
export type StrokeJoin = "miter" | "round" | "bevel";

/** A single captured sample while dragging the brush tool. */
export interface StrokeSample {
  x: number;
  y: number;
  pressure: number;
}

/**
 * An independent vector object inside a glyph. Each object renders as its
 * OWN path element, which is what guarantees that two overlapping/touching
 * objects never subtract from each other or punch accidental holes — only
 * the multiple contours *within a single* "shape"/"expanded" object take
 * part in winding-based counters.
 */
export interface VectorObject {
  id: string;
  kind: ObjectKind;
  contours: Contour[];
  /** line + brush: centerline stroke width, in font units. */
  strokeWidth?: number;
  cap?: StrokeCap;
  join?: StrokeJoin;
  /** brush: which preset produced this stroke. */
  brushType?: string;
  /** brush: exact settings snapshot used (preserves slider tweaks). */
  brushSettings?: BrushSettings;
  /** brush: raw pressure samples, kept for non-destructive Expand. */
  samples?: StrokeSample[];
  /**
   * Flat object-group membership. Grouping never rewrites or nests geometry;
   * it only gives existing objects a shared id, so z-order, nodes, fills,
   * strokes and per-object editability survive Group/Ungroup losslessly.
   */
  groupId?: string;
}

export interface GlyphOutline {
  objects: VectorObject[];
}

export function emptyOutline(): GlyphOutline {
  return { objects: [] };
}

export function isStrokeObject(o: VectorObject): boolean {
  return o.kind === "line" || o.kind === "brush";
}

export function isFilledObject(o: VectorObject): boolean {
  return o.kind === "shape" || o.kind === "expanded";
}

/** Every contour across every object, tagged with its owning object id. */
export function allContours(outline: GlyphOutline): { objectId: string; contour: Contour }[] {
  const out: { objectId: string; contour: Contour }[] = [];
  for (const obj of outline.objects) {
    for (const contour of obj.contours) out.push({ objectId: obj.id, contour });
  }
  return out;
}

export function findObjectOfContour(outline: GlyphOutline, contourId: string): VectorObject | null {
  return outline.objects.find((o) => o.contours.some((c) => c.id === contourId)) ?? null;
}

export function totalNodeCount(outline: GlyphOutline): number {
  return outline.objects.reduce((sum, o) => sum + o.contours.reduce((s, c) => s + c.nodes.length, 0), 0);
}
