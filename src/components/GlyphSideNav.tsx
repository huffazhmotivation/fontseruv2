import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { getOrderedChars } from "@/glyph/defaultGlyphs";

/**
 * Minimalist Prev/Next glyph navigation for Normal Mode (non-Sketch Mode).
 * Renders only two small green chevrons docked to the left/right edges of
 * the canvas — no label, no panel, matching the request to keep Normal
 * Mode's canvas chrome minimal. Sketch Mode keeps its own separate
 * GlyphStepper (bottom-center, with the active-char label) untouched.
 *
 * Reuses the exact same glyph ordering / setActiveChar logic as
 * GlyphStepper, so Prev/Next behavior is identical between the two modes.
 */
export function GlyphSideNav() {
  const glyphs = useAppStore((s) => s.glyphs);
  const activeChar = useAppStore((s) => s.activeChar);
  const setActiveChar = useAppStore((s) => s.setActiveChar);

  const ordered = getOrderedChars(glyphs);
  const idx = ordered.indexOf(activeChar);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < ordered.length - 1;

  const goPrev = () => { if (canPrev) setActiveChar(ordered[idx - 1]); };
  const goNext = () => { if (canNext) setActiveChar(ordered[idx + 1]); };

  return (
    <>
      <button
        type="button"
        className="fm-glyph-sidenav-btn fm-glyph-sidenav-btn-left"
        disabled={!canPrev}
        onClick={goPrev}
        title="Previous glyph"
        data-testid="glyph-sidenav-prev"
      >
        <ChevronLeft size={22} strokeWidth={2.4} />
      </button>
      <button
        type="button"
        className="fm-glyph-sidenav-btn fm-glyph-sidenav-btn-right"
        disabled={!canNext}
        onClick={goNext}
        title="Next glyph"
        data-testid="glyph-sidenav-next"
      >
        <ChevronRight size={22} strokeWidth={2.4} />
      </button>
    </>
  );
}
