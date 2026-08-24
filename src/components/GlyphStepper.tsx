import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { getOrderedChars } from "@/glyph/defaultGlyphs";

/**
 * Minimalist Prev/Next glyph navigator for Sketch Mode. Sits just above the
 * existing bottom-center FloatingToolbar. Only rendered while Sketch Mode is
 * active — Sketch Mode already hides the glyph list sidebar, so this is the
 * stand-in way to move between glyphs without leaving the canvas. Reuses the
 * same `setActiveChar` action and glyph ordering GlyphNav already uses.
 */
export function GlyphStepper() {
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
    <div className="fm-glyph-stepper" data-testid="glyph-stepper">
      <button
        type="button"
        className="fm-glyph-stepper-btn"
        disabled={!canPrev}
        onClick={goPrev}
        title="Previous glyph"
        data-testid="glyph-stepper-prev"
      >
        <ChevronLeft size={16} strokeWidth={2.1} />
      </button>
      <span className="fm-glyph-stepper-char" data-testid="glyph-stepper-char">{activeChar}</span>
      <button
        type="button"
        className="fm-glyph-stepper-btn"
        disabled={!canNext}
        onClick={goNext}
        title="Next glyph"
        data-testid="glyph-stepper-next"
      >
        <ChevronRight size={16} strokeWidth={2.1} />
      </button>
    </div>
  );
}
