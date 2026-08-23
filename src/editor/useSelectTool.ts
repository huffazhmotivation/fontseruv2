import { useCallback, useRef, useState } from "react";
import type { GlyphOutline, Point } from "@/types/geometry";
import { useAppStore } from "@/glyph/store";
import { cloneOutline } from "./nodeOps";
import {
  objectsBounds,
  pointHitsObject,
  scaleObject,
  translateObject,
  rotateObject,
  skewObject,
  boundsIntersectRect,
  objectBounds,
  cloneObjectWithNewIds,
  type Bounds,
} from "./objectOps";
import { subtract } from "@/utils/geometry";
import { shortId } from "@/utils/id";

export type ResizeHandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type SkewHandleId = "skew-x-top" | "skew-x-bottom" | "skew-y-left" | "skew-y-right";
export type HandleId = ResizeHandleId | SkewHandleId | "rotate";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Handle centers in font-unit space (Y-up). rotateOffset is in font units. */
export function handlePositions(b: Bounds, rotateOffset: number, skewOffset = rotateOffset * 0.56): Record<HandleId, Point> {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return {
    nw: { x: b.minX, y: b.maxY },
    n: { x: cx, y: b.maxY },
    ne: { x: b.maxX, y: b.maxY },
    e: { x: b.maxX, y: cy },
    se: { x: b.maxX, y: b.minY },
    s: { x: cx, y: b.minY },
    sw: { x: b.minX, y: b.minY },
    w: { x: b.minX, y: cy },
    rotate: { x: cx, y: b.maxY + rotateOffset },
    "skew-x-top": { x: cx, y: b.maxY + skewOffset },
    "skew-x-bottom": { x: cx, y: b.minY - skewOffset },
    "skew-y-left": { x: b.minX - skewOffset, y: cy },
    "skew-y-right": { x: b.maxX + skewOffset, y: cy },
  };
}

function anchorForHandle(b: Bounds, h: ResizeHandleId): Point {
  switch (h) {
    case "nw": return { x: b.maxX, y: b.minY };
    case "ne": return { x: b.minX, y: b.minY };
    case "se": return { x: b.minX, y: b.maxY };
    case "sw": return { x: b.maxX, y: b.maxY };
    case "n": return { x: (b.minX + b.maxX) / 2, y: b.minY };
    case "s": return { x: (b.minX + b.maxX) / 2, y: b.maxY };
    case "e": return { x: b.minX, y: (b.minY + b.maxY) / 2 };
    case "w": return { x: b.maxX, y: (b.minY + b.maxY) / 2 };
    default: return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }
}

type DragState =
  | { mode: "move"; origin: Point; ids: string[] }
  | { mode: "resize"; handle: ResizeHandleId; anchor: Point; base: Bounds }
  | { mode: "rotate"; center: Point; startAngle: number }
  | { mode: "skew"; handle: SkewHandleId; origin: Point; anchor: Point; extent: number; baseShear: number }
  | { mode: "marquee"; origin: Point; additive: boolean }
  | null;

function isResizeHandle(handle: HandleId): handle is ResizeHandleId {
  return ["nw", "n", "ne", "e", "se", "s", "sw", "w"].includes(handle);
}

function isSkewHandle(handle: HandleId): handle is SkewHandleId {
  return handle.startsWith("skew-");
}

function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}


/** A group is a selection unit without becoming a new geometry container. */
function selectionUnitIds(outline: GlyphOutline, objectId: string): string[] {
  const hit = outline.objects.find((o) => o.id === objectId);
  if (!hit?.groupId) return [objectId];
  return outline.objects.filter((o) => o.groupId === hit.groupId).map((o) => o.id);
}

function expandGroupsInSelection(outline: GlyphOutline, ids: string[]): string[] {
  const out = new Set(ids);
  for (const id of ids) {
    for (const member of selectionUnitIds(outline, id)) out.add(member);
  }
  return [...out];
}

