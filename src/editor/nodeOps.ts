import type { Contour, GlyphOutline, NodeType, PathNode, Point, VectorObject } from "@/types/geometry";
import { reflect, reflectDirection, length, subtract, add } from "@/utils/geometry";
import { shortId } from "@/utils/id";
import { splitCubic } from "./bezier";

export function cloneContour(c: Contour): Contour {
  return {
    ...c,
    nodes: c.nodes.map((n) => ({
      ...n,
      point: { ...n.point },
      handleIn: n.handleIn ? { ...n.handleIn } : null,
      handleOut: n.handleOut ? { ...n.handleOut } : null,
    })),
  };
}

export function cloneObject(o: VectorObject): VectorObject {
  return {
    ...o,
    contours: o.contours.map(cloneContour),
    samples: o.samples ? o.samples.map((s) => ({ ...s })) : undefined,
  };
}

export function cloneOutline(outline: GlyphOutline): GlyphOutline {
  return { objects: outline.objects.map(cloneObject) };
}

export function findObject(outline: GlyphOutline, objectId: string): VectorObject | null {
  return outline.objects.find((o) => o.id === objectId) ?? null;
}

export function findContour(outline: GlyphOutline, contourId: string): Contour | null {
  for (const o of outline.objects) {
    const c = o.contours.find((c) => c.id === contourId);
    if (c) return c;
  }
  return null;
}

export function findNode(outline: GlyphOutline, contourId: string, nodeId: string): PathNode | null {
  const contour = findContour(outline, contourId);
  return contour?.nodes.find((n) => n.id === nodeId) ?? null;
}

export const NODE_TYPE_ORDER: NodeType[] = ["corner", "smooth", "symmetric"];

/** Comfortable default handle spread (font units) for a node that becomes
 * Symmetric with no existing handles to mirror — long enough to grab and
 * adjust easily, short enough not to overshoot small glyphs. */
const DEFAULT_SYMMETRIC_HANDLE_LENGTH = 60;

/** Tangent direction through `node`, inferred from its contour neighbors,
 * used to give a freshly-symmetric node's handles a sensible starting angle. */
function neighborTangent(contour: Contour, node: PathNode): Point {
  const n = contour.nodes.length;
  const idx = contour.nodes.findIndex((nd) => nd.id === node.id);
  if (idx === -1 || n < 2) return { x: 1, y: 0 };
  const prevIdx = contour.closed ? (idx - 1 + n) % n : Math.max(0, idx - 1);
  const nextIdx = contour.closed ? (idx + 1) % n : Math.min(n - 1, idx + 1);
  const prev = contour.nodes[prevIdx].point;
  const next = contour.nodes[nextIdx].point;
  const dir = subtract(next, prev);
  const len = length(dir);
  return len < 0.001 ? { x: 1, y: 0 } : { x: dir.x / len, y: dir.y / len };
}

/** Gives a handle-less node a comfortable, symmetric pair of handles along
 * its local tangent, so it's immediately easy to grab and adjust. */
function ensureSymmetricHandles(contour: Contour, node: PathNode): void {
  if (node.handleIn || node.handleOut) return;
  const dir = neighborTangent(contour, node);
  const offset = { x: dir.x * DEFAULT_SYMMETRIC_HANDLE_LENGTH, y: dir.y * DEFAULT_SYMMETRIC_HANDLE_LENGTH };
  node.handleOut = add(node.point, offset);
  node.handleIn = subtract(node.point, offset);
}

/** Drops any object whose contours are all gone / too small to render. */
function pruneObjects(outline: GlyphOutline): GlyphOutline {
  for (const obj of outline.objects) {
    obj.contours = obj.contours.filter((c) => c.nodes.length >= 2);
  }
  outline.objects = outline.objects.filter((o) => o.contours.length > 0);
  return outline;
}

export function retypeNode(
  outline: GlyphOutline,
  contourId: string,
  nodeId: string,
  nextType: NodeType
): GlyphOutline {
  const working = cloneOutline(outline);
  const node = findNode(working, contourId, nodeId);
  if (!node) return working;
  node.type = nextType;

  if (nextType !== "corner" && (node.handleIn || node.handleOut)) {
    if (node.handleOut) {
      node.handleIn =
        nextType === "symmetric"
          ? reflect(node.handleOut, node.point)
          : node.handleIn
          ? reflectDirection(node.handleOut, node.point, length(subtract(node.handleIn, node.point)))
          : reflect(node.handleOut, node.point);
    } else if (node.handleIn) {
      node.handleOut = reflect(node.handleIn, node.point);
    }
  } else if (nextType === "symmetric") {
    const contour = findContour(working, contourId);
    if (contour) ensureSymmetricHandles(contour, node);
  }
  return working;
}


/** Retype every selected node in one geometry pass / one undo step. */
export function retypeNodes(
  outline: GlyphOutline,
  refs: { contourId: string; nodeId: string }[],
  nextType: NodeType
): GlyphOutline {
  const working = cloneOutline(outline);
  for (const ref of refs) {
    const node = findNode(working, ref.contourId, ref.nodeId);
    if (!node) continue;
    node.type = nextType;

    if (nextType !== "corner" && (node.handleIn || node.handleOut)) {
      if (node.handleOut) {
        node.handleIn =
          nextType === "symmetric"
            ? reflect(node.handleOut, node.point)
            : node.handleIn
            ? reflectDirection(node.handleOut, node.point, length(subtract(node.handleIn, node.point)))
            : reflect(node.handleOut, node.point);
      } else if (node.handleIn) {
        node.handleOut = reflect(node.handleIn, node.point);
      }
    } else if (nextType === "symmetric") {
      const contour = findContour(working, ref.contourId);
      if (contour) ensureSymmetricHandles(contour, node);
    }
  }
  return working;
}

