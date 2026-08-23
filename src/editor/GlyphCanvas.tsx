import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { useAppStore, type GlyphMetricKey } from "@/glyph/store";
import { useGlyphEditor } from "./useGlyphEditor";
import { useBrushTool } from "./useBrushTool";
import { useSelectTool, handlePositions, type HandleId, type SkewHandleId } from "./useSelectTool";
import { useSketchGestures } from "./useSketchGestures";
import { clientToFontPoint } from "./coords";
import { objectFillPath, objectStrokePath, toSvgPoint, contourToPath } from "./pathBuilder";
import { outlineBounds, pointHitsObject } from "./objectOps";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { GhostGlyph } from "./GhostGlyph";
import type { NodeType, Point, VectorObject } from "@/types/geometry";
import type { FontStyle, Glyph, GlyphMap } from "@/types/glyph";

const FAMILY_GHOST_ORDER: Record<FontStyle, readonly [FontStyle, FontStyle]> = {
  regular: ["bold", "italic"],
  bold: ["regular", "italic"],
  italic: ["regular", "bold"],
};

function matchingFamilyGlyph(map: GlyphMap, activeGlyph: Glyph, activeChar: string): Glyph | undefined {
  const exact = map[activeChar];
  if (exact) return exact;

  const activeCodes = new Set([activeGlyph.unicode, ...(activeGlyph.unicodes ?? [])]);
  return Object.values(map).find((candidate) => {
    if (activeCodes.has(candidate.unicode)) return true;
    if (candidate.unicodes?.some((code) => activeCodes.has(code))) return true;
    return candidate.char === activeGlyph.char;
  });
}

