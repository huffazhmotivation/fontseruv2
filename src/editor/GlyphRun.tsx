import { useAppStore } from "@/glyph/store";
import type { GlyphMap } from "@/types/glyph";
import type { KerningPairs } from "@/types/kerning";
import { objectFillPath, objectStrokePath, contourToPath } from "./pathBuilder";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { layoutLine } from "./textLayout";

interface GlyphRunProps {
  text: string;
  /** Rendered height of one em, in CSS pixels. */
  fontSizePx: number;
  /** Extra spacing between glyphs, in font units (can be negative). */
  trackingUnits?: number;
  color?: string;
  className?: string;
  /** Optional per-glyph ink override. Existing callers render unchanged when omitted. */
  colorForIndex?: (index: number, char: string) => string | undefined;
  /** Additive Test Lab escape hatch: render a family style without switching the editor store style. */
  glyphsOverride?: GlyphMap;
  /** Additive Test Lab escape hatch: render an effective Shared + Style Override view. */
  kerningPairsOverride?: KerningPairs;
}

export function GlyphRun({
  text,
  fontSizePx,
  trackingUnits = 0,
  color = "currentColor",
  className = "",
  colorForIndex,
  glyphsOverride,
  kerningPairsOverride,
}: GlyphRunProps) {
  const storeGlyphs = useAppStore((s) => s.glyphs);
  const metrics = useAppStore((s) => s.metrics);
  const storeKerningPairs = useAppStore((s) => s.kerningPairs);
  const glyphs = glyphsOverride ?? storeGlyphs;
  const kerningPairs = kerningPairsOverride ?? storeKerningPairs;
  const { ascender, descender, unitsPerEm } = metrics;
  const totalH = ascender - descender;

  // Single shared layout engine — also used by the Test Lab / Kerning caret
  // and click hit-testing, so rendering and caret position can never drift.
  const { placed, totalAdvance: rawAdvance } = layoutLine(text, glyphs, unitsPerEm, kerningPairs, trackingUnits);
  const totalAdvance = Math.max(1, rawAdvance);

  const pxPerUnit = fontSizePx / unitsPerEm;
  const width = Math.max(1, totalAdvance * pxPerUnit);
  const height = Math.max(1, totalH * pxPerUnit);

  return (
    <svg
      className={`fm-glyphrun ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${totalAdvance} ${totalH}`}
      style={{ display: "block", overflow: "visible" }}
      aria-label={text}
    >
      <g fill={color} stroke={color}>
        {placed.map(({ char, x }, i) => {
          const g = glyphs[char];
          if (!g) return null;
          const glyphColor = colorForIndex?.(i, char) ?? color;
          return (
            <g key={i} transform={`translate(${x} 0)`} fill={glyphColor} stroke={glyphColor}>
              {g.outline.objects.map((obj) =>
                obj.kind === "shape" || obj.kind === "expanded" ? (
                  <path key={obj.id} d={objectFillPath(obj, ascender)} fill={glyphColor} fillRule="nonzero" stroke="none" />
                ) : obj.kind === "brush" && obj.brushType !== "monoline" ? (
                  <path
                    key={obj.id}
                    d={brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" ")}
                    fill={glyphColor}
                    fillRule="nonzero"
                    stroke="none"
                  />
                ) : (
                  <path
                    key={obj.id}
                    d={objectStrokePath(obj, ascender)}
                    fill="none"
                    stroke={glyphColor}
                    strokeWidth={obj.strokeWidth ?? 20}
                    strokeLinecap={obj.cap ?? "round"}
                    strokeLinejoin={obj.join ?? "round"}
                  />
                )
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
