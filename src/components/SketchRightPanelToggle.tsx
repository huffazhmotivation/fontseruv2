import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "@/glyph/store";

/**
 * Sketch Mode only. The right inspector panel stays fully tucked away while
 * sketching (see .fm-root[data-sketch-mode="true"] .fm-rightpanel in
 * app.css); this button lets it slide in over the canvas as a drawer
 * on demand instead of permanently reclaiming layout width. Purely
 * additive — normal mode's RightPanel and layout are untouched.
 */
export function SketchRightPanelToggle() {
  const open = useAppStore((s) => s.sketchRightPanelOpen);
  const toggle = useAppStore((s) => s.toggleSketchRightPanel);

  return (
    <button
      type="button"
      className={`fm-sketch-panel-toggle ${open ? "open" : ""}`}
      onClick={toggle}
      aria-pressed={open}
      title={open ? "Hide panel" : "Show panel"}
      data-testid="sketch-rightpanel-toggle"
    >
      {open ? <ChevronRight size={16} strokeWidth={2} /> : <ChevronLeft size={16} strokeWidth={2} />}
    </button>
  );
}
