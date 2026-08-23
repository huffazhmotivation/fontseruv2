import { useCallback, useRef, useState } from "react";
import type { Contour, GlyphOutline, NodeType, PathNode, Point, VectorObject } from "@/types/geometry";
import { useAppStore, type NodeRef, type HandleRef } from "@/glyph/store";
import { shortId } from "@/utils/id";
import { hitTestOutline } from "./hitTest";
import { hitTestSegments } from "./segmentHitTest";
import { add, reflect, reflectDirection, snapAngle, subtract, length } from "@/utils/geometry";
import {
  cloneOutline,
  findNode,
  findContour,
  retypeNode,
  deleteNodes,
  moveNodesBy,
  insertNodeOnSegment,
  bendSegment,
  NODE_TYPE_ORDER,
} from "./nodeOps";
import { findObjectOfContour } from "@/types/geometry";

export interface Rect { x: number; y: number; w: number; h: number; }

type DragState =
  | { mode: "pen-place"; contourId: string; nodeId: string }
  | { mode: "move-selection"; refs: NodeRef[]; origin: Point }
  | { mode: "move-handle"; contourId: string; nodeId: string; part: "handleIn" | "handleOut"; nodeType: NodeType }
  | { mode: "curve"; contourId: string; fromIndex: number; t: number }
  | { mode: "marquee"; origin: Point; additive: boolean }
  | null;

