import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

interface TouchPt { x: number; y: number; }

interface SketchGestureOptions {
  /** Gate: gestures are only recognized while Sketch Mode is on, so normal
   * mode's pointer handling is completely untouched. */
  enabled: boolean;
  /** Reuses GlyphCanvas's existing zoom-toward-point implementation. */
  applyZoomAt: (newZoom: number, clientX: number, clientY: number) => void;
  getZoom: () => number;
  onUndo: () => void;
  onRedo: () => void;
  /** Cancels any single-finger stroke/drag in progress when a second finger
   * lands, so a pinch never leaves a stray brush mark. */
  onCancelActive: () => void;
  /** 2-finger drag = pan. Called with the frame-to-frame movement of the
   * touch midpoint, in screen pixels; the consumer converts that to its own
   * pan/scale space (reuses GlyphCanvas's existing hand-pan math). */
  onPanBy: (dxClient: number, dyClient: number) => void;
}

const TAP_MAX_MS = 400;
const TAP_MAX_MOVE = 14; // px, in screen space

/**
 * Sketch Mode multi-touch gestures, layered on top of the existing pointer
 * pipeline without changing it: pinch-to-zoom, 2-finger tap = Undo,
 * 3-finger tap = Redo, and simple palm rejection (touch is ignored while a
 * pen is down / just lifted). Consumers call handlePointer* first inside
 * their existing handlers; a `true` return means the event was consumed by
 * a gesture and the normal tool logic for that event should be skipped.
 */
export function useSketchGestures({ enabled, applyZoomAt, getZoom, onUndo, onRedo, onCancelActive, onPanBy }: SketchGestureOptions) {
  const pointers = useRef<Map<number, TouchPt>>(new Map());
  const tapStart = useRef<Map<number, TouchPt>>(new Map());
  const penActiveRef = useRef(false);
  const penReleaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartZoom = useRef(100);
  const tapCandidate = useRef<{ count: number; startTime: number; moved: boolean } | null>(null);
  /** Last frame's 2-finger midpoint, in screen space; used to derive the
   * per-frame pan delta for 2-finger-drag panning. Reset whenever the
   * 2-finger gesture (re)starts so a fresh drag doesn't jump. */
  const panMid = useRef<TouchPt | null>(null);

  const dist = (a: TouchPt, b: TouchPt) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: TouchPt, b: TouchPt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const resetGesture = useCallback(() => {
    pointers.current.clear();
    tapStart.current.clear();
    tapCandidate.current = null;
    pinchStartDist.current = null;
    panMid.current = null;
  }, []);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent | PointerEvent): boolean => {
      if (!enabled) return false;

      if (e.pointerType === "pen") {
        penActiveRef.current = true;
        if (penReleaseTimer.current) { clearTimeout(penReleaseTimer.current); penReleaseTimer.current = null; }
        return false; // pen always draws normally
      }
      if (e.pointerType !== "touch") return false; // mouse: untouched

      // Palm rejection: while a pen is down (or just lifted), ignore touch
      // input entirely rather than letting a resting palm draw or gesture.
      if (penActiveRef.current) return true;

      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      tapStart.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const n = pointers.current.size;

      if (n === 1) return false; // single finger: draw/pan/select as usual

      if (n === 2 || n === 3) {
        onCancelActive();
        tapCandidate.current = { count: n, startTime: Date.now(), moved: false };
        if (n === 2) {
          const pts = [...pointers.current.values()];
          pinchStartDist.current = dist(pts[0], pts[1]);
          pinchStartZoom.current = getZoom();
          panMid.current = midpoint(pts[0], pts[1]);
        } else {
          panMid.current = null; // 3rd finger landed: stop panning, it's a redo-tap candidate
        }
        return true;
      }
      return true; // 4+ fingers: ignore
    },
    [enabled, getZoom, onCancelActive]
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent | PointerEvent): boolean => {
      if (!enabled) return false;
      if (e.pointerType !== "touch") return false;
      if (!pointers.current.has(e.pointerId)) return false;

      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const start = tapStart.current.get(e.pointerId);
      if (start && tapCandidate.current) {
        const moved = dist(start, { x: e.clientX, y: e.clientY }) > TAP_MAX_MOVE;
        if (moved) tapCandidate.current.moved = true;
      }

      const n = pointers.current.size;
      if (n === 2 && pinchStartDist.current) {
        const pts = [...pointers.current.values()];
        const d = dist(pts[0], pts[1]);
        const ratio = d / pinchStartDist.current;
        const mid = midpoint(pts[0], pts[1]);
        applyZoomAt(pinchStartZoom.current * ratio, mid.x, mid.y);
        // 2-finger drag = pan: on top of pinch-zoom's focal-point recentring
        // above (a no-op for pure translation, since it re-anchors whatever
        // font point sits under the live midpoint), walk the view by the
        // midpoint's own frame-to-frame movement so panning works whether or
        // not the fingers are also pinching.
        if (panMid.current) {
          onPanBy(mid.x - panMid.current.x, mid.y - panMid.current.y);
        }
        panMid.current = mid;
        return true;
      }
      return n >= 2;
    },
    [enabled, applyZoomAt, onPanBy]
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent | PointerEvent): boolean => {
      if (!enabled) return false;

      if (e.pointerType === "pen") {
        // Keep rejecting touch briefly after the pen lifts, since a resting
        // palm often lingers a moment past pen-up.
        if (penReleaseTimer.current) clearTimeout(penReleaseTimer.current);
        penReleaseTimer.current = setTimeout(() => { penActiveRef.current = false; }, 700);
        return false;
      }
      if (e.pointerType !== "touch") return false;

      const wasTracked = pointers.current.has(e.pointerId);
      pointers.current.delete(e.pointerId);
      tapStart.current.delete(e.pointerId);

      if (!wasTracked) return true; // was a rejected/ignored touch

      if (pointers.current.size === 0) {
        const tap = tapCandidate.current;
        if (tap && !tap.moved && Date.now() - tap.startTime < TAP_MAX_MS) {
          if (tap.count === 2) onUndo();
          else if (tap.count === 3) onRedo();
        }
        tapCandidate.current = null;
        pinchStartDist.current = null;
        panMid.current = null;
      } else if (pointers.current.size === 2) {
        // Dropped from 3 fingers back to 2 (e.g. a redo-tap finger lifted
        // first): re-baseline pinch/pan against the two remaining fingers
        // so the next move doesn't jump using stale start values.
        const pts = [...pointers.current.values()];
        pinchStartDist.current = dist(pts[0], pts[1]);
        pinchStartZoom.current = getZoom();
        panMid.current = midpoint(pts[0], pts[1]);
      } else {
        // Down to 1 (or 0) fingers: stop panning/pinching cleanly.
        panMid.current = null;
        pinchStartDist.current = null;
      }
      return true;
    },
    [enabled, onUndo, onRedo, getZoom]
  );

  return { handlePointerDown, handlePointerMove, handlePointerUp, resetGesture };
}
