import { useAppStore } from "@/glyph/store";
import type { Glyph } from "@/types/glyph";
import { objectFillPath, objectStrokePath, contourToPath } from "@/editor/pathBuilder";
import { outlineBounds } from "@/editor/objectOps";
import { brushOutlineContours } from "@/brushes/strokeToOutline";
import { hasOutline } from "@/types/glyph";

/**
 * Miniature preview of a glyph's ACTUAL vector data. Falls back to the plain
 * character (sans) when the glyph has not been drawn yet.
 */
export function GlyphThumbnail({ glyph, className = "" }: { glyph: Glyph; className?: string }) {
  const metrics = useAppStore((s) => s.metrics);

  if (!hasOutline(glyph)) {
    return <span className={`fm-thumb-char ${className}`}>{glyph.char}</span>;
  }

  const b = outlineBounds(glyph.outline);
  const { ascender } = metrics;
  if (!b) return <span className={`fm-thumb-char ${className}`}>{glyph.char}</span>;

  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const pad = Math.max(w, h) * 0.16 + 30;
  const vbX = b.minX - pad;
  const vbY = ascender - b.maxY - pad;
  const vbW = w + pad * 2;
  const vbH = h + pad * 2;

  return (
    <svg className={`fm-thumb-svg ${className}`} viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {glyph.outline.objects.map((obj) =>
        obj.kind === "shape" || obj.kind === "expanded" ? (
          <path key={obj.id} d={objectFillPath(obj, ascender)} fill="currentColor" fillRule="nonzero" />
        ) : obj.kind === "brush" && obj.brushType !== "monoline" ? (
          <path key={obj.id} d={brushOutlineContours(obj).map((c) => contourToPath(c, ascender)).join(" ")} fill="currentColor" fillRule="nonzero" />
        ) : (
          <path key={obj.id} d={objectStrokePath(obj, ascender)} fill="none" stroke="currentColor"
            strokeWidth={obj.strokeWidth ?? 20} strokeLinecap={obj.cap ?? "round"} strokeLinejoin={obj.join ?? "round"} />
        )
      )}
    </svg>
  );
}
