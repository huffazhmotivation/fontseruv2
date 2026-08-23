import { PenLine } from "lucide-react";
import { useAppStore } from "@/glyph/store";

/**
 * Minimalist floating toggle, top-left of the canvas. Turns Sketch Mode on
 * or off; it never touches the existing FloatingToolbar or any other
 * existing UI — purely additive.
 */
export function SketchModeToggle() {
  const sketchMode = useAppStore((s) => s.sketchMode);
  const toggleSketchMode = useAppStore((s) => s.toggleSketchMode);

  return (
    <button
      type="button"
      className={`fm-sketch-toggle ${sketchMode ? "active" : ""}`}
      onClick={toggleSketchMode}
      data-testid="sketch-mode-toggle"
      aria-pressed={sketchMode}
      title={sketchMode ? "Exit Sketch Mode" : "Sketch Mode"}
    >
      <PenLine size={16} strokeWidth={1.8} />
      <span className="fm-sketch-toggle-label">Sketch Mode</span>
    </button>
  );
}