/** hitScale = font units per screen pixel (1/scale); used for hit tolerances. */
export function useSelectTool(hitScale: number) {
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const liveOutline = useAppStore((s) => s.liveOutline);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const selectObjects = useAppStore((s) => s.selectObjects);
  const clearObjectSelection = useAppStore((s) => s.clearObjectSelection);
  const commitOutline = useAppStore((s) => s.commitOutline);
  const setLiveOutline = useAppStore((s) => s.setLiveOutline);
  const setSelectionSkewState = useAppStore((s) => s.setSelectionSkewState);
  const selectionSkewAngle = useAppStore((s) => s.selectionSkewAngle);
  const selectionSkewHandle = useAppStore((s) => s.selectionSkewHandle);
  const strokeWidthLocked = useAppStore((s) => s.strokeWidthLocked);
  const sketchMode = useAppStore((s) => s.sketchMode);

  const dragRef = useRef<DragState>(null);
  const baseRef = useRef<GlyphOutline | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  const [hoverHandle, setHoverHandle] = useState<HandleId | null>(null);

  const outline: GlyphOutline = liveOutline ?? glyph?.outline ?? { objects: [] };
  const bounds = objectsBounds(outline, selectedObjectIds);
  const handleTol = 9 * hitScale;
  const rotateOffset = 26 * hitScale;
  const skewOffset = 14 * hitScale;

  const findHandle = useCallback(
    (p: Point): HandleId | null => {
      if (!bounds) return null;
      const hp = handlePositions(bounds, rotateOffset, skewOffset);
      let best: HandleId | null = null;
      let bestD = handleTol;
      (Object.keys(hp) as HandleId[]).forEach((id) => {
        const d = Math.hypot(hp[id].x - p.x, hp[id].y - p.y);
        if (d <= bestD) { best = id; bestD = d; }
      });
      return best;
    },
    [bounds, handleTol, rotateOffset, skewOffset]
  );

  const pointerDown = useCallback(
    (p: Point, shiftKey: boolean, metaKey = false) => {
      // 1. handle on the current selection?
      const handle = findHandle(p);
      if (handle && bounds) {
        baseRef.current = cloneOutline(outline);
        if (handle === "rotate") {
          const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
          dragRef.current = { mode: "rotate", center, startAngle: Math.atan2(p.y - center.y, p.x - center.x) };
        } else if (isSkewHandle(handle)) {
          const horizontal = handle === "skew-x-top" || handle === "skew-x-bottom";
          const topOrRight = handle === "skew-x-top" || handle === "skew-y-right";
          const anchor = horizontal
            ? { x: 0, y: topOrRight ? bounds.minY : bounds.maxY }
            : { x: topOrRight ? bounds.minX : bounds.maxX, y: 0 };
          const extent = horizontal
            ? ((topOrRight ? bounds.maxY : bounds.minY) - anchor.y || 1)
            : ((topOrRight ? bounds.maxX : bounds.minX) - anchor.x || 1);
          const sameSkewAxis = selectionSkewHandle === handle;
          const baseShear = sameSkewAxis ? Math.tan((selectionSkewAngle * Math.PI) / 180) : 0;
          dragRef.current = { mode: "skew", handle, origin: p, anchor, extent, baseShear };
          setSelectionSkewState(sameSkewAxis ? selectionSkewAngle : 0, handle);
        } else if (isResizeHandle(handle)) {
          dragRef.current = { mode: "resize", handle, anchor: anchorForHandle(bounds, handle), base: bounds };
        }
        return;
      }

      // 2. clicked an object?
      const tol = 6 * hitScale;
      let hitId: string | null = null;
      for (let i = outline.objects.length - 1; i >= 0; i--) {
        if (pointHitsObject(outline.objects[i], p, tol)) { hitId = outline.objects[i].id; break; }
      }
      if (hitId) {
        const unitIds = selectionUnitIds(outline, hitId);

        // Cmd/Ctrl + click-drag on an object: stamp a copy in place and drag
        // that copy, leaving the original untouched — mirrors the classic
        // "modifier + drag to duplicate" gesture from vector editors.
        if (metaKey) {
          const groupMap = new Map<string, string>();
          const duplicates = outline.objects
            .filter((o) => unitIds.includes(o.id))
            .map((o) => {
              const clone = cloneObjectWithNewIds(o);
              if (o.groupId) {
                let nextGroup = groupMap.get(o.groupId);
                if (!nextGroup) {
                  nextGroup = shortId("group");
                  groupMap.set(o.groupId, nextGroup);
                }
                clone.groupId = nextGroup;
              } else {
                delete clone.groupId;
              }
              return clone;
            });
          const withDuplicates: GlyphOutline = { objects: [...outline.objects, ...duplicates] };
          baseRef.current = cloneOutline(withDuplicates);
          setLiveOutline(withDuplicates);
          const dupIds = duplicates.map((d) => d.id);
          selectObjects(dupIds);
          dragRef.current = { mode: "move", origin: p, ids: dupIds };
          return;
        }

        let dragIds = unitIds;
        if (shiftKey) {
          const allSelected = unitIds.every((id) => selectedObjectIds.includes(id));
          selectObjects(unitIds, true);
          dragIds = allSelected
            ? selectedObjectIds.filter((id) => !unitIds.includes(id))
            : [...new Set([...selectedObjectIds, ...unitIds])];
        } else if (!unitIds.every((id) => selectedObjectIds.includes(id))) {
          selectObjects(unitIds);
        } else {
          dragIds = selectedObjectIds;
        }
        baseRef.current = cloneOutline(outline);
        if (dragIds.length > 0) dragRef.current = { mode: "move", origin: p, ids: dragIds };
        return;
      }

      // 3. empty space -> marquee
      if (!shiftKey) clearObjectSelection();
      dragRef.current = { mode: "marquee", origin: p, additive: shiftKey };
      setMarqueeRect({ x: p.x, y: p.y, w: 0, h: 0 });
    },
    [findHandle, bounds, outline, hitScale, selectedObjectIds, selectObjects, clearObjectSelection, setSelectionSkewState, selectionSkewAngle, selectionSkewHandle]
  );

  const pointerMove = useCallback(
    (p: Point, shiftKey: boolean, pointerType?: string) => {
      const drag = dragRef.current;
      if (!drag) {
        setHoverHandle(findHandle(p));
        return;
      }
      if (drag.mode === "marquee") {
        setMarqueeRect(rectFrom(drag.origin, p));
        return;
      }
      const base = baseRef.current;
      if (!base) return;

      if (drag.mode === "move") {
        let d = subtract(p, drag.origin);
        if (shiftKey) d = Math.abs(d.x) >= Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
        const objects = base.objects.map((o) =>
          drag.ids.includes(o.id) ? translateObject(o, d.x, d.y) : o
        );
        setLiveOutline({ objects });
        return;
      }

      if (drag.mode === "resize") {
        const b = drag.base;
        const anchor = drag.anchor;
        const horiz = drag.handle !== "n" && drag.handle !== "s";
        const vert = drag.handle !== "e" && drag.handle !== "w";
        const w0 = b.maxX - b.minX || 1;
        const h0 = b.maxY - b.minY || 1;
        let sx = horiz ? (p.x - anchor.x) / (handleSign(drag.handle, "x") * w0 || 1) : 1;
        let sy = vert ? (p.y - anchor.y) / (handleSign(drag.handle, "y") * h0 || 1) : 1;
        if (!horiz) sx = 1;
        if (!vert) sy = 1;
        // Desktop: Shift locks proportions. Sketch Mode + touch (1-finger
        // drag) has no Shift key available, so it locks automatically —
        // scoped to this resize branch only, so pan/move/skew gestures are
        // completely unaffected.
        const lockAspect = shiftKey || (sketchMode && pointerType === "touch");
        if (lockAspect && horiz && vert) { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx) * s; sy = Math.sign(sy) * s; }
        sx = clampScale(sx);
        sy = clampScale(sy);
        const objects = base.objects.map((o) =>
          selectedObjectIds.includes(o.id) ? scaleObject(o, anchor, sx, sy, strokeWidthLocked) : o
        );
        setLiveOutline({ objects });
        return;
      }

      if (drag.mode === "skew") {
        const horizontal = drag.handle === "skew-x-top" || drag.handle === "skew-x-bottom";
        let amount = horizontal ? (p.x - drag.origin.x) / drag.extent : (p.y - drag.origin.y) / drag.extent;
        // Shift gives a restrained 15°-style step, useful for intentional italic/oblique edits.
        if (shiftKey) {
          const step = Math.tan(Math.PI / 12);
          amount = Math.round(amount / step) * step;
        }
        // Preserve the existing per-drag safety clamp.
        amount = Math.max(-3, Math.min(3, amount));
        const totalShear = drag.baseShear + amount;
        setSelectionSkewState((Math.atan(totalShear) * 180) / Math.PI, drag.handle);
        const objects = base.objects.map((o) =>
          selectedObjectIds.includes(o.id)
            ? skewObject(o, drag.anchor, horizontal ? amount : 0, horizontal ? 0 : amount)
            : o
        );
        setLiveOutline({ objects });
        return;
      }

      if (drag.mode === "rotate") {
        let angle = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) - drag.startAngle;
        if (shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        const objects = base.objects.map((o) =>
          selectedObjectIds.includes(o.id) ? rotateObject(o, drag.center, angle) : o
        );
        setLiveOutline({ objects });
      }
    },
    [findHandle, selectedObjectIds, setLiveOutline, setSelectionSkewState, strokeWidthLocked, sketchMode]
  );

  const pointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.mode === "marquee") {
      if (marqueeRect && (marqueeRect.w > 2 || marqueeRect.h > 2)) {
        const found: string[] = [];
        for (const o of outline.objects) {
          if (boundsIntersectRect(objectBounds(o), marqueeRect.x, marqueeRect.y, marqueeRect.w, marqueeRect.h)) found.push(o.id);
        }
        selectObjects(expandGroupsInSelection(outline, found), drag.additive);
      }
      setMarqueeRect(null);
      return;
    }
    if (liveOutline) commitOutline(activeChar, liveOutline);
    baseRef.current = null;
  }, [marqueeRect, outline, selectObjects, liveOutline, activeChar, commitOutline]);

  return { pointerDown, pointerMove, pointerUp, bounds, marqueeRect, hoverHandle, rotateOffset, skewOffset };
}

function handleSign(h: ResizeHandleId, axis: "x" | "y"): number {
  if (axis === "x") return h.includes("e") ? 1 : h.includes("w") ? -1 : 1;
  return h.includes("n") ? 1 : h.includes("s") ? -1 : 1;
}
function clampScale(s: number): number {
  if (!isFinite(s)) return 1;
  if (Math.abs(s) < 0.02) return 0.02 * (s < 0 ? -1 : 1);
  return s;
}
