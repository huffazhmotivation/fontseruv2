import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Undo2, Redo2, Copy, Clipboard, CopyPlus, Trash2, GripHorizontal } from "lucide-react";
import { useAppStore } from "@/glyph/store";

type DragPos = { left: number; top: number };

const DRAG_MARGIN = 8;

/**
 * Sketch Mode's own floating toolbar, on the left edge of the canvas by
 * default. Entirely separate from the existing FloatingToolbar (which is
 * left untouched) and only rendered while Sketch Mode is active. Every
 * action reuses the same store methods as the keyboard shortcuts / TopBar
 * buttons.
 *
 * Draggable via the grip handle, vertically only (up/down) — it always
 * stays docked at its horizontal position and never switches to a
 * horizontal row. Position is local UI state (not persisted), so leaving
 * Sketch Mode and coming back resets it to the default left-center dock,
 * matching how the rest of Sketch Mode's chrome behaves.
 */
export function SketchToolbar() {
  const past = useAppStore((s) => s.past);
  const future = useAppStore((s) => s.future);
  const clipboard = useAppStore((s) => s.clipboard);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);
  const selectedNodes = useAppStore((s) => s.selectedNodes);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const copySelection = useAppStore((s) => s.copySelection);
  const pasteClipboard = useAppStore((s) => s.pasteClipboard);
  const deleteSelectedObjects = useAppStore((s) => s.deleteSelectedObjects);
  const deleteSelectedNodes = useAppStore((s) => s.deleteSelectedNodes);

  // Duplicate = copy immediately followed by paste, same as the Duplicate
  // button in RightPanel — keeps the two entry points in sync.
  const duplicateSelection = useCallback(() => {
    copySelection();
    pasteClipboard();
  }, [copySelection, pasteClipboard]);

  // Sketch Mode's single Delete button has to cover both the Select tool
  // (selectedObjectIds) and the Node tool (selectedNodes) — the two are
  // mutually exclusive by construction (see setTool in the store), so
  // checking node selection first and falling back to object selection
  // always follows whichever selection is actually active.
  const hasNodeSelection = selectedNodes.length > 0;
  const hasObjectSelection = selectedObjectIds.length > 0;
  const canDelete = hasNodeSelection || hasObjectSelection;
  const deleteSelection = useCallback(() => {
    if (hasNodeSelection) { deleteSelectedNodes(); return; }
    if (hasObjectSelection) deleteSelectedObjects();
  }, [hasNodeSelection, hasObjectSelection, deleteSelectedNodes, deleteSelectedObjects]);

  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originLeft: number; originTop: number } | null>(null);
  const [pos, setPos] = useState<DragPos | null>(null);

  const onGripPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const el = elRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    e.preventDefault();
    e.stopPropagation();
    const elRect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: elRect.left - parentRect.left,
      originTop: elRect.top - parentRect.top,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onGripPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = elRef.current;
    const parent = el?.parentElement;
    if (!drag || !el || !parent || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const parentRect = parent.getBoundingClientRect();
    const h = el.offsetHeight;
    // Vertical-only drag: horizontal position never changes from where the
    // drag started, only top moves with the pointer.
    let top = drag.originTop + (e.clientY - drag.startY);
    top = Math.min(Math.max(top, DRAG_MARGIN), Math.max(DRAG_MARGIN, parentRect.height - h - DRAG_MARGIN));
    setPos({ left: drag.originLeft, top });
  }, []);

  const onGripPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }, []);

  // Always vertical: the toolbar only ever moves up/down, so the
  // horizontal-row styling and icon are never used, but the classnames stay
  // (harmless) so the CSS above remains fully backward-compatible.
  const dividerClass = "fm-toolbar-divider fm-toolbar-divider-h";
  const tipClass = "fm-tool-tip fm-tool-tip-right";

  return (
    <div
      ref={elRef}
      className="fm-sketch-toolbar"
      data-testid="sketch-toolbar"
      style={pos ? { left: pos.left, top: pos.top, transform: "none" } : undefined}
    >
      <div
        className="fm-sketch-toolbar-grip"
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={onGripPointerUp}
        onPointerCancel={onGripPointerUp}
        title="Drag up/down to move"
        data-testid="sketch-toolbar-grip"
      >
        <GripHorizontal size={13} strokeWidth={1.8} />
      </div>
      <button
        type="button"
        className="fm-tool"
        disabled={past.length === 0}
        onClick={undo}
        title="Undo"
        data-testid="sketch-undo-btn"
      >
        <Undo2 size={17} strokeWidth={1.7} />
        <span className={tipClass}>Undo</span>
      </button>
      <button
        type="button"
        className="fm-tool"
        disabled={future.length === 0}
        onClick={redo}
        title="Redo"
        data-testid="sketch-redo-btn"
      >
        <Redo2 size={17} strokeWidth={1.7} />
        <span className={tipClass}>Redo</span>
      </button>
      <div className={dividerClass} />
      <button
        type="button"
        className="fm-tool"
        disabled={selectedObjectIds.length === 0}
        onClick={copySelection}
        title="Copy"
        data-testid="sketch-copy-btn"
      >
        <Copy size={17} strokeWidth={1.7} />
        <span className={tipClass}>Copy</span>
      </button>
      <button
        type="button"
        className="fm-tool"
        disabled={!clipboard || clipboard.length === 0}
        onClick={pasteClipboard}
        title="Paste"
        data-testid="sketch-paste-btn"
      >
        <Clipboard size={17} strokeWidth={1.7} />
        <span className={tipClass}>Paste</span>
      </button>
      <button
        type="button"
        className="fm-tool"
        disabled={selectedObjectIds.length === 0}
        onClick={duplicateSelection}
        title="Duplicate"
        data-testid="sketch-duplicate-btn"
      >
        <CopyPlus size={17} strokeWidth={1.7} />
        <span className={tipClass}>Duplicate</span>
      </button>
      <div className={dividerClass} />
      <button
        type="button"
        className="fm-tool fm-tool-danger"
        disabled={!canDelete}
        onClick={deleteSelection}
        title="Delete"
        data-testid="sketch-delete-btn"
      >
        <Trash2 size={17} strokeWidth={1.7} />
        <span className={tipClass}>Delete</span>
      </button>
    </div>
  );
}