export function GlyphCanvas() {
  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const tool = useAppStore((s) => s.tool);
  const sketchMode = useAppStore((s) => s.sketchMode);
  const zoom = useAppStore((s) => s.zoom);
  const pan = useAppStore((s) => s.pan);
  const setPan = useAppStore((s) => s.setPan);
  const setZoom = useAppStore((s) => s.setZoom);
  const showGrid = useAppStore((s) => s.showGrid);
  const gridSize = useAppStore((s) => s.gridSize);
  const showGuides = useAppStore((s) => s.showGuides);
  const metrics = useAppStore((s) => s.metrics);
  const beginMetricDrag = useAppStore((s) => s.beginMetricDrag);
  const setFontMetricLive = useAppStore((s) => s.setFontMetricLive);
  const endMetricDrag = useAppStore((s) => s.endMetricDrag);
  const setMetricFocus = useAppStore((s) => s.setMetricFocus);
  const beginGlyphMetricDrag = useAppStore((s) => s.beginGlyphMetricDrag);
  const setGlyphMetricLive = useAppStore((s) => s.setGlyphMetricLive);
  const endGlyphMetricDrag = useAppStore((s) => s.endGlyphMetricDrag);
  const setGlyphMetricFocus = useAppStore((s) => s.setGlyphMetricFocus);
  const glyph = useAppStore((s) => s.glyphs[s.activeChar]);
  const activeChar = useAppStore((s) => s.activeChar);
  const ghost = useAppStore((s) => s.ghost);
  const glyphsByStyle = useAppStore((s) => s.glyphsByStyle);
  const fontStyle = useAppStore((s) => s.fontStyle);
  const brush = useAppStore((s) => s.brush);
  const brushCap = useAppStore((s) => s.brushCap);
  const fitNonce = useAppStore((s) => s.fitNonce);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const setTool = useAppStore((s) => s.setTool);
  const selectNodes = useAppStore((s) => s.selectNodes);
  const penAutoCloseShape = useAppStore((s) => s.penAutoClose);

  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Point | null>(null);
  const panDragRef = useRef<{ startClient: Point; startPan: Point } | null>(null);
  type MetricGuideKey = "ascender" | "capHeight" | "xHeight" | "baseline" | "descender";
  const metricDragRef = useRef<{ key: MetricGuideKey; startClientY: number; startValue: number; startScale: number } | null>(null);
  const [activeMetricGuide, setActiveMetricGuide] = useState<MetricGuideKey | null>(null);
  const glyphMetricDragRef = useRef<{ key: GlyphMetricKey; startClientX: number; startValue: number; startScale: number } | null>(null);
  const [activeGlyphMetricGuide, setActiveGlyphMetricGuide] = useState<GlyphMetricKey | null>(null);
  const spacePanRef = useRef(false);

  const { unitsPerEm: upm, ascender, baseline, descender, capHeight, xHeight } = metrics;
  const totalH = ascender - descender;
  const [leftGhostStyle, rightGhostStyle] = FAMILY_GHOST_ORDER[fontStyle];
  const leftFamilyGlyph = glyph
    ? matchingFamilyGlyph(glyphsByStyle[leftGhostStyle], glyph, activeChar)
    : undefined;
  const rightFamilyGlyph = glyph
    ? matchingFamilyGlyph(glyphsByStyle[rightGhostStyle], glyph, activeChar)
    : undefined;

  const baseFit = viewSize.w && viewSize.h ? 0.62 * Math.min(viewSize.w / upm, viewSize.h / totalH) : 0.35;
  const scale = baseFit * (zoom / 100);
  const vbW = viewSize.w ? viewSize.w / scale : upm;
  const vbH = viewSize.h ? viewSize.h / scale : totalH;
  const vbX = pan.x - vbW / 2;
  const vbY = pan.y - vbH / 2;
  const sc = scale || 0.35;
  const hitScale = 1 / sc;

  const editor = useGlyphEditor(hitScale);
  const brushTool = useBrushTool();
  const selectTool = useSelectTool(hitScale);

  // Track container size for the viewBox math.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => setViewSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const getFontPoint = useCallback(
    (e: { clientX: number; clientY: number }): Point | null =>
      svgRef.current ? clientToFontPoint(svgRef.current, e.clientX, e.clientY, ascender) : null,
    [ascender]
  );

  const applyZoomAt = useCallback(
    (newZoom: number, clientX: number, clientY: number) => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return setZoom(newZoom);
      const fx = (clientX - rect.left) / rect.width;
      const fy = (clientY - rect.top) / rect.height;
      const Px = vbX + fx * vbW;
      const Py = vbY + fy * vbH;
      const clamped = Math.min(800, Math.max(20, newZoom));
      const nScale = baseFit * (clamped / 100);
      const nvbW = rect.width / nScale;
      const nvbH = rect.height / nScale;
      setZoom(clamped);
      setPan({ x: Px + (0.5 - fx) * nvbW, y: Py + (0.5 - fy) * nvbH });
    },
    [vbX, vbY, vbW, vbH, baseFit, setZoom, setPan]
  );

  // Native, non-passive wheel: plain wheel (any direction, incl. Ctrl/Cmd or
  // trackpad pinch) zooms toward the cursor; hold Shift to pan instead.
  // Always preventDefault so the page never scrolls.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        setPan({ x: pan.x + dx / sc, y: pan.y });
        return;
      }
      applyZoomAt(zoom * Math.exp(-e.deltaY * 0.0018), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, pan, sc, applyZoomAt, setPan]);

  // Fit: recompute zoom + pan so the glyph (or the em box) fills the view.
  useEffect(() => {
    if (fitNonce === 0 || !viewSize.w || !viewSize.h) return;
    const g = useAppStore.getState().glyphs[activeChar];
    const b = g ? outlineBounds(g.outline) : null;
    const box = b ?? { minX: 0, maxX: upm, minY: descender, maxY: ascender };
    const padU = upm * 0.12;
    const w = box.maxX - box.minX + padU * 2 || upm;
    const h = box.maxY - box.minY + padU * 2 || totalH;
    const targetScale = 0.95 * Math.min(viewSize.w / w, viewSize.h / h);
    const newZoom = Math.min(800, Math.max(20, (targetScale / baseFit) * 100));
    setZoom(newZoom);
    setPan({ x: (box.minX + box.maxX) / 2, y: ascender - (box.minY + box.maxY) / 2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce]);

  const usingHandPan = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => tool === "hand" || spacePanRef.current || e.button === 1,
    [tool]
  );

  // Multi-touch extras layered on top of the existing pointer pipeline:
  // pinch-to-zoom, 2/3-finger tap for undo/redo, and simple palm rejection.
  // Enabled in every mode (including Normal Mode) so 2/3-finger tap
  // undo/redo always works; single-finger draw/pan/tool handling below is
  // completely untouched since the hook only intercepts 2+ simultaneous
  // touch pointers and always returns false for mouse/pen/single-touch.
  const getZoomNow = useCallback(() => useAppStore.getState().zoom, []);
  const cancelActiveInteraction = useCallback(() => {
    brushTool.cancel();
    if (tool === "select") selectTool.pointerUp();
    else if (tool !== "brush") editor.pointerUp();
  }, [brushTool, selectTool, editor, tool]);
  // 2-finger drag pan: reuses the exact same hand-pan math as the "hand"
  // tool's single-pointer drag (panDragRef above), just driven by the
  // touch midpoint's frame-to-frame delta instead of a single pointer.
  const sketchPanBy = useCallback(
    (dxClient: number, dyClient: number) => {
      const store = useAppStore.getState();
      store.setPan({ x: store.pan.x - dxClient / sc, y: store.pan.y - dyClient / sc });
    },
    [sc]
  );
  const sketchGestures = useSketchGestures({
    enabled: true,
    applyZoomAt,
    getZoom: getZoomNow,
    onUndo: () => useAppStore.getState().undo(),
    onRedo: () => useAppStore.getState().redo(),
    onCancelActive: cancelActiveInteraction,
    onPanBy: sketchPanBy,
  });

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (sketchGestures.handlePointerDown(e)) return;
      const p = getFontPoint(e);
      if (!p) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      if (usingHandPan(e)) {
        panDragRef.current = { startClient: { x: e.clientX, y: e.clientY }, startPan: pan };
        return;
      }
      if (tool === "zoom") return applyZoomAt(zoom * (e.shiftKey ? 0.8 : 1.25), e.clientX, e.clientY);
      if (tool === "brush") return brushTool.pointerDown(p, e);
      if (tool === "select") return selectTool.pointerDown(p, e.shiftKey, e.metaKey || e.ctrlKey);
      editor.pointerDown(p, e.shiftKey, e.altKey, e.metaKey || e.ctrlKey);
    },
    [getFontPoint, tool, editor, brushTool, selectTool, pan, zoom, applyZoomAt, usingHandPan, sketchGestures]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (sketchGestures.handlePointerMove(e)) return;
      const p = getFontPoint(e);
      if (!p) return;
      setHover(p);
      if (panDragRef.current) {
        setPan({
          x: panDragRef.current.startPan.x - (e.clientX - panDragRef.current.startClient.x) / sc,
          y: panDragRef.current.startPan.y - (e.clientY - panDragRef.current.startClient.y) / sc,
        });
        return;
      }
      if (tool === "brush") return brushTool.pointerMove(p, e);
      if (tool === "select") return selectTool.pointerMove(p, e.shiftKey, e.pointerType);
      editor.pointerMove(p, e.shiftKey, e.altKey);
    },
    [getFontPoint, tool, editor, brushTool, selectTool, sc, setPan, sketchGestures]
  );

  const onPointerUp = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    sketchGestures.handlePointerUp(e);
    panDragRef.current = null;
    if (tool === "brush") return brushTool.pointerUp();
    if (tool === "select") return selectTool.pointerUp();
    editor.pointerUp();
  }, [editor, brushTool, selectTool, tool, sketchGestures]);

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const p = getFontPoint(e);
      if (!p) return;

      if (tool === "pen") {
        // The two underlying single-clicks are harmless because endpoint clicks
        // never add a duplicate node. The double-click then commits the path.
        if (editor.isCurrentEndpoint(p)) editor.finishOpenContour();
        return;
      }

      if (tool === "select") {
        // Double-clicking an object jumps straight into editing its nodes —
        // matching the "double-click to enter node mode" behavior of
        // professional vector editors.
        const tol = 6 * hitScale;
        for (let i = editor.outline.objects.length - 1; i >= 0; i--) {
          const obj = editor.outline.objects[i];
          if (!pointHitsObject(obj, p, tol)) continue;
          const refs = obj.contours.flatMap((c) => c.nodes.map((n) => ({ contourId: c.id, nodeId: n.id })));
          setTool("node");
          selectNodes(refs);
          return;
        }
        return;
      }

      if (tool !== "node") return;
      const hitR = 12 * hitScale;
      const hit = editor.outline.objects.some((o) =>
        o.contours.some((c) => c.nodes.some((n) => Math.hypot(n.point.x - p.x, n.point.y - p.y) <= hitR))
      );
      // double-click a node -> cycle type; otherwise a segment -> insert a node
      if (hit) {
        for (const o of editor.outline.objects)
          for (const c of o.contours)
            for (const n of c.nodes)
              if (Math.hypot(n.point.x - p.x, n.point.y - p.y) <= hitR) return editor.cycleNodeType(c.id, n.id);
      }
      editor.insertNodeAt(p);
    },
    [tool, getFontPoint, editor, hitScale, setTool, selectNodes]
  );

  useEffect(() => {
    function onWindowPointerUp(e: PointerEvent) {
      sketchGestures.handlePointerUp(e);
      panDragRef.current = null;
      if (tool === "brush") brushTool.pointerUp();
      else if (tool === "select") selectTool.pointerUp();
      else editor.pointerUp();
    }
    // pointercancel only needs to keep Sketch Mode's touch bookkeeping tidy
    // (e.g. the OS interrupts a touch gesture); it must NOT run the same
    // commit path as pointerup, so normal-mode tool behavior is unchanged.
    function onWindowPointerCancel(e: PointerEvent) {
      sketchGestures.handlePointerUp(e);
    }
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("pointercancel", onWindowPointerCancel);
    };
  }, [editor, brushTool, selectTool, tool, sketchGestures]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "Space") spacePanRef.current = true;
      if (e.key === "Escape") { editor.finishOpenContour(); brushTool.cancel(); }
      if (tool === "node") {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); editor.deleteSelectedNodes(); }
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft") { e.preventDefault(); editor.nudgeNodes(-step, 0); }
        if (e.key === "ArrowRight") { e.preventDefault(); editor.nudgeNodes(step, 0); }
        if (e.key === "ArrowUp") { e.preventDefault(); editor.nudgeNodes(0, step); }
        if (e.key === "ArrowDown") { e.preventDefault(); editor.nudgeNodes(0, -step); }
      }
    }
    function onKeyUp(e: KeyboardEvent) { if (e.code === "Space") spacePanRef.current = false; }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [editor, brushTool, tool]);

  const beginGuideDrag = useCallback(
    (key: MetricGuideKey, e: ReactPointerEvent<SVGLineElement>) => {
      if (tool !== "home" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      beginMetricDrag();
      metricDragRef.current = {
        key,
        startClientY: e.clientY,
        startValue: metrics[key],
        startScale: sc,
      };
      setActiveMetricGuide(key);
    },
    [tool, beginMetricDrag, metrics, sc]
  );

  const moveGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGLineElement>) => {
      const drag = metricDragRef.current;
      if (!drag || tool !== "home") return;
      e.preventDefault();
      e.stopPropagation();
      const deltaUnits = -(e.clientY - drag.startClientY) / Math.max(drag.startScale, 0.0001);
      setFontMetricLive(drag.key, drag.startValue + deltaUnits);
    },
    [tool, setFontMetricLive]
  );

  const finishGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGLineElement>) => {
      if (!metricDragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      metricDragRef.current = null;
      endMetricDrag();
      setActiveMetricGuide(null);
    },
    [endMetricDrag]
  );

  const focusGuideMetric = useCallback(
    (key: MetricGuideKey, e: ReactMouseEvent<SVGLineElement>) => {
      if (tool !== "home") return;
      e.preventDefault();
      e.stopPropagation();
      setMetricFocus(key);
    },
    [tool, setMetricFocus]
  );

  const beginGlyphGuideDrag = useCallback(
    (key: GlyphMetricKey, e: ReactPointerEvent<SVGElement>) => {
      if (tool !== "home" || e.button !== 0 || !glyph) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      beginGlyphMetricDrag();
      glyphMetricDragRef.current = {
        key,
        startClientX: e.clientX,
        startValue: glyph[key],
        startScale: sc,
      };
      setActiveGlyphMetricGuide(key);
    },
    [tool, glyph, beginGlyphMetricDrag, sc]
  );

  const moveGlyphGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGElement>) => {
      const drag = glyphMetricDragRef.current;
      if (!drag || tool !== "home" || !glyph) return;
      e.preventDefault();
      e.stopPropagation();
      const deltaUnits = (e.clientX - drag.startClientX) / Math.max(drag.startScale, 0.0001);
      setGlyphMetricLive(activeChar, drag.key, drag.startValue + deltaUnits);
    },
    [tool, glyph, activeChar, setGlyphMetricLive]
  );

  const finishGlyphGuideDrag = useCallback(
    (e: ReactPointerEvent<SVGElement>) => {
      if (!glyphMetricDragRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      glyphMetricDragRef.current = null;
      endGlyphMetricDrag();
      setActiveGlyphMetricGuide(null);
    },
    [endGlyphMetricDrag]
  );

  const focusGlyphGuideMetric = useCallback(
    (key: GlyphMetricKey, e: ReactMouseEvent<SVGElement>) => {
      if (tool !== "home") return;
      e.preventDefault();
      e.stopPropagation();
      setGlyphMetricFocus(key);
    },
    [tool, setGlyphMetricFocus]
  );

  const metricGuides: { key: MetricGuideKey; label: string; value: number; className: string }[] = [
    { key: "ascender", label: "Ascender", value: ascender, className: "metric-ascender" },
    { key: "capHeight", label: "Cap Height", value: capHeight, className: "metric-cap" },
    { key: "xHeight", label: "x-Height", value: xHeight, className: "metric-xheight" },
    { key: "baseline", label: "Baseline", value: baseline, className: "metric-baseline" },
    { key: "descender", label: "Descender", value: descender, className: "metric-descender" },
  ];

  const toY = (val: number) => ascender - val;
  const objects = editor.outline.objects;

  const selBounds = tool === "select" ? selectTool.bounds : null;
  const handlePts = useMemo(
    () => (selBounds ? handlePositions(selBounds, selectTool.rotateOffset, selectTool.skewOffset) : null),
    [selBounds, selectTool.rotateOffset, selectTool.skewOffset]
  );

  const cursorClass =
    tool === "pen" ? "cursor-pen"
    : tool === "node" ? "cursor-node"
    : tool === "hand" ? "cursor-hand"
    : tool === "zoom" ? "cursor-zoom"
    : tool === "brush" ? "cursor-brush"
    : tool === "select" && selectTool.hoverHandle ? handleCursor(selectTool.hoverHandle)
    : "cursor-select";

  // Grid and metrics belong only to the editable center canvas. Ghost lanes
  // intentionally contain glyph shapes only.
  const gridMinX = 0;
  const gridMaxX = upm;

  return (
    <div className="fm-canvas-frame" ref={frameRef}>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        className={cursorClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        style={{ touchAction: "none" }}
      >
        <style>{`
          .cursor-pen { cursor: crosshair; } .cursor-node { cursor: default; }
          .cursor-hand { cursor: grab; } .cursor-zoom { cursor: zoom-in; }
          .cursor-brush { cursor: crosshair; } .cursor-select { cursor: default; }
          .cursor-nwse { cursor: nwse-resize; } .cursor-nesw { cursor: nesw-resize; }
          .cursor-ns { cursor: ns-resize; } .cursor-ew { cursor: ew-resize; } .cursor-rot { cursor: crosshair; }
          .cursor-skew-x { cursor: ew-resize; } .cursor-skew-y { cursor: ns-resize; }
          .grid-line { stroke: var(--grid); stroke-width: ${1 / sc}; }
          .grid-major { stroke: var(--grid-major); stroke-width: ${1 / sc}; }
          .guide-line { stroke: var(--guide); stroke-width: ${1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; }
          .metric-guide { opacity: 0.72; transition: opacity 120ms ease; }
          .metric-guide .metric-guide-line { stroke-width: ${1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; }
          .metric-guide.metric-ascender .metric-guide-line { stroke: var(--guide-2); stroke-width: ${1.3 / sc}; }
          .metric-guide.metric-cap .metric-guide-line { stroke: var(--guide); stroke-width: ${1.3 / sc}; }
          .metric-guide.metric-xheight .metric-guide-line { stroke: var(--guide); stroke-width: ${1.3 / sc}; stroke-dasharray: ${2 / sc} ${4 / sc}; }
          .metric-guide.metric-baseline .metric-guide-line { stroke: var(--accent); stroke-width: ${1.35 / sc}; }
          .metric-guide.metric-descender .metric-guide-line { stroke: var(--guide-2); }
          /* Ascender / Cap Height / x-Height read as too faint at a glance —
             nudge their contrast up a bit while keeping them subtle and
             leaving position, values, and behavior untouched. */
          .metric-guide.metric-ascender, .metric-guide.metric-cap, .metric-guide.metric-xheight { opacity: 0.9; }
          .metric-guide:hover, .metric-guide.active { opacity: 1; }
          .metric-guide:hover .metric-guide-line, .metric-guide.active .metric-guide-line { stroke-width: ${1.8 / sc}; }
          .metric-guide-hit { stroke: transparent; stroke-width: ${12 / sc}; cursor: ns-resize; pointer-events: stroke; }
          .metric-guide.locked { opacity: 0.52; }
          .metric-guide.locked .metric-guide-hit { pointer-events: none; cursor: default; }
          .metric-guide-value-bg { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1 / sc}; opacity: 0.96; }
          .metric-guide-value { fill: var(--text); font-size: ${11 / sc}px; font-family: var(--mono); }
          .lsb-line, .rsb-line { stroke: var(--guide-2); stroke-width: ${1 / sc}; opacity: 0.7; }
          .glyph-metric-guide-line { stroke: var(--guide-2); stroke-width: ${1 / sc}; stroke-dasharray: ${5 / sc} ${5 / sc}; opacity: 0.78; }
          .glyph-metric-guide-line.advance { stroke: var(--accent); stroke-width: ${1.35 / sc}; }
          .glyph-metric-handle { fill: var(--canvas); stroke: var(--guide-2); stroke-width: ${1 / sc}; cursor: ew-resize; }
          .glyph-metric-handle.locked { opacity: 0.55; pointer-events: none; cursor: default; }
          .glyph-metric-handle.advance { stroke: var(--accent); }
          .glyph-metric-handle.active { fill: var(--accent-soft); stroke: var(--accent); }
          .glyph-metric-label { fill: var(--text); font-size: ${10.5 / sc}px; font-family: var(--mono); pointer-events: none; }
          .guide-label { fill: var(--text-dim); font-size: ${11 / sc}px; font-family: var(--mono); }
          .obj-fill { fill: var(--ink); fill-rule: nonzero; stroke: none; }
          .obj-fill-preview-outline { fill: none; stroke: var(--ink); stroke-width: ${1.25 / sc}; opacity: 0.85; }
          .obj-stroke { fill: none; stroke: var(--ink); }
          .obj-sel-outline { fill: none; stroke: var(--accent); stroke-width: ${1.5 / sc}; opacity: 0.9; }
          .brush-preview { fill: none; stroke: var(--accent); opacity: 0.85; }
          .rubber-line { stroke: var(--accent); stroke-width: ${1.2 / sc}; stroke-dasharray: ${4 / sc} ${3 / sc}; }
          .handle-line { stroke: var(--handle-line); stroke-width: ${1 / sc}; }
          .handle-dot { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1.4 / sc}; }
          .handle-dot.active { fill: var(--accent); }
          .node-shape { stroke-width: ${1.6 / sc}; }
          .node-shape.corner { fill: var(--canvas); stroke: var(--node-corner); }
          .node-shape.smooth { fill: var(--canvas); stroke: var(--node-smooth); }
          .node-shape.symmetric { fill: var(--canvas); stroke: var(--node-symmetric); }
          .node-shape.selected { fill: var(--accent); stroke: var(--accent); }
          .close-ring { fill: none; stroke: var(--accent); stroke-width: ${1.8 / sc}; }
          .marquee-rect { fill: var(--accent-soft); stroke: var(--accent); stroke-width: ${1 / sc}; opacity: 0.5; }
          .sel-box { fill: none; stroke: var(--accent); stroke-width: ${1.2 / sc}; stroke-dasharray: ${5 / sc} ${4 / sc}; }
          .sel-handle { fill: var(--canvas); stroke: var(--accent); stroke-width: ${1.5 / sc}; }
          .sel-skew-handle { fill: var(--accent-soft); stroke: var(--accent); stroke-width: ${1.25 / sc}; }
          .sel-skew-guide { stroke: color-mix(in srgb, var(--accent) 55%, transparent); stroke-width: ${1 / sc}; stroke-dasharray: ${2 / sc} ${3 / sc}; }
          .sel-rot-line { stroke: var(--accent); stroke-width: ${1.2 / sc}; }
        `}</style>

        <defs>
          <clipPath id="fontseru-main-canvas" clipPathUnits="userSpaceOnUse">
            <rect x={0} y={vbY} width={upm} height={vbH} />
          </clipPath>
          <clipPath id="ghost-reference-left" clipPathUnits="userSpaceOnUse">
            <rect x={-upm} y={vbY} width={upm} height={vbH} />
          </clipPath>
          <clipPath id="ghost-reference-right" clipPathUnits="userSpaceOnUse">
            <rect x={upm} y={vbY} width={upm} height={vbH} />
          </clipPath>
        </defs>

        {ghost.enabled && glyph && ghost.mode === "sample" && (
          <g
            data-testid="ghost-reference-canvas"
            data-ghost-mode="sample"
            pointerEvents="none"
          >
            <GhostGlyph
              mode="sample"
              char={glyph.char}
              ascender={ascender}
              capHeight={capHeight}
              upm={upm}
              opacity={ghost.opacity}
              scale={ghost.scale}
              offsetX={ghost.offsetX}
              offsetY={ghost.offsetY}
            />
          </g>
        )}

        {ghost.enabled && glyph && ghost.mode === "family" && (
          <g
            data-testid="ghost-reference-canvas"
            data-ghost-mode="family"
            pointerEvents="none"
          >
            <g
              clipPath="url(#ghost-reference-left)"
              data-testid="ghost-reference-left"
              data-family-style={leftGhostStyle}
            >
              <GhostGlyph
                mode="family"
                char={glyph.char}
                glyph={leftFamilyGlyph}
                ascender={ascender}
                capHeight={capHeight}
                upm={upm}
                opacity={ghost.opacity}
                scale={ghost.scale}
                offsetX={ghost.offsetX}
                offsetY={ghost.offsetY}
                laneOffsetX={-upm}
              />
            </g>
            <g
              clipPath="url(#ghost-reference-right)"
              data-testid="ghost-reference-right"
              data-family-style={rightGhostStyle}
            >
              <GhostGlyph
                mode="family"
                char={glyph.char}
                glyph={rightFamilyGlyph}
                ascender={ascender}
                capHeight={capHeight}
                upm={upm}
                opacity={ghost.opacity}
                scale={ghost.scale}
                offsetX={ghost.offsetX}
                offsetY={ghost.offsetY}
                laneOffsetX={upm}
              />
            </g>
          </g>
        )}

        {ghost.enabled && glyph && ghost.mode === "image" && ghost.imageSrc && (
          <g
            data-testid="ghost-reference-canvas"
            data-ghost-mode="image"
            pointerEvents="none"
          >
            <GhostGlyph
              mode="image"
              char={glyph.char}
              ascender={ascender}
              capHeight={capHeight}
              upm={upm}
              opacity={ghost.opacity}
              scale={ghost.scale}
              offsetX={ghost.offsetX}
              offsetY={ghost.offsetY}
              totalH={totalH}
              imageSrc={ghost.imageSrc}
              imageAspect={ghost.imageAspect}
            />
          </g>
        )}

        <g clipPath="url(#fontseru-main-canvas)">
        {showGrid && Array.from({ length: Math.floor((gridMaxX - gridMinX) / gridSize) + 1 }).map((_, i) => {
          const x = gridMinX + i * gridSize;
          const major = x === gridMinX || x === 0 || x === upm || x === gridMaxX;
          return (
            <line key={"v" + x} x1={x} y1={0} x2={x} y2={totalH}
              className={major ? "grid-major" : "grid-line"} />
          );
        })}
        {showGrid && Array.from({ length: Math.floor(totalH / gridSize) + 1 }).map((_, i) => {
          const y = ascender - i * gridSize;
          return <line key={"h" + i} x1={gridMinX} y1={y} x2={gridMaxX} y2={y} className="grid-line" />;
        })}

        <>
          {metricGuides.filter(({ key }) => key === "baseline" || showGuides).map(({ key, label, value, className }) => {
            const y = toY(value);
            const active = activeMetricGuide === key;
            const labelX = Math.max(0, vbX) + 10 / sc;
            return (
              <g key={key} className={`metric-guide ${className} ${active ? "active" : ""} ${tool === "home" ? "" : "locked"}`} data-testid={`font-guide-${key}`}>
                <line x1={0} y1={y} x2={upm} y2={y} className="metric-guide-line" pointerEvents="none" />
                <line
                  x1={0}
                  y1={y}
                  x2={upm}
                  y2={y}
                  className="metric-guide-hit"
                  pointerEvents={tool === "home" ? "stroke" : "none"}
                  onPointerDown={(e) => beginGuideDrag(key, e)}
                  onPointerMove={moveGuideDrag}
                  onPointerUp={finishGuideDrag}
                  onPointerCancel={finishGuideDrag}
                  onLostPointerCapture={finishGuideDrag}
                  onDoubleClick={(e) => focusGuideMetric(key, e)}
                  data-metric={key}
                />
                <text x={labelX} y={y - 6 / sc} className="guide-label" pointerEvents="none">{label}</text>
                {active && (
                  <g pointerEvents="none" data-testid="metric-drag-value">
                    <rect x={labelX} y={y + 5 / sc} width={72 / sc} height={20 / sc} rx={4 / sc} className="metric-guide-value-bg" />
                    <text x={labelX + 7 / sc} y={y + 19 / sc} className="metric-guide-value">{Math.round(value)}u</text>
                  </g>
                )}
              </g>
            );
          })}
          {showGuides && glyph && (() => {
            const top = vbY + 14 / sc;
            const handleW = 86 / sc;
            const handleH = 20 / sc;
            const lsbX = glyph.lsb;
            const advanceX = glyph.advanceWidth;
            const guides: { key: GlyphMetricKey; label: string; value: number; x: number; y: number; advance?: boolean }[] = [
              { key: "lsb", label: "LSB", value: glyph.lsb, x: lsbX, y: top },
              { key: "advanceWidth", label: "Advance", value: glyph.advanceWidth, x: advanceX, y: top, advance: true },
              // RSB moves the same physical right advance boundary, but gets
              // its own drag handle and numeric value just below Advance.
              { key: "rsb", label: "RSB", value: glyph.rsb, x: advanceX, y: top + 24 / sc },
            ];
            return (
              <>
                <line x1={lsbX} y1={vbY} x2={lsbX} y2={vbY + vbH} className="glyph-metric-guide-line" pointerEvents="none" />
                <line x1={advanceX} y1={vbY} x2={advanceX} y2={vbY + vbH} className="glyph-metric-guide-line advance" pointerEvents="none" />
                {guides.map((guide) => {
                  const active = activeGlyphMetricGuide === guide.key;
                  const rectX = guide.x - handleW / 2;
                  return (
                    <g key={guide.key} data-testid={`glyph-guide-${guide.key}`}>
                      <rect
                        x={rectX}
                        y={guide.y}
                        width={handleW}
                        height={handleH}
                        rx={4 / sc}
                        className={`glyph-metric-handle ${guide.advance ? "advance" : ""} ${active ? "active" : ""} ${tool === "home" ? "" : "locked"}`}
                        pointerEvents={tool === "home" ? "all" : "none"}
                        onPointerDown={(e) => beginGlyphGuideDrag(guide.key, e)}
                        onPointerMove={moveGlyphGuideDrag}
                        onPointerUp={finishGlyphGuideDrag}
                        onPointerCancel={finishGlyphGuideDrag}
                        onLostPointerCapture={finishGlyphGuideDrag}
                        onDoubleClick={(e) => focusGlyphGuideMetric(guide.key, e)}
                      />
                      <text
                        x={guide.x}
                        y={guide.y + 13.5 / sc}
                        textAnchor="middle"
                        className="glyph-metric-label"
                      >
                        {guide.label} {Math.round(guide.value)}
                      </text>
                    </g>
                  );
                })}
              </>
            );
          })()}
        </>
        </g>

        {/* Each object is its OWN path — overlapping/touching objects never subtract. */}
        {objects.map((obj) => {
          // Pen tool, Auto Close Shape OFF: the shape currently being drawn
          // previews as an outline only, until the last node closes it onto
          // the first (see penPointerDown) — at which point it's a normal,
          // committed, filled object like any other. Nothing else changes.
          const isLiveDrawPreview =
            tool === "pen" &&
            !penAutoCloseShape &&
            editor.drawingContourId != null &&
            obj.contours.some((c) => c.id === editor.drawingContourId && !c.closed);
          return (
            <ObjectShape key={obj.id} obj={obj} ascender={ascender} selected={selectedObjectIds.includes(obj.id)} outlineOnly={isLiveDrawPreview} />
          );
        })}

        {/* Brush silhouette preview (true nib/taper outline) */}
        {brushTool.previewOutline.length > 0 && (
          <path
            d={brushTool.previewOutline.map((c) => contourToPath(c, ascender)).join(" ")}
            className="obj-fill"
            fillRule="nonzero"
            opacity={0.9}
          />
        )}
        {brushTool.previewCenterline && (
          <path
            d={contourToPath(brushTool.previewCenterline, ascender)}
            className="brush-preview"
            strokeWidth={brush.size}
            strokeLinecap={brushCap}
            strokeLinejoin="round"
          />
        )}

        {/* Pen rubber-band */}
        {tool === "pen" && editor.drawingContourId && hover && (
          <RubberBand outline={editor.outline} contourId={editor.drawingContourId} hover={hover} ascender={ascender} hitScale={hitScale} />
        )}

        {/* Node-tool marquee */}
        {editor.marqueeRect && (
          <rect x={editor.marqueeRect.x} y={ascender - (editor.marqueeRect.y + editor.marqueeRect.h)}
            width={editor.marqueeRect.w} height={editor.marqueeRect.h} className="marquee-rect" />
        )}

        {/* Select-tool marquee */}
        {selectTool.marqueeRect && (
          <rect x={selectTool.marqueeRect.x} y={ascender - (selectTool.marqueeRect.y + selectTool.marqueeRect.h)}
            width={selectTool.marqueeRect.w} height={selectTool.marqueeRect.h} className="marquee-rect" />
        )}

        {/* Selection box + transform handles */}
        {tool === "select" && selBounds && handlePts && (
          <g>
            <rect x={selBounds.minX} y={ascender - selBounds.maxY} width={selBounds.maxX - selBounds.minX}
              height={selBounds.maxY - selBounds.minY} className="sel-box" />
            <line x1={handlePts.n.x} y1={ascender - handlePts.n.y} x2={handlePts.rotate.x} y2={ascender - handlePts.rotate.y} className="sel-rot-line" />
            <circle cx={handlePts.rotate.x} cy={ascender - handlePts.rotate.y} r={5 * hitScale} className="sel-handle" />
            {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as HandleId[]).map((id) => {
              const s = 7 * hitScale;
              return <rect key={id} x={handlePts[id].x - s / 2} y={ascender - handlePts[id].y - s / 2} width={s} height={s} className="sel-handle" />;
            })}
            {(["skew-x-top", "skew-x-bottom", "skew-y-left", "skew-y-right"] as SkewHandleId[]).map((id) => {
              const p = handlePts[id];
              const s = 6.5 * hitScale;
              const edge =
                id === "skew-x-top" ? { x: p.x, y: selBounds.maxY }
                : id === "skew-x-bottom" ? { x: p.x, y: selBounds.minY }
                : id === "skew-y-left" ? { x: selBounds.minX, y: p.y }
                : { x: selBounds.maxX, y: p.y };
              return (
                <g key={id}>
                  <line x1={edge.x} y1={ascender - edge.y} x2={p.x} y2={ascender - p.y} className="sel-skew-guide" />
                  <rect
                    x={p.x - s / 2}
                    y={ascender - p.y - s / 2}
                    width={s}
                    height={s}
                    rx={1.2 * hitScale}
                    className="sel-skew-handle"
                    transform={`rotate(45 ${p.x} ${ascender - p.y})`}
                    data-transform-handle={id}
                  />
                </g>
              );
            })}
          </g>
        )}

        {/* Nodes + handles (Node tool, or while drawing with Pen) */}
        {(tool === "node" || tool === "pen") &&
          objects.map((obj) =>
            obj.contours.map((contour) =>
              contour.nodes.map((node) => {
                const svgP = toSvgPoint(node.point, ascender);
                const isSel = editor.selectedNodes.some((r) => r.contourId === contour.id && r.nodeId === node.id);
                const showHandles = tool === "node" ? isSel : Boolean(node.handleIn || node.handleOut);
                return (
                  <g key={node.id}>
                    {showHandles && node.handleIn && (
                      <HandleGlyph node={node} part="handleIn" ascender={ascender} hitScale={hitScale}
                        selected={editor.selectedHandle?.contourId === contour.id && editor.selectedHandle?.nodeId === node.id && editor.selectedHandle?.part === "handleIn"} />
                    )}
                    {showHandles && node.handleOut && (
                      <HandleGlyph node={node} part="handleOut" ascender={ascender} hitScale={hitScale}
                        selected={editor.selectedHandle?.contourId === contour.id && editor.selectedHandle?.nodeId === node.id && editor.selectedHandle?.part === "handleOut"} />
                    )}
                    <NodeShape point={svgP} type={node.type} hitScale={hitScale} selected={isSel} />
                  </g>
                );
              })
            )
          )}
      </svg>
    </div>
  );
}