function refKey(r: NodeRef) { return `${r.contourId}:${r.nodeId}`; }
function axisLock(delta: Point): Point {
  return Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
}
function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** hitScale = font units per screen pixel. */
export function useGlyphEditor(hitScale: number) {
  const tool = useAppStore((s) => s.tool);
  const penMode = useAppStore((s) => s.penMode);
  const penAutoClose = useAppStore((s) => s.penAutoClose);
  const lineWidth = useAppStore((s) => s.lineWidth);
  const lineCap = useAppStore((s) => s.lineCap);
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const liveOutline = useAppStore((s) => s.liveOutline);
  const selectedNodes = useAppStore((s) => s.selectedNodes);
  const selectedHandle = useAppStore((s) => s.selectedHandle);
  const drawingContourId = useAppStore((s) => s.drawingContourId);
  const showGrid = useAppStore((s) => s.showGrid);

  const commitOutline = useAppStore((s) => s.commitOutline);
  const setLiveOutline = useAppStore((s) => s.setLiveOutline);
  const selectNodes = useAppStore((s) => s.selectNodes);
  const toggleNodeSelection = useAppStore((s) => s.toggleNodeSelection);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const setSelectedHandle = useAppStore((s) => s.setSelectedHandle);
  const setDrawingContourId = useAppStore((s) => s.setDrawingContourId);

  const dragRef = useRef<DragState>(null);
  const baseOutlineRef = useRef<GlyphOutline | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  const marqueeRectRef = useRef<Rect | null>(null);

  const outline: GlyphOutline = liveOutline ?? glyph?.outline ?? { objects: [] };
  const hitRadius = 12 * hitScale;
  const closeRadius = 16 * hitScale;
  const segmentRadius = 10 * hitScale;
  const gridSize = 10; // snap increment — intentionally independent of the visual grid's display spacing (store.gridSize)

  const maybeSnap = useCallback(
    (p: Point) => (showGrid ? { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize } : p),
    [showGrid]
  );

  /* ------------------------------------------------------------ PEN */
  const penPointerDown = useCallback(
    (p: Point) => {
      const working = cloneOutline(outline);
      const snapped = maybeSnap(p);

      if (drawingContourId) {
        const contour = findContour(working, drawingContourId);
        if (contour && contour.nodes.length > 0) {
          const first = contour.nodes[0];
          const last = contour.nodes[contour.nodes.length - 1];
          const canClose = penMode === "shape" && contour.nodes.length > 1 && length(subtract(first.point, p)) <= closeRadius;
          if (canClose) {
            contour.closed = true;
            baseOutlineRef.current = null;
            setDrawingContourId(null);
            clearSelection();
            commitOutline(activeChar, working);
            return;
          }

          // Affinity-style endpoint click: clicking the current endpoint converts
          // it to a corner in place instead of creating a coincident duplicate.
          if (length(subtract(last.point, p)) <= hitRadius) {
            last.type = "corner";
            last.handleIn = null;
            last.handleOut = null;
            baseOutlineRef.current = null;
            dragRef.current = null;
            setLiveOutline(working);
            return;
          }

          const node: PathNode = { id: shortId("node"), point: snapped, handleIn: null, handleOut: null, type: "corner" };
          contour.nodes.push(node);
          baseOutlineRef.current = cloneOutline(working);
          dragRef.current = { mode: "pen-place", contourId: contour.id, nodeId: node.id };
          setLiveOutline(working);
          return;
        }
      }

      // Clicking an endpoint of an existing open path converts it to Corner
      // without starting a new path or adding a duplicate point.
      for (const obj of working.objects) {
        for (const contour of obj.contours) {
          if (contour.closed || contour.nodes.length === 0) continue;
          const endpoints = contour.nodes.length === 1 ? [contour.nodes[0]] : [contour.nodes[0], contour.nodes[contour.nodes.length - 1]];
          const endpoint = endpoints.find((node) => length(subtract(node.point, p)) <= hitRadius);
          if (endpoint) {
            endpoint.type = "corner";
            endpoint.handleIn = null;
            endpoint.handleOut = null;
            commitOutline(activeChar, working);
            return;
          }
        }
      }

      // First node of a brand-new Pen/Line contour starts Symmetric (not
      // Corner) so it behaves consistently the moment a handle is dragged
      // out of it (see penPointerMove below, which already sets "symmetric"
      // on drag) — handles stay null/collapsed until actually dragged, so
      // this only changes the node's *type*, never its position or shape.
      const node: PathNode = { id: shortId("node"), point: snapped, handleIn: null, handleOut: null, type: "symmetric" };
      const contour: Contour = { id: shortId("contour"), nodes: [node], closed: false };
      const obj: VectorObject =
        penMode === "shape"
          ? { id: shortId("obj"), kind: "shape", contours: [contour] }
          : { id: shortId("obj"), kind: "line", contours: [contour], strokeWidth: lineWidth, cap: lineCap, join: "round" };
      working.objects.push(obj);
      baseOutlineRef.current = cloneOutline(working);
      dragRef.current = { mode: "pen-place", contourId: contour.id, nodeId: node.id };
      setDrawingContourId(contour.id);
      setLiveOutline(working);
    },
    [outline, drawingContourId, penMode, lineWidth, lineCap, closeRadius, hitRadius, maybeSnap, activeChar, commitOutline, setDrawingContourId, setLiveOutline, clearSelection]
  );

  const penPointerMove = useCallback(
    (p: Point, shiftKey: boolean) => {
      const drag = dragRef.current;
      const base = baseOutlineRef.current;
      if (!drag || drag.mode !== "pen-place" || !base) return;
      const working = cloneOutline(base);
      const node = findNode(working, drag.contourId, drag.nodeId);
      if (!node) return;
      const handlePoint = shiftKey ? snapAngle(node.point, p, 45) : p;
      if (length(subtract(handlePoint, node.point)) < 0.5) {
        node.handleIn = null; node.handleOut = null; node.type = "corner";
      } else {
        node.handleOut = handlePoint;
        node.handleIn = reflect(handlePoint, node.point);
        node.type = "symmetric";
      }
      setLiveOutline(working);
    },
    [setLiveOutline]
  );

  /* ----------------------------------------------------------- NODE */
  const nodePointerDown = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean, cmdKey: boolean) => {
      const hit = hitTestOutline(outline, p, hitRadius);

      if (hit && hit.part === "point") {
        const ref: NodeRef = { contourId: hit.contourId, nodeId: hit.nodeId };
        let nextSelection: NodeRef[];
        if (shiftKey) {
          toggleNodeSelection(ref);
          const already = selectedNodes.some((r) => refKey(r) === refKey(ref));
          nextSelection = already ? selectedNodes.filter((r) => refKey(r) !== refKey(ref)) : [...selectedNodes, ref];
        } else if (selectedNodes.some((r) => refKey(r) === refKey(ref))) {
          nextSelection = selectedNodes;
        } else {
          nextSelection = [ref];
          selectNodes(nextSelection);
        }
        baseOutlineRef.current = cloneOutline(outline);
        dragRef.current = { mode: "move-selection", refs: nextSelection, origin: p };
        return;
      }

      if (hit && (hit.part === "handleIn" || hit.part === "handleOut")) {
        const node = findNode(outline, hit.contourId, hit.nodeId);
        if (!node) return;
        setSelectedHandle({ contourId: hit.contourId, nodeId: hit.nodeId, part: hit.part } as HandleRef);
        baseOutlineRef.current = cloneOutline(outline);
        dragRef.current = { mode: "move-handle", contourId: hit.contourId, nodeId: hit.nodeId, part: hit.part, nodeType: node.type };
        return;
      }

      // Cmd/Ctrl + drag on a segment -> bend into a Bézier curve.
      const segHit = hitTestSegments(outline, p, segmentRadius * 1.6);
      if (cmdKey && segHit) {
        baseOutlineRef.current = cloneOutline(outline);
        dragRef.current = { mode: "curve", contourId: segHit.contourId, fromIndex: segHit.fromIndex, t: segHit.t };
        return;
      }
      // Alt+click a segment -> insert a node.
      if (altKey && segHit) {
        commitOutline(activeChar, insertNodeOnSegment(outline, { contourId: segHit.contourId, fromIndex: segHit.fromIndex }, segHit.t));
        return;
      }

      if (!shiftKey) clearSelection();
      dragRef.current = { mode: "marquee", origin: p, additive: shiftKey };
      const initialRect = { x: p.x, y: p.y, w: 0, h: 0 };
      marqueeRectRef.current = initialRect;
      setMarqueeRect(initialRect);
    },
    [outline, hitRadius, segmentRadius, selectedNodes, selectNodes, toggleNodeSelection, clearSelection, setSelectedHandle, activeChar, commitOutline]
  );

  const nodePointerMove = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === "marquee") {
        const rect = rectFrom(drag.origin, p);
        marqueeRectRef.current = rect;
        setMarqueeRect(rect);
        return;
      }
      const base = baseOutlineRef.current;
      if (!base) return;

      if (drag.mode === "move-selection") {
        const rawDelta = subtract(p, drag.origin);
        setLiveOutline(moveNodesBy(base, drag.refs, shiftKey ? axisLock(rawDelta) : rawDelta));
        return;
      }
      if (drag.mode === "curve") {
        setLiveOutline(bendSegment(base, { contourId: drag.contourId, fromIndex: drag.fromIndex }, drag.t, p));
        return;
      }
      if (drag.mode === "move-handle") {
        const working = cloneOutline(base);
        const node = findNode(working, drag.contourId, drag.nodeId);
        if (!node) return;
        const draggedPoint = shiftKey ? snapAngle(node.point, p, 45) : p;
        const breakConstraint = altKey;
        if (drag.part === "handleOut") {
          node.handleOut = draggedPoint;
          if (!breakConstraint) {
            if (drag.nodeType === "symmetric") node.handleIn = reflect(draggedPoint, node.point);
            else if (drag.nodeType === "smooth" && node.handleIn) node.handleIn = reflectDirection(draggedPoint, node.point, length(subtract(node.handleIn, node.point)));
          }
        } else {
          node.handleIn = draggedPoint;
          if (!breakConstraint) {
            if (drag.nodeType === "symmetric") node.handleOut = reflect(draggedPoint, node.point);
            else if (drag.nodeType === "smooth" && node.handleOut) node.handleOut = reflectDirection(draggedPoint, node.point, length(subtract(node.handleOut, node.point)));
          }
        }
        setLiveOutline(working);
      }
    },
    [setLiveOutline]
  );

  const finishMarquee = useCallback((drag: Extract<NonNullable<DragState>, { mode: "marquee" }>) => {
    const rect = marqueeRectRef.current;
    if (rect && (rect.w > 1 || rect.h > 1)) {
      const found: NodeRef[] = [];
      for (const obj of outline.objects) for (const contour of obj.contours) for (const node of contour.nodes) {
        if (pointInRect(node.point, rect)) found.push({ contourId: contour.id, nodeId: node.id });
      }
      selectNodes(found, drag.additive);
    }
    marqueeRectRef.current = null;
    setMarqueeRect(null);
  }, [outline, selectNodes]);

  const cycleNodeType = useCallback(
    (contourId: string, nodeId: string) => {
      const node = findNode(outline, contourId, nodeId);
      if (!node) return;
      const next = NODE_TYPE_ORDER[(NODE_TYPE_ORDER.indexOf(node.type) + 1) % NODE_TYPE_ORDER.length];
      commitOutline(activeChar, retypeNode(outline, contourId, nodeId, next));
    },
    [outline, activeChar, commitOutline]
  );

  const insertNodeAt = useCallback(
    (p: Point) => {
      const segHit = hitTestSegments(outline, p, segmentRadius * 1.8);
      if (segHit) commitOutline(activeChar, insertNodeOnSegment(outline, { contourId: segHit.contourId, fromIndex: segHit.fromIndex }, segHit.t));
    },
    [outline, segmentRadius, activeChar, commitOutline]
  );

  const deleteSelectedNodes = useCallback(() => {
    if (selectedNodes.length === 0) return;
    commitOutline(activeChar, deleteNodes(outline, selectedNodes));
    clearSelection();
  }, [selectedNodes, outline, activeChar, commitOutline, clearSelection]);

  const nudgeNodes = useCallback(
    (dx: number, dy: number) => {
      if (selectedNodes.length === 0) return;
      commitOutline(activeChar, moveNodesBy(outline, selectedNodes, { x: dx, y: dy }));
    },
    [selectedNodes, outline, activeChar, commitOutline]
  );

  /* --------------------------------------------------------- PUBLIC */
  const pointerDown = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean, cmdKey: boolean) => {
      if (tool === "pen") penPointerDown(p);
      else if (tool === "node") nodePointerDown(p, shiftKey, altKey, cmdKey);
    },
    [tool, penPointerDown, nodePointerDown]
  );
  const pointerMove = useCallback(
    (p: Point, shiftKey: boolean, altKey: boolean) => {
      if (tool === "pen") penPointerMove(p, shiftKey);
      else if (tool === "node") nodePointerMove(p, shiftKey, altKey);
    },
    [tool, penPointerMove, nodePointerMove]
  );
  const pointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "marquee") {
      finishMarquee(drag);
      dragRef.current = null;
      baseOutlineRef.current = null;
      return;
    }
    dragRef.current = null;
    if (drag.mode === "pen-place") return;
    if (liveOutline) commitOutline(activeChar, liveOutline);
    baseOutlineRef.current = null;
  }, [liveOutline, activeChar, commitOutline, finishMarquee]);

  const finishOpenContour = useCallback(() => {
    if (!drawingContourId) return;
    const latest = useAppStore.getState().liveOutline ?? outline;
    const working = cloneOutline(latest);
    // Auto Close Shape (Pen tool, Shape mode only — a "line" object is an
    // intentional open centerline per architecture and must never be
    // force-closed). Only points/handles already drawn are used; nothing is
    // added or moved, so the outline's actual node data is unchanged.
    if (penAutoClose && penMode === "shape") {
      const contour = findContour(working, drawingContourId);
      if (contour && contour.nodes.length > 2) contour.closed = true;
    }
    setDrawingContourId(null);
    dragRef.current = null;
    baseOutlineRef.current = null;
    commitOutline(activeChar, working);
  }, [drawingContourId, outline, activeChar, commitOutline, setDrawingContourId, penAutoClose, penMode]);

  const isCurrentEndpoint = useCallback((p: Point) => {
    if (!drawingContourId) return false;
    const contour = findContour(outline, drawingContourId);
    if (!contour || contour.nodes.length === 0) return false;
    const last = contour.nodes[contour.nodes.length - 1];
    return length(subtract(last.point, p)) <= hitRadius;
  }, [drawingContourId, outline, hitRadius]);

  return {
    outline, selectedNodes, selectedHandle, drawingContourId, marqueeRect,
    pointerDown, pointerMove, pointerUp, cycleNodeType, insertNodeAt,
    deleteSelectedNodes, nudgeNodes, finishOpenContour, isCurrentEndpoint,
    findObjectOfContour: (cid: string) => findObjectOfContour(outline, cid),
  };
}