/** Removes several nodes (possibly across multiple contours/objects) in one pass. */
export function deleteNodes(outline: GlyphOutline, refs: { contourId: string; nodeId: string }[]): GlyphOutline {
  const working = cloneOutline(outline);
  const byContour = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!byContour.has(r.contourId)) byContour.set(r.contourId, new Set());
    byContour.get(r.contourId)!.add(r.nodeId);
  }
  for (const [contourId, nodeIds] of byContour) {
    const contour = findContour(working, contourId);
    if (!contour) continue;
    contour.nodes = contour.nodes.filter((n) => !nodeIds.has(n.id));
  }
  return pruneObjects(working);
}

/** Rigidly translates a set of selected nodes (point + both handles) by `delta`. */
export function moveNodesBy(
  outline: GlyphOutline,
  refs: { contourId: string; nodeId: string }[],
  delta: Point
): GlyphOutline {
  const working = cloneOutline(outline);
  const wanted = new Set(refs.map((r) => `${r.contourId}:${r.nodeId}`));
  for (const obj of working.objects) {
    for (const contour of obj.contours) {
      for (const node of contour.nodes) {
        if (!wanted.has(`${contour.id}:${node.id}`)) continue;
        node.point = add(node.point, delta);
        if (node.handleIn) node.handleIn = add(node.handleIn, delta);
        if (node.handleOut) node.handleOut = add(node.handleOut, delta);
      }
    }
  }
  return working;
}

export interface SegmentRef {
  contourId: string;
  /** Index of the segment's starting node; runs to the next node (wrapping if closed). */
  fromIndex: number;
}

/**
 * Inserts a new on-curve node into a segment at parameter `t` (0..1), using
 * De Casteljau subdivision on curves so the visible shape is preserved.
 */
export function insertNodeOnSegment(outline: GlyphOutline, ref: SegmentRef, t: number): GlyphOutline {
  const working = cloneOutline(outline);
  const contour = findContour(working, ref.contourId);
  if (!contour) return working;
  const n = contour.nodes.length;
  const toIndex = (ref.fromIndex + 1) % n;
  if (!contour.closed && ref.fromIndex === n - 1) return working;

  const from = contour.nodes[ref.fromIndex];
  const to = contour.nodes[toIndex];
  const isCurve = Boolean(from.handleOut || to.handleIn);

  let newNode: PathNode;
  if (isCurve) {
    const c1 = from.handleOut ?? from.point;
    const c2 = to.handleIn ?? to.point;
    const { left, right } = splitCubic(from.point, c1, c2, to.point, t);
    from.handleOut = left[1];
    to.handleIn = right[2];
    newNode = { id: shortId("node"), point: left[3], handleIn: left[2], handleOut: right[1], type: "smooth" };
  } else {
    const point = {
      x: from.point.x + (to.point.x - from.point.x) * t,
      y: from.point.y + (to.point.y - from.point.y) * t,
    };
    newNode = { id: shortId("node"), point, handleIn: null, handleOut: null, type: "corner" };
  }

  contour.nodes.splice(ref.fromIndex + 1, 0, newNode);
  return working;
}

/**
 * Bends a segment into a Bézier curve (Cmd/Ctrl + drag). `target` is where
 * the user is dragging the segment toward; we solve for control handles so
 * the curve at t=0.5 passes near `target`, giving an intuitive "pull the
 * segment" feel. Endpoints keep their positions; their node type upgrades
 * to smooth so the curvature is retained on further editing.
 */
export function bendSegment(outline: GlyphOutline, ref: SegmentRef, t: number, target: Point): GlyphOutline {
  const working = cloneOutline(outline);
  const contour = findContour(working, ref.contourId);
  if (!contour) return working;
  const n = contour.nodes.length;
  const toIndex = (ref.fromIndex + 1) % n;
  if (!contour.closed && ref.fromIndex === n - 1) return working;

  const from = contour.nodes[ref.fromIndex];
  const to = contour.nodes[toIndex];
  const p0 = from.point;
  const p3 = to.point;
  const tt = Math.min(0.85, Math.max(0.15, t));

  // For a cubic B(t) with symmetric control offsets d from the chord, the
  // curve at t is chord(t) + factor*d. Solve d so B(tt) ≈ target.
  const chord = { x: p0.x + (p3.x - p0.x) * tt, y: p0.y + (p3.y - p0.y) * tt };
  const need = { x: target.x - chord.x, y: target.y - chord.y };
  const b1 = 3 * (1 - tt) * (1 - tt) * tt;
  const b2 = 3 * (1 - tt) * tt * tt;
  const factor = b1 + b2 || 1;
  const d = { x: need.x / factor, y: need.y / factor };

  from.handleOut = { x: p0.x + (p3.x - p0.x) / 3 + d.x, y: p0.y + (p3.y - p0.y) / 3 + d.y };
  to.handleIn = { x: p3.x - (p3.x - p0.x) / 3 + d.x, y: p3.y - (p3.y - p0.y) / 3 + d.y };
  if (from.type === "corner") from.type = "smooth";
  if (to.type === "corner") to.type = "smooth";
  return working;
}