function ObjectShape({ obj, ascender, selected, outlineOnly }: { obj: VectorObject; ascender: number; selected: boolean; outlineOnly?: boolean }) {
  if (obj.kind === "shape" || obj.kind === "expanded") {
    const d = objectFillPath(obj, ascender);
    if (outlineOnly) {
      return <path d={d} className="obj-fill-preview-outline" vectorEffect="non-scaling-stroke" />;
    }
    return (
      <>
        <path d={d} className="obj-fill" />
        {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
      </>
    );
  }
  if (obj.kind === "brush") {
    if (obj.brushType === "monoline") {
      const d = objectStrokePath(obj, ascender);
      return (
        <>
          <path d={d} className="obj-stroke" strokeWidth={obj.strokeWidth ?? 20} strokeLinecap={obj.cap ?? "round"} strokeLinejoin={obj.join ?? "round"} />
          {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
        </>
      );
    }
    // Variable-profile brushes render a derived silhouette while retaining the
    // editable centerline as their stored geometry.
    const d = brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" ");
    return (
      <>
        <path d={d} className="obj-fill" />
        {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
      </>
    );
  }
  const d = objectStrokePath(obj, ascender);
  return (
    <>
      <path d={d} className="obj-stroke" strokeWidth={obj.strokeWidth ?? 20} strokeLinecap={obj.cap ?? "round"} strokeLinejoin={obj.join ?? "round"} />
      {selected && <path d={d} className="obj-sel-outline" vectorEffect="non-scaling-stroke" />}
    </>
  );
}

function NodeShape({ point, type, hitScale, selected }: { point: Point; type: NodeType; hitScale: number; selected: boolean }) {
  const cls = `node-shape ${type} ${selected ? "selected" : ""}`;
  if (type === "corner") {
    const s = 7 * hitScale;
    return <rect x={point.x - s / 2} y={point.y - s / 2} width={s} height={s} className={cls} />;
  }
  const r = (type === "symmetric" ? 4.6 : 4.2) * hitScale;
  return <circle cx={point.x} cy={point.y} r={r} className={cls} />;
}

function HandleGlyph({
  node, part, ascender, hitScale, selected,
}: {
  node: { point: Point; handleIn: Point | null; handleOut: Point | null };
  part: "handleIn" | "handleOut"; ascender: number; hitScale: number; selected: boolean;
}) {
  const handle = part === "handleIn" ? node.handleIn : node.handleOut;
  if (!handle) return null;
  const from = toSvgPoint(node.point, ascender);
  const to = toSvgPoint(handle, ascender);
  return (
    <>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="handle-line" />
      <circle cx={to.x} cy={to.y} r={3.4 * hitScale} className={`handle-dot ${selected ? "active" : ""}`} />
    </>
  );
}

function RubberBand({
  outline, contourId, hover, ascender, hitScale,
}: {
  outline: ReturnType<typeof useGlyphEditor>["outline"]; contourId: string; hover: Point; ascender: number; hitScale: number;
}) {
  const contour = outline.objects.flatMap((o) => o.contours).find((c) => c.id === contourId);
  if (!contour || contour.nodes.length === 0) return null;
  const last = contour.nodes[contour.nodes.length - 1];
  const first = contour.nodes[0];
  const fromSvg = toSvgPoint(last.point, ascender);
  const toSvg = toSvgPoint(hover, ascender);
  const nearFirst = contour.nodes.length > 1 && Math.hypot(hover.x - first.point.x, hover.y - first.point.y) <= 16 * hitScale;
  const firstSvg = toSvgPoint(first.point, ascender);
  return (
    <>
      <line x1={fromSvg.x} y1={fromSvg.y} x2={toSvg.x} y2={toSvg.y} className="rubber-line" />
      {nearFirst && <circle cx={firstSvg.x} cy={firstSvg.y} r={7 * hitScale} className="close-ring" />}
    </>
  );
}

function handleCursor(h: HandleId): string {
  if (h === "rotate") return "cursor-rot";
  if (h === "skew-x-top" || h === "skew-x-bottom") return "cursor-skew-x";
  if (h === "skew-y-left" || h === "skew-y-right") return "cursor-skew-y";
  if (h === "n" || h === "s") return "cursor-ns";
  if (h === "e" || h === "w") return "cursor-ew";
  if (h === "nw" || h === "se") return "cursor-nwse";
  return "cursor-nesw";
}
