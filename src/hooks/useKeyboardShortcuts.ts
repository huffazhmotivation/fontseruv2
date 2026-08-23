import { useEffect } from "react";
import { useAppStore } from "@/glyph/store";
import type { ToolId } from "@/types/tool";
import { pasteSvgFromSystemClipboard } from "@/trace/svgImport";

const KEY_TO_TOOL: Record<string, ToolId> = {
  v: "select", p: "pen", b: "brush", n: "node", h: "hand", z: "zoom",
};

/**
 * Cmd/Ctrl+V handler. Tries the OS clipboard first for pasted vector art
 * (Affinity Designer, Illustrator, and similar apps write the copied shape
 * to the system clipboard as SVG) and only falls back to FontSeru's own
 * internal object clipboard when there's nothing usable there — so copying
 * inside FontSeru and copying from another vector app both just work with
 * the same shortcut.
 */
async function handlePasteShortcut() {
  const pastedExternalVector = await pasteSvgFromSystemClipboard();
  if (!pastedExternalVector) {
    useAppStore.getState().pasteClipboard();
  }
}

/** Global shortcuts: tools, undo/redo, clipboard, and object delete/nudge. */
export function useKeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      const s = useAppStore.getState();
      if (s.testLabOpen) return; // Test Lab / Kerning overlay owns keyboard input while open
      const mod = e.metaKey || e.ctrlKey;

      if (mod) {
        const k = e.key.toLowerCase();
        if (k === "z") { e.preventDefault(); e.shiftKey ? s.redo() : s.undo(); return; }
        if (k === "y") { e.preventDefault(); s.redo(); return; }
        if (k === "c") { e.preventDefault(); s.copySelection(); return; }
        if (k === "x") { e.preventDefault(); s.cutSelection(); return; }
        if (k === "v") { e.preventDefault(); void handlePasteShortcut(); return; }
        if (k === "d") {
          if (s.selectedObjectIds.length > 0) { e.preventDefault(); s.copySelection(); s.pasteClipboard(); }
          return;
        }
        if (k === "g") { e.preventDefault(); s.groupSelectedObjects(); return; }
        if (k === "u") { e.preventDefault(); s.ungroupSelectedObjects(); return; }
        return;
      }

      if (s.tool === "select") {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); s.deleteSelectedObjects(); return; }
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowLeft") { e.preventDefault(); s.nudgeSelectedObjects(-step, 0); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); s.nudgeSelectedObjects(step, 0); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); s.nudgeSelectedObjects(0, step); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); s.nudgeSelectedObjects(0, -step); return; }
      }

      const tool = KEY_TO_TOOL[e.key.toLowerCase()];
      if (tool) {
        s.setTool(tool);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
