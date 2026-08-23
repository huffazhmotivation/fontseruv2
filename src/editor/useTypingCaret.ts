import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/glyph/store";
import { layoutLine, nearestCaretColumn, caretX, type LineLayout } from "./textLayout";

export interface CaretPos {
  line: number;
  col: number;
}

/**
 * Drives a caret that is positioned from FontSeru's actual glyph layout
 * (advance width, LSB/RSB, kerning, tracking) instead of the browser's own
 * text metrics. A real <textarea> stays the source of truth for typing,
 * deleting, arrow keys, Home/End, and IME — all native, all reliable — and
 * this hook only ever reads its selection and re-derives a pixel position
 * from the shared `textLayout` engine (the same one GlyphRun renders with).
 */
export function useTypingCaret(
  lines: string[],
  fontSizePx: number,
  trackingUnits: number,
  sourceLineStarts?: number[]
) {
  const glyphs = useAppStore((s) => s.glyphs);
  const metrics = useAppStore((s) => s.metrics);
  const kerningPairs = useAppStore((s) => s.kerningPairs);
  const { unitsPerEm, ascender, descender } = metrics;
  const totalH = ascender - descender;
  const pxPerUnit = fontSizePx / unitsPerEm;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [caret, setCaret] = useState<CaretPos>({ line: 0, col: 0 });
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const hasSelection = selectionStart !== selectionEnd;

  const linesKey = lines.join("\n");
  const layouts: LineLayout[] = useMemo(
    () => lines.map((line) => layoutLine(line, glyphs, unitsPerEm, kerningPairs, trackingUnits)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linesKey, glyphs, unitsPerEm, kerningPairs, trackingUnits]
  );

  const lineStarts = useMemo(() => {
    if (sourceLineStarts && sourceLineStarts.length === lines.length) {
      return sourceLineStarts;
    }
    const starts: number[] = [];
    let acc = 0;
    for (const line of lines) {
      starts.push(acc);
      acc += line.length + 1;
    }
    return starts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, sourceLineStarts]);

  const indexToLineCol = useCallback(
    (idx: number): CaretPos => {
      let line = 0;
      for (let i = 0; i < lineStarts.length; i++) {
        if (idx >= lineStarts[i]) line = i;
        else break;
      }
      const codeUnitCol = Math.max(0, idx - (lineStarts[line] ?? 0));
      const lineText = lines[line] ?? "";
      const col = Array.from(lineText.slice(0, codeUnitCol)).length;
      return { line, col };
    },
    [lineStarts, lines]
  );

  const lineColToIndex = useCallback(
    (line: number, col: number) => {
      const prefix = Array.from(lines[line] ?? "").slice(0, Math.max(0, col)).join("");
      return (lineStarts[line] ?? 0) + prefix.length;
    },
    [lineStarts, lines]
  );

  const syncFromSelection = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    setSelectionStart(start);
    setSelectionEnd(end);
    setCaret(indexToLineCol(start));
  }, [indexToLineCol]);

  // Re-derive the visual caret whenever the text, font size, or tracking
  // change underneath an unchanged selection index.
  useEffect(() => {
    syncFromSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, fontSizePx, trackingUnits]);

  // Home/End/arrow-key moves don't always fire onSelect in every browser —
  // listen at the document level while this textarea is focused.
  useEffect(() => {
    const handler = () => {
      if (document.activeElement === inputRef.current) syncFromSelection();
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [syncFromSelection]);

  /** Nearest real glyph column for a client-space point, using actual advances (not the browser's font metrics). */
  const pointToIndex = useCallback(
    (clientX: number, clientY: number): number => {
      const rows = lineRefs.current;
      let lineIdx = 0;
      let best = Infinity;
      rows.forEach((row, i) => {
        if (!row) return;
        const r = row.getBoundingClientRect();
        const d = Math.abs(clientY - (r.top + r.height / 2));
        if (d < best) {
          best = d;
          lineIdx = i;
        }
      });
      const row = rows[lineIdx];
      const rect = row?.getBoundingClientRect();
      const unitsX = rect ? (clientX - rect.left) / pxPerUnit : 0;
      const col = nearestCaretColumn(layouts[lineIdx]?.placed ?? [], unitsX);
      return lineColToIndex(lineIdx, col);
    },
    [layouts, pxPerUnit, lineColToIndex]
  );

  /** Click-to-position: overrides the browser's own (wrong) click placement with the real nearest glyph boundary. */
  const placeCaretAt = useCallback(
    (clientX: number, clientY: number) => {
      const el = inputRef.current;
      if (!el) return;
      const idx = pointToIndex(clientX, clientY);
      el.focus();
      el.setSelectionRange(idx, idx);
      syncFromSelection();
    },
    [pointToIndex, syncFromSelection]
  );

  const caretPxFor = useCallback(
    (pos: CaretPos | null) => {
      if (!pos) return null;
      const row = lineRefs.current[pos.line];
      const left = (row?.offsetLeft ?? 0) + caretX(layouts[pos.line]?.placed ?? [], pos.col) * pxPerUnit;
      const top = row?.offsetTop ?? 0;
      return { left, top, height: totalH * pxPerUnit };
    },
    [layouts, pxPerUnit, totalH]
  );

  return {
    inputRef,
    lineRefs,
    layouts,
    caret,
    setCaret,
    hasSelection,
    selectionStart,
    selectionEnd,
    pxPerUnit,
    totalH,
    syncFromSelection,
    placeCaretAt,
    pointToIndex,
    indexToLineCol,
    lineColToIndex,
    caretPxFor,
  };
}
