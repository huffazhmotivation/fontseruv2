import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Layers3, Redo2, RotateCcw, Type, Undo2, Zap } from "lucide-react";
import { NumericInput } from "@/components/NumericInput";
import { useAppStore } from "@/glyph/store";
import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import { GlyphRun } from "@/editor/GlyphRun";
import { caretX, fallbackAdvance, layoutLine, nearestCaretColumn, type LineLayout } from "@/editor/textLayout";
import { useTypingCaret } from "@/editor/useTypingCaret";
import { FONT_STYLES, fontStyleLabel, hasOutline, type FontStyle, type GlyphMap } from "@/types/glyph";
import {
  effectiveKerningPairs,
  kerningKey,
  type KerningContext,
  type KerningPairs,
} from "@/types/kerning";

type TestId = "type" | "upper" | "lower" | "numbers" | "punctuation" | "symbol" | "multilingual" | "kerning" | "pangram" | "paragraph" | "all";
type ActiveGlyph = {
  line: number;
  index: number;
  sourceIndex: number;
  char: string;
  leftChar: string | null;
  rightChar: string | null;
} | null;

const TESTS: { id: TestId; label: string }[] = [
  { id: "type", label: "Type Test" },
  { id: "upper", label: "Uppercase" },
  { id: "lower", label: "Lowercase" },
  { id: "numbers", label: "Numbers" },
  { id: "punctuation", label: "Punctuation" },
  { id: "symbol", label: "Symbol" },
  { id: "multilingual", label: "Multilingual" },
  { id: "kerning", label: "Kerning Pairs" },
  { id: "pangram", label: "Pangrams" },
  { id: "paragraph", label: "Paragraph" },
  { id: "all", label: "All Glyphs" },
];

const PUNCTUATION_TEST = (GLYPH_GROUPS.find((group) => group.id === "punct")?.chars ?? []).join(" ");
const SYMBOL_TEST = (GLYPH_GROUPS.find((group) => group.id === "symbols")?.chars ?? []).join(" ");
const ALL_GLYPHS_TEST = GLYPH_GROUPS.map((group) => group.chars.join("")).join("\n");
const KERNING_TEST_LINES = ["AV AV AV", "VA VA VA", "To To To", "Ta Ta Ta", "Ty Ty Ty", "WA WA WA", "Yo Yo Yo", "LT LT LT", "LY LY LY"];
const PANGRAM_LINES = [
  "The quick brown fox jumps over the lazy dog.",
  "Pack my box with five dozen liquor jugs.",
  "How vexingly quick daft zebras jump!",
];
const PARAGRAPH_LINES = [
  "FontSeru is a browser based type design workspace for drawing,",
  "spacing, and kerning a typeface from a blank canvas. Every letter",
  "you see in this paragraph is built from the vector data you drew",
  "yourself, not a system font standing in for the real thing.",
  "",
  "A typeface earns its keep in long-form text, not just in a single",
  "specimen word. Quick brown foxes, jackdaws, and sphinxes of black",
  "quartz all judge a vow at 12:45 on the 3rd of July, 2026 — numerals,",
  "punctuation, and letters sitting shoulder to shoulder on one line.",
  "",
  "Try switching Font Size, Line Height, and Tracking in the panel on",
  "the right; every adjustment here updates this exact paragraph live,",
  "using the same glyph geometry the canvas editor works with.",
];

function EditableStage({
  text,
  onTextChange,
  fontSize,
  lineHeight,
  tracking,
  align,
  activeGlyph,
  onActiveGlyphChange,
  focusNonce,
}: {
  text: string;
  onTextChange: (next: string) => void;
  fontSize: number;
  lineHeight: number;
  tracking: number;
  align: "left" | "center" | "right";
  activeGlyph: ActiveGlyph;
  onActiveGlyphChange: (next: ActiveGlyph) => void;
  focusNonce: number;
}) {
  const glyphs = useAppStore((s) => s.glyphs);
  const kerningPairs = useAppStore((s) => s.kerningPairs);
  const metrics = useAppStore((s) => s.metrics);
  const beginKerningDrag = useAppStore((s) => s.beginKerningDrag);
  const setKerningPairLive = useAppStore((s) => s.setKerningPairLive);
  const endKerningDrag = useAppStore((s) => s.endKerningDrag);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const rawPxPerUnit = fontSize / metrics.unitsPerEm;
  const maxWidthUnits = Math.max(
    1,
    (availableWidth || 720) / Math.max(rawPxPerUnit, 0.0001)
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setAvailableWidth(Math.max(1, el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const wrappedLines = useMemo(
    () =>
      wrapFamilyText(
        text,
        glyphs,
        metrics.unitsPerEm,
        kerningPairs,
        tracking,
        maxWidthUnits
      ),
    [text, glyphs, metrics.unitsPerEm, kerningPairs, tracking, maxWidthUnits]
  );
  const visualLines = useMemo(() => wrappedLines.map((line) => line.text), [wrappedLines]);
  const sourceLineStarts = useMemo(
    () => wrappedLines.map((line) => line.start),
    [wrappedLines]
  );

  const {
    inputRef,
    lineRefs,
    layouts,
    caret,
    hasSelection,
    selectionStart,
    selectionEnd,
    placeCaretAt,
    syncFromSelection,
    caretPxFor,
    pxPerUnit,
    totalH,
  } = useTypingCaret(visualLines, fontSize, tracking, sourceLineStarts);
  const caretPx = caretPxFor(caret);

  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    clientX: number;
    line: number;
    index: number;
    leftChar: string | null;
    char: string;
    rightChar: string | null;
    leftValue: number;
    rightValue: number;
  } | null>(null);

  const activeChar = activeGlyph?.char ?? null;
  const activeLeftChar = activeGlyph?.leftChar ?? null;
  const activeValue =
    activeLeftChar && activeChar ? kerningPairs[kerningKey(activeLeftChar, activeChar)] ?? 0 : 0;

  const beginGlyphDrag = (line: number, index: number, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const wrapped = wrappedLines[line];
    const placed = layouts[line]?.placed ?? [];
    const p = placed[index];
    if (!wrapped || !p) return;

    e.preventDefault();
    e.stopPropagation();

    const left = index > 0 ? placed[index - 1]?.char ?? null : null;
    const right = index < placed.length - 1 ? placed[index + 1]?.char ?? null : null;

    onActiveGlyphChange({
      line,
      index,
      sourceIndex: sourceIndexForGlyph(wrapped, index),
      char: p.char,
      leftChar: left,
      rightChar: right,
    });
    inputRef.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);

    const incoming = left ? kerningPairs[kerningKey(left, p.char)] ?? 0 : 0;
    const outgoing = right ? kerningPairs[kerningKey(p.char, right)] ?? 0 : 0;

    beginKerningDrag();
    setIsDragging(true);
    dragRef.current = {
      clientX: e.clientX,
      line,
      index,
      leftChar: left,
      char: p.char,
      rightChar: right,
      leftValue: incoming,
      rightValue: outgoing,
    };
  };

  const moveGlyph = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();

    const deltaUnits = Math.round((e.clientX - drag.clientX) / Math.max(pxPerUnit, 0.0001));
    if (drag.leftChar) {
      setKerningPairLive(drag.leftChar, drag.char, drag.leftValue + deltaUnits);
      if (drag.rightChar) {
        // Counter-adjust the outgoing pair so the next glyph stays pinned as
        // the active glyph moves relative to its neighboring reference.
        setKerningPairLive(drag.char, drag.rightChar, drag.rightValue - deltaUnits);
      }
    } else if (drag.rightChar) {
      // At the start of a line there is no incoming pair. The outgoing pair
      // remains the only meaningful kerning context.
      setKerningPairLive(drag.char, drag.rightChar, drag.rightValue - deltaUnits);
    }
  };

  const finishGlyphDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = null;
    setIsDragging(false);
    endKerningDrag();
    inputRef.current?.focus({ preventScroll: true });
  };

  const onStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isDragging) return;
    placeCaretAt(e.clientX, e.clientY);
  };

  // Keep the existing focus workflow when switching Test Lab presets/modes.
  useEffect(() => {
    if (focusNonce > 0) {
      inputRef.current?.focus({ preventScroll: true });
      requestAnimationFrame(syncFromSelection);
    }
  }, [focusNonce, inputRef, syncFromSelection]);

  return (
    <div
      ref={wrapRef}
      className="fm-lab-editable-wrap"
      onPointerUp={onStagePointerUp}
      style={{ alignItems: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center" }}
      data-testid="lab-editable-specimen"
      data-kern-dragging={isDragging ? "true" : "false"}
    >
      <div className="fm-lab-lines" aria-hidden="true">
        {wrappedLines.map((wrappedLine, lineIndex) => {
          const placed = layouts[lineIndex]?.placed ?? [];
          const rowActive =
            activeGlyph
              ? placed.findIndex(
                  (_, index) =>
                    sourceIndexForGlyph(wrappedLine, index) === activeGlyph.sourceIndex
                )
              : -1;
          const rowActivePlaced = rowActive >= 0 ? placed[rowActive] ?? null : null;
          const rowActiveLeftChar =
            rowActive > 0 ? placed[rowActive - 1]?.char ?? null : null;
          const rowActiveChar = rowActivePlaced?.char ?? null;
          const rowActiveValue =
            rowActiveLeftChar && rowActiveChar
              ? kerningPairs[kerningKey(rowActiveLeftChar, rowActiveChar)] ?? 0
              : 0;
          const zeroLeft = rowActivePlaced
            ? (rowActivePlaced.x - rowActiveValue) * pxPerUnit
            : 0;
          const liveLeft = rowActivePlaced ? rowActivePlaced.x * pxPerUnit : 0;
          const liveRight = rowActivePlaced
            ? (rowActivePlaced.x + rowActivePlaced.advance) * pxPerUnit
            : 0;
          const rowHeight = totalH * pxPerUnit;
          const selectionSpan =
            !isDragging && hasSelection
              ? selectionSpanForWrappedLine(
                  wrappedLine,
                  selectionStart,
                  selectionEnd,
                  pxPerUnit
                )
              : null;

          return (
            <div
              key={`${wrappedLine.start}-${lineIndex}`}
              className="fm-lab-glyph-row"
              ref={(el) => (lineRefs.current[lineIndex] = el)}
              style={{ marginBottom: lineIndex < wrappedLines.length - 1 ? fontSize * (lineHeight - 1) : 0 }}
              data-testid={`lab-line-${lineIndex}`}
            >
              <GlyphRun
                text={wrappedLine.text || " "}
                fontSizePx={fontSize}
                trackingUnits={tracking}
                colorForIndex={(index) =>
                  isDragging && rowActive === index ? "var(--accent)" : undefined
                }
              />

              {selectionSpan && (
                <div
                  className="fm-lab-selection-box"
                  style={{
                    left: selectionSpan.left,
                    top: 0,
                    width: selectionSpan.width,
                    height: rowHeight,
                  }}
                  data-testid={`lab-selection-${lineIndex}`}
                />
              )}

              {isDragging && rowActivePlaced && (
                <>
                  <div
                    className="fm-kern-active-box"
                    style={{
                      left: liveLeft,
                      top: 0,
                      width: Math.max(5, rowActivePlaced.advance * pxPerUnit),
                      height: rowHeight,
                    }}
                    data-testid="kern-active-glyph"
                    data-active-char={rowActiveChar ?? ""}
                  />
                  <div
                    className="fm-kern-ruler fm-kern-ruler-zero"
                    style={{ left: zeroLeft, top: -8, height: rowHeight + 16 }}
                    data-testid="kern-ruler-zero"
                  >
                    <span>0</span>
                  </div>
                  <div
                    className="fm-kern-ruler fm-kern-ruler-live"
                    style={{ left: liveLeft, top: -8, height: rowHeight + 16 }}
                    data-testid="kern-ruler-live"
                  >
                    <span data-testid="kern-live-value">
                      {rowActiveLeftChar ? `${rowActiveValue > 0 ? "+" : ""}${rowActiveValue}u` : "start"}
                    </span>
                  </div>
                  <div
                    className="fm-kern-ruler fm-kern-ruler-edge"
                    style={{ left: liveRight, top: -8, height: rowHeight + 16 }}
                    data-testid="kern-ruler-edge"
                  />
                </>
              )}

              {placed.map((p, index) => (
                <div
                  key={`${wrappedLine.start}-${lineIndex}-${index}`}
                  className={`fm-kern-glyph-hit ${
                    isDragging && rowActive === index ? "active" : ""
                  }`}
                  style={{
                    left: p.x * pxPerUnit,
                    top: 0,
                    width: Math.max(5, p.advance * pxPerUnit),
                    height: rowHeight,
                  }}
                  onPointerDown={(e) => beginGlyphDrag(lineIndex, index, e)}
                  onPointerMove={moveGlyph}
                  onPointerUp={finishGlyphDrag}
                  onPointerCancel={finishGlyphDrag}
                  onLostPointerCapture={finishGlyphDrag}
                  data-testid={`kern-glyph-${lineIndex}-${index}`}
                  data-kern-char={p.char}
                  aria-label={`Activate ${p.char} for contextual kerning`}
                  title={`Drag ${p.char} to adjust kerning`}
                />
              ))}
            </div>
          );
        })}

        {!hasSelection && caretPx && (
          <div
            className="fm-lab-caret"
            style={{ left: caretPx.left, top: caretPx.top, height: caretPx.height }}
            data-testid="lab-caret"
          />
        )}
      </div>

      <textarea
        ref={inputRef}
        className="fm-lab-stage-input"
        value={text}
        onChange={(e) => {
          onTextChange(e.target.value);
          requestAnimationFrame(syncFromSelection);
        }}
        onKeyDown={() => requestAnimationFrame(syncFromSelection)}
        onKeyUp={syncFromSelection}
        onFocus={syncFromSelection}
        onSelect={syncFromSelection}
        spellCheck={false}
        style={{ fontSize, lineHeight }}
        data-testid="lab-stage-input"
        aria-label="Editable FontSeru specimen"
        autoFocus
      />

      <span className="fm-sr-only" aria-live="polite">
        {activeGlyph && activeChar
          ? `${activeChar} active${isDragging ? `, kerning ${activeValue} units` : ""}`
          : ""}
      </span>
    </div>
  );
}


type FamilyActiveGlyph = {
  style: FontStyle;
  sourceIndex: number;
  char: string;
  leftChar: string | null;
  rightChar: string | null;
} | null;

interface WrappedFamilyLine {
  text: string;
  /** UTF-16 index into the shared textarea value. */
  start: number;
  /** UTF-16 index immediately after the final character on this visual line. */
  end: number;
  layout: LineLayout;
}

function codeUnitPrefixLength(text: string, glyphCount: number): number {
  return Array.from(text).slice(0, glyphCount).join("").length;
}

function sourceIndexForGlyph(line: WrappedFamilyLine, glyphIndex: number): number {
  return line.start + codeUnitPrefixLength(line.text, glyphIndex);
}

function selectionSpanForWrappedLine(
  line: WrappedFamilyLine,
  selectionStart: number,
  selectionEnd: number,
  pxPerUnit: number
): { left: number; width: number } | null {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  if (start === end || line.layout.placed.length === 0) return null;

  const chars = Array.from(line.text);
  let first = -1;
  let last = -1;

  for (let index = 0; index < chars.length; index++) {
    const glyphStart = sourceIndexForGlyph(line, index);
    const glyphEnd = glyphStart + chars[index].length;
    if (glyphEnd > start && glyphStart < end) {
      if (first < 0) first = index;
      last = index;
    }
  }

  if (first < 0 || last < 0) return null;
  const firstPlaced = line.layout.placed[first];
  const lastPlaced = line.layout.placed[last];
  if (!firstPlaced || !lastPlaced) return null;

  const left = firstPlaced.x * pxPerUnit;
  const right = (lastPlaced.x + lastPlaced.advance) * pxPerUnit;
  return { left, width: Math.max(2, right - left) };
}

/**
 * Soft-wrap against FontSeru's own glyph advances/kerning instead of browser
 * text metrics. Explicit newlines are preserved; soft wraps never become part
 * of the persisted/shared specimen text.
 */
function wrapFamilyText(
  text: string,
  glyphs: GlyphMap,
  unitsPerEm: number,
  kerningPairs: KerningPairs,
  tracking: number,
  maxWidthUnits: number
): WrappedFamilyLine[] {
  const out: WrappedFamilyLine[] = [];
  let chars: string[] = [];
  let lineStart = 0;
  let sourceIndex = 0;
  let advance = 0;

  const flush = (end: number) => {
    const lineText = chars.join("");
    out.push({
      text: lineText,
      start: lineStart,
      end,
      layout: layoutLine(lineText, glyphs, unitsPerEm, kerningPairs, tracking),
    });
    chars = [];
    advance = 0;
  };

  for (const ch of Array.from(text)) {
    const charStart = sourceIndex;
    sourceIndex += ch.length;

    if (ch === "\n") {
      flush(charStart);
      lineStart = sourceIndex;
      continue;
    }

    const glyphAdvance = glyphs[ch]?.advanceWidth ?? fallbackAdvance(ch, unitsPerEm);
    const previous = chars[chars.length - 1] ?? null;
    const between = previous ? tracking + (kerningPairs[kerningKey(previous, ch)] ?? 0) : 0;
    const nextAdvance = advance + between + glyphAdvance;

    if (chars.length > 0 && nextAdvance > maxWidthUnits) {
      flush(charStart);
      lineStart = charStart;
      chars.push(ch);
      advance = glyphAdvance;
    } else {
      chars.push(ch);
      advance = nextAdvance;
    }
  }

  flush(sourceIndex);
  return out.length
    ? out
    : [{ text: "", start: 0, end: 0, layout: layoutLine("", glyphs, unitsPerEm, kerningPairs, tracking) }];
}

function caretColumnForSourceIndex(line: WrappedFamilyLine, sourceIndex: number): number {
  const targetUnits = Math.max(0, sourceIndex - line.start);
  let consumed = 0;
  let col = 0;
  for (const ch of Array.from(line.text)) {
    if (consumed + ch.length > targetUnits) break;
    consumed += ch.length;
    col++;
  }
  return col;
}

function FamilyStylePreview({
  style,
  label,
  text,
  onTextChange,
  fontSize,
  lineHeight,
  tracking,
  align,
  glyphs,
  kerningPairs,
  kerningContext,
  onKerningContextChange,
  activeGlyph,
  onActiveGlyphChange,
  editable,
}: {
  style: FontStyle;
  label: string;
  text: string;
  onTextChange: (next: string) => void;
  fontSize: number;
  lineHeight: number;
  tracking: number;
  align: "left" | "center" | "right";
  glyphs: GlyphMap;
  kerningPairs: KerningPairs;
  kerningContext: KerningContext;
  onKerningContextChange: (next: KerningContext) => void;
  activeGlyph: FamilyActiveGlyph;
  onActiveGlyphChange: (next: FamilyActiveGlyph) => void;
  editable: boolean;
}) {
  const metrics = useAppStore((s) => s.metrics);
  const sharedPairs = useAppStore((s) => s.kerningPairs);
  const overridesByStyle = useAppStore((s) => s.kerningOverridesByStyle);
  const beginFamilyKerningDrag = useAppStore((s) => s.beginFamilyKerningDrag);
  const setFamilyKerningPairLive = useAppStore((s) => s.setFamilyKerningPairLive);
  const endFamilyKerningDrag = useAppStore((s) => s.endFamilyKerningDrag);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lineInnerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [caretIndex, setCaretIndex] = useState(0);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const hasSelection = selectionStart !== selectionEnd;
  const [isDragging, setIsDragging] = useState(false);

  const pxPerUnit = fontSize / metrics.unitsPerEm;
  const rowHeight = (metrics.ascender - metrics.descender) * pxPerUnit;
  const maxWidthUnits = Math.max(1, (availableWidth || 720) / Math.max(pxPerUnit, 0.0001));

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setAvailableWidth(Math.max(1, el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const wrappedLines = useMemo(
    () => wrapFamilyText(text, glyphs, metrics.unitsPerEm, kerningPairs, tracking, maxWidthUnits),
    [text, glyphs, metrics.unitsPerEm, kerningPairs, tracking, maxWidthUnits]
  );

  const syncCaretFromSelection = () => {
    if (!editable) return;
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    setCaretIndex(start);
    setSelectionStart(start);
    setSelectionEnd(end);
  };

  useEffect(() => {
    if (!editable) return;
    const el = inputRef.current;
    if (!el) return;
    if (document.activeElement === el) requestAnimationFrame(syncCaretFromSelection);
    // Recompute the custom caret after soft-wrap/layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, text, fontSize, lineHeight, tracking, availableWidth, kerningPairs]);

  const caretLocation = useMemo(() => {
    if (!editable || hasSelection || wrappedLines.length === 0) return null;
    const clamped = Math.max(0, Math.min(text.length, caretIndex));
    let lineIndex = 0;
    for (let i = 0; i < wrappedLines.length; i++) {
      if (clamped >= wrappedLines[i].start) lineIndex = i;
      else break;
    }
    const line = wrappedLines[lineIndex];
    return {
      lineIndex,
      col: caretColumnForSourceIndex(line, clamped),
    };
  }, [editable, hasSelection, wrappedLines, text.length, caretIndex]);

  const dragRef = useRef<{
    clientX: number;
    context: KerningContext;
    leftChar: string | null;
    char: string;
    rightChar: string | null;
    leftValue: number;
    rightValue: number;
  } | null>(null);

  const beginGlyphDrag = (
    lineIndex: number,
    index: number,
    e: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (e.button !== 0) return;
    const line = wrappedLines[lineIndex];
    const placed = line?.layout.placed ?? [];
    const p = placed[index];
    if (!line || !p) return;

    e.preventDefault();
    e.stopPropagation();

    const left = index > 0 ? placed[index - 1]?.char ?? null : null;
    const right = index < placed.length - 1 ? placed[index + 1]?.char ?? null : null;
    const targetContext: KerningContext = kerningContext === "shared" ? "shared" : style;
    if (kerningContext !== "shared" && kerningContext !== style) onKerningContextChange(style);

    const targetPairs =
      targetContext === "shared"
        ? sharedPairs
        : effectiveKerningPairs(sharedPairs, overridesByStyle, style);

    const incoming = left ? targetPairs[kerningKey(left, p.char)] ?? 0 : 0;
    const outgoing = right ? targetPairs[kerningKey(p.char, right)] ?? 0 : 0;

    onActiveGlyphChange({
      style,
      sourceIndex: sourceIndexForGlyph(line, index),
      char: p.char,
      leftChar: left,
      rightChar: right,
    });
    inputRef.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);

    beginFamilyKerningDrag(targetContext);
    setIsDragging(true);
    dragRef.current = {
      clientX: e.clientX,
      context: targetContext,
      leftChar: left,
      char: p.char,
      rightChar: right,
      leftValue: incoming,
      rightValue: outgoing,
    };
  };

  const moveGlyph = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();

    const deltaUnits = Math.round((e.clientX - drag.clientX) / Math.max(pxPerUnit, 0.0001));
    if (drag.leftChar) {
      setFamilyKerningPairLive(drag.context, drag.leftChar, drag.char, drag.leftValue + deltaUnits);
      if (drag.rightChar) {
        setFamilyKerningPairLive(drag.context, drag.char, drag.rightChar, drag.rightValue - deltaUnits);
      }
    } else if (drag.rightChar) {
      setFamilyKerningPairLive(drag.context, drag.char, drag.rightChar, drag.rightValue - deltaUnits);
    }
  };

  const finishGlyphDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = null;
    setIsDragging(false);
    endFamilyKerningDrag();
    inputRef.current?.focus({ preventScroll: true });
  };

  const placeCaretAt = (clientX: number, clientY: number) => {
    if (!editable) return;
    const el = inputRef.current;
    if (!el) return;

    let lineIndex = 0;
    let bestDistance = Infinity;
    lineInnerRefs.current.forEach((inner, index) => {
      if (!inner) return;
      const rect = inner.getBoundingClientRect();
      const distance = Math.abs(clientY - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        lineIndex = index;
      }
    });

    const line = wrappedLines[lineIndex];
    const inner = lineInnerRefs.current[lineIndex];
    if (!line || !inner) return;
    const rect = inner.getBoundingClientRect();
    const unitsX = (clientX - rect.left) / Math.max(pxPerUnit, 0.0001);
    const col = nearestCaretColumn(line.layout.placed, unitsX);
    const sourceIndex = line.start + codeUnitPrefixLength(line.text, col);
    el.focus({ preventScroll: true });
    el.setSelectionRange(sourceIndex, sourceIndex);
    setCaretIndex(sourceIndex);
    setSelectionStart(sourceIndex);
    setSelectionEnd(sourceIndex);
  };

  return (
    <section
      className={`fm-family-style-row ${editable ? "editable" : ""} ${
        kerningContext !== "shared" && kerningContext === style ? "context-active" : ""
      }`}
      data-testid={`family-style-${style}`}
    >
      <div className="fm-family-style-label">
        <span>{label}</span>
        {editable && <small>TYPE HERE</small>}
      </div>

      <div
        ref={bodyRef}
        className="fm-family-style-body"
        onPointerUp={(e) => {
          if (!isDragging) placeCaretAt(e.clientX, e.clientY);
        }}
        onPointerDown={() => {
          if (editable) inputRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="fm-family-lines" aria-hidden="true">
          {wrappedLines.map((line, lineIndex) => {
            const placed = line.layout.placed;
            const activeIndex =
              activeGlyph?.style === style
                ? placed.findIndex(
                    (_, index) => sourceIndexForGlyph(line, index) === activeGlyph.sourceIndex
                  )
                : -1;
            const activePlaced = activeIndex >= 0 ? placed[activeIndex] : null;
            const activeLeftChar =
              activeIndex > 0 ? placed[activeIndex - 1]?.char ?? null : null;
            const activeChar = activePlaced?.char ?? null;
            const activeValue =
              activeLeftChar && activeChar
                ? kerningPairs[kerningKey(activeLeftChar, activeChar)] ?? 0
                : 0;
            const zeroLeft = activePlaced
              ? (activePlaced.x - activeValue) * pxPerUnit
              : 0;
            const liveLeft = activePlaced ? activePlaced.x * pxPerUnit : 0;
            const liveRight = activePlaced
              ? (activePlaced.x + activePlaced.advance) * pxPerUnit
              : 0;
            const lineWidth = Math.max(1, line.layout.totalAdvance * pxPerUnit);
            const selectionSpan =
              editable && !isDragging && hasSelection
                ? selectionSpanForWrappedLine(line, selectionStart, selectionEnd, pxPerUnit)
                : null;

            return (
              <div
                key={`${line.start}-${lineIndex}`}
                className="fm-family-preview-line"
                style={{
                  justifyContent:
                    align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
                  marginBottom:
                    lineIndex < wrappedLines.length - 1
                      ? fontSize * (lineHeight - 1)
                      : 0,
                }}
              >
                <div
                  ref={(el) => (lineInnerRefs.current[lineIndex] = el)}
                  className="fm-family-line-inner"
                  style={{ width: lineWidth, height: rowHeight }}
                >
                  <GlyphRun
                    text={line.text || " "}
                    fontSizePx={fontSize}
                    trackingUnits={tracking}
                    glyphsOverride={glyphs}
                    kerningPairsOverride={kerningPairs}
                    colorForIndex={(index) =>
                      isDragging && activeIndex === index ? "var(--accent)" : undefined
                    }
                  />

                  {selectionSpan && (
                    <div
                      className="fm-lab-selection-box"
                      style={{
                        left: selectionSpan.left,
                        top: 0,
                        width: selectionSpan.width,
                        height: rowHeight,
                      }}
                      data-testid={`family-selection-${lineIndex}`}
                    />
                  )}

                  {isDragging && activePlaced && (
                    <>
                      <div
                        className="fm-kern-active-box dragging"
                        style={{
                          left: liveLeft,
                          top: 0,
                          width: Math.max(5, activePlaced.advance * pxPerUnit),
                          height: rowHeight,
                        }}
                        data-testid="family-kern-active-glyph"
                      />
                      <div
                        className="fm-kern-ruler fm-kern-ruler-zero"
                        style={{ left: zeroLeft, top: -7, height: rowHeight + 14 }}
                      >
                        <span>0</span>
                      </div>
                      <div
                        className="fm-kern-ruler fm-kern-ruler-live"
                        style={{ left: liveLeft, top: -7, height: rowHeight + 14 }}
                      >
                        <span>
                          {activeLeftChar
                            ? `${activeValue > 0 ? "+" : ""}${activeValue}u`
                            : "start"}
                        </span>
                      </div>
                      <div
                        className="fm-kern-ruler fm-kern-ruler-edge"
                        style={{ left: liveRight, top: -7, height: rowHeight + 14 }}
                      />
                    </>
                  )}

                  {placed.map((p, index) => (
                    <div
                      key={`${line.start}-${index}`}
                      className={`fm-kern-glyph-hit ${
                        isDragging && activeIndex === index ? "active" : ""
                      }`}
                      style={{
                        left: p.x * pxPerUnit,
                        top: 0,
                        width: Math.max(5, p.advance * pxPerUnit),
                        height: rowHeight,
                      }}
                      onPointerDown={(e) => beginGlyphDrag(lineIndex, index, e)}
                      onPointerMove={moveGlyph}
                      onPointerUp={finishGlyphDrag}
                      onPointerCancel={finishGlyphDrag}
                      onLostPointerCapture={finishGlyphDrag}
                      data-testid={`family-kern-glyph-${style}-${lineIndex}-${index}`}
                      data-kern-char={p.char}
                      aria-label={`Activate ${p.char} in ${label} for contextual kerning`}
                      title={`Drag ${p.char} to adjust ${kerningContext === "shared" ? "Shared" : label} kerning`}
                    />
                  ))}

                  {editable &&
                    caretLocation?.lineIndex === lineIndex &&
                    !hasSelection && (
                      <div
                        className="fm-lab-caret fm-family-caret"
                        style={{
                          left: caretX(line.layout.placed, caretLocation.col) * pxPerUnit,
                          top: 0,
                          height: rowHeight,
                        }}
                        data-testid="family-lab-caret"
                      />
                    )}
                </div>
              </div>
            );
          })}
        </div>

        {editable && (
          <textarea
            ref={inputRef}
            className="fm-family-stage-input"
            value={text}
            onChange={(e) => {
              onTextChange(e.target.value);
              requestAnimationFrame(syncCaretFromSelection);
            }}
            onKeyDown={() => requestAnimationFrame(syncCaretFromSelection)}
            onKeyUp={syncCaretFromSelection}
            onFocus={syncCaretFromSelection}
            onSelect={syncCaretFromSelection}
            spellCheck={false}
            data-testid="family-regular-input"
            aria-label="Editable Regular family specimen"
            autoFocus
          />
        )}
      </div>
    </section>
  );
}

function FamilyPreview({
  text,
  onTextChange,
  fontSize,
  lineHeight,
  tracking,
  align,
  kerningContext,
  onKerningContextChange,
  activeGlyph,
  onActiveGlyphChange,
}: {
  text: string;
  onTextChange: (next: string) => void;
  fontSize: number;
  lineHeight: number;
  tracking: number;
  align: "left" | "center" | "right";
  kerningContext: KerningContext;
  onKerningContextChange: (next: KerningContext) => void;
  activeGlyph: FamilyActiveGlyph;
  onActiveGlyphChange: (next: FamilyActiveGlyph) => void;
}) {
  const glyphsByStyle = useAppStore((s) => s.glyphsByStyle);
  const sharedPairs = useAppStore((s) => s.kerningPairs);
  const overridesByStyle = useAppStore((s) => s.kerningOverridesByStyle);

  return (
    <div className="fm-family-preview" data-testid="family-preview">
      {FONT_STYLES.map(({ id, label }) => (
        <FamilyStylePreview
          key={id}
          style={id}
          label={label}
          text={text}
          onTextChange={onTextChange}
          fontSize={fontSize}
          lineHeight={lineHeight}
          tracking={tracking}
          align={align}
          glyphs={glyphsByStyle[id]}
          kerningPairs={effectiveKerningPairs(sharedPairs, overridesByStyle, id)}
          kerningContext={kerningContext}
          onKerningContextChange={onKerningContextChange}
          activeGlyph={activeGlyph}
          onActiveGlyphChange={onActiveGlyphChange}
          editable={id === "regular"}
        />
      ))}
    </div>
  );
}

export function SpecimenPanel() {
  const glyphs = useAppStore((s) => s.glyphs);
  const kerningPairs = useAppStore((s) => s.kerningPairs);
  const kerningOverridesByStyle = useAppStore((s) => s.kerningOverridesByStyle);
  const autoKernLastRun = useAppStore((s) => s.autoKernLastRun);
  const setKerningPair = useAppStore((s) => s.setKerningPair);
  const resetKerningPair = useAppStore((s) => s.resetKerningPair);
  const autoKernAllPairs = useAppStore((s) => s.autoKernAllPairs);
  const setFamilyKerningPair = useAppStore((s) => s.setFamilyKerningPair);
  const resetFamilyKerningPair = useAppStore((s) => s.resetFamilyKerningPair);
  const autoKernAllPairsForContext = useAppStore((s) => s.autoKernAllPairsForContext);
  // Same global history stack the top bar's Undo/Redo use — kerning edits
  // (drag or precision input, single or family) already push onto it, so
  // this is a real undo/redo of "kerning yang habis diatur", just surfaced
  // right where the kerning value is being edited instead of only in the
  // top bar.
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const canUndo = useAppStore((s) => s.past.length > 0);
  const canRedo = useAppStore((s) => s.future.length > 0);

  const [test, setTest] = useState<TestId>("type");
  const [text, setText] = useState("");
  const [fontSize, setFontSize] = useState(72);
  const [lineHeight, setLineHeight] = useState(1.4);
  const [tracking, setTracking] = useState(0);
  const [align, setAlign] = useState<"left" | "center" | "right">("left");
  // Defaults to whatever the app's global theme is at the moment Test Lab
  // opens (dark app -> dark specimen bg, light app -> light specimen bg),
  // but stays a fully independent, manually-toggleable choice afterward —
  // it does not keep following the global theme if the user switches it
  // later, and does not write back to the global theme either.
  const [bg, setBg] = useState<"dark" | "light">(() => useAppStore.getState().theme);
  const [activeGlyph, setActiveGlyph] = useState<ActiveGlyph>(null);
  const [familyActiveGlyph, setFamilyActiveGlyph] = useState<FamilyActiveGlyph>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [kerningMode, setKerningMode] = useState<"single" | "family">("single");
  const [familyContext, setFamilyContext] = useState<KerningContext>("shared");

  // Unlike the other presets (fixed strings), Multilingual reflects
  // whatever the font actually has right now: every "multilingual"
  // category glyph that's been drawn or composed via "+ Multilingual
  // Glyphs", sorted by Unicode code point.
  const multilingualText = useMemo(
    () =>
      Object.values(glyphs)
        .filter((g) => g.category === "multilingual" && hasOutline(g))
        .sort((a, b) => a.unicode - b.unicode)
        .map((g) => g.char)
        .join(" "),
    [glyphs]
  );

  const presetText = (id: TestId): string | null => {
    switch (id) {
      case "type": return "";
      case "upper": return "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      case "lower": return "abcdefghijklmnopqrstuvwxyz";
      case "numbers": return "0123456789";
      case "punctuation": return PUNCTUATION_TEST;
      case "symbol": return SYMBOL_TEST;
      case "multilingual": return multilingualText || "Draw or compose multilingual glyphs first.";
      case "kerning": return KERNING_TEST_LINES.join("\n");
      case "pangram": return PANGRAM_LINES.join("\n");
      case "paragraph": return PARAGRAPH_LINES.join("\n");
      case "all": return ALL_GLYPHS_TEST;
      default: return "";
    }
  };

  const selectTest = (id: TestId) => {
    setTest(id);
    setActiveGlyph(null);
    setFamilyActiveGlyph(null);
    setText(presetText(id) ?? "");
    setFocusNonce((n) => n + 1);
  };

  // ---------------------------- Existing Single Test derivation
  // The active glyph now carries its visual-line context so soft wrapping can
  // stay purely presentational without inserting newlines into specimen text.
  const activeChar = activeGlyph?.char ?? null;
  const leftChar = activeGlyph?.leftChar ?? null;
  const rightChar = activeGlyph?.rightChar ?? null;

  const precisionLeft = leftChar ?? activeChar;
  const precisionRight = leftChar ? activeChar : rightChar;
  const hasPrecisionPair = Boolean(precisionLeft && precisionRight);
  const precisionValue =
    precisionLeft && precisionRight
      ? kerningPairs[kerningKey(precisionLeft, precisionRight)] ?? 0
      : 0;

  const resetActiveContext = () => {
    if (leftChar && activeChar) resetKerningPair(leftChar, activeChar);
    if (activeChar && rightChar) resetKerningPair(activeChar, rightChar);
  };

  // ---------------------------- Family Test layered kerning derivation
  const familyPrecisionLeft = familyActiveGlyph?.leftChar ?? familyActiveGlyph?.char ?? null;
  const familyPrecisionRight = familyActiveGlyph?.leftChar
    ? familyActiveGlyph.char
    : familyActiveGlyph?.rightChar ?? null;
  const hasFamilyPrecisionPair = Boolean(familyPrecisionLeft && familyPrecisionRight);
  const familyPairKey =
    familyPrecisionLeft && familyPrecisionRight
      ? kerningKey(familyPrecisionLeft, familyPrecisionRight)
      : null;
  const familyContextOverride =
    familyContext === "shared" ? undefined : kerningOverridesByStyle[familyContext];
  const familyHasOverride = Boolean(
    familyContext !== "shared" &&
      familyPairKey &&
      familyContextOverride &&
      familyPairKey in familyContextOverride
  );
  const familyPrecisionValue = familyPairKey
    ? familyContext === "shared"
      ? kerningPairs[familyPairKey] ?? 0
      : familyContextOverride?.[familyPairKey] ?? kerningPairs[familyPairKey] ?? 0
    : 0;

  const panelHasPair = kerningMode === "single" ? hasPrecisionPair : hasFamilyPrecisionPair;
  const panelLeft = kerningMode === "single" ? precisionLeft : familyPrecisionLeft;
  const panelRight = kerningMode === "single" ? precisionRight : familyPrecisionRight;

  const resetFamilyActivePair = () => {
    if (!familyPrecisionLeft || !familyPrecisionRight) return;
    resetFamilyKerningPair(familyContext, familyPrecisionLeft, familyPrecisionRight);
  };

  const onFamilyActiveGlyphChange = (next: FamilyActiveGlyph) => {
    setFamilyActiveGlyph(next);
    if (next && familyContext !== "shared" && familyContext !== next.style) {
      setFamilyContext(next.style);
    }
  };

  return (
    <div className="fm-lab-grid">
      <div className="fm-lab-main">
        <div className="fm-lab-test-row" aria-label="Preview presets">
          {TESTS.map((t) => (
            <button
              key={t.id}
              className={`fm-lab-test-btn ${test === t.id ? "active" : ""}`}
              onClick={() => selectTest(t.id)}
              data-testid={`lab-test-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {kerningMode === "single" ? (
          <div className={`fm-lab-stage ${bg}`} data-testid="lab-stage">
            <EditableStage
              text={text}
              onTextChange={(next) => {
                setText(next);
                setTest("type");
                // Typing can change soft-wrap boundaries, so discard the old
                // visual glyph anchor while leaving kerning data untouched.
                setActiveGlyph(null);
              }}
              fontSize={fontSize}
              lineHeight={lineHeight}
              tracking={tracking}
              align={align}
              activeGlyph={activeGlyph}
              onActiveGlyphChange={setActiveGlyph}
              focusNonce={focusNonce}
            />
          </div>
        ) : (
          <div
            className={`fm-lab-stage fm-family-stage ${bg}`}
            data-testid="family-lab-stage"
          >
            <FamilyPreview
              text={text}
              onTextChange={(next) => {
                setText(next);
                setTest("type");
                setFamilyActiveGlyph(null);
              }}
              fontSize={fontSize}
              lineHeight={lineHeight}
              tracking={tracking}
              align={align}
              kerningContext={familyContext}
              onKerningContextChange={setFamilyContext}
              activeGlyph={familyActiveGlyph}
              onActiveGlyphChange={onFamilyActiveGlyphChange}
            />
          </div>
        )}
      </div>

      <div className="fm-lab-side" data-testid="lab-right-panel">
        <div className="fm-lab-side-section" data-testid="lab-kerning-panel">
          <div className="fm-section-title">Kerning</div>

          <div className="fm-kern-context" data-testid="kern-active-context">
            {kerningMode === "single" ? (
              activeChar
                ? `${leftChar ?? "·"} ${activeChar} ${rightChar ?? "·"}`
                : "Click and drag one glyph"
            ) : familyActiveGlyph ? (
              <>
                <span className="fm-kern-context-style">
                  {fontStyleLabel(familyActiveGlyph.style)}
                </span>
                <span>
                  {familyActiveGlyph.leftChar ?? "·"} {familyActiveGlyph.char}{" "}
                  {familyActiveGlyph.rightChar ?? "·"}
                </span>
              </>
            ) : (
              "Click and drag a family glyph"
            )}
          </div>

          <div className="fm-field fm-kern-precision">
            <label>
              {panelHasPair && panelLeft && panelRight
                ? `Kerning ${panelLeft}${panelRight}`
                : "Kerning value"}
              {kerningMode === "family" &&
                panelHasPair &&
                familyContext !== "shared" && (
                  <span className={`fm-kern-layer-hint ${familyHasOverride ? "override" : "inherited"}`}>
                    {familyHasOverride ? "Override" : "Inherited"}
                  </span>
                )}
            </label>
            <div className="fm-kern-value-row">
              <NumericInput
                value={
                  kerningMode === "single"
                    ? hasPrecisionPair
                      ? precisionValue
                      : 0
                    : hasFamilyPrecisionPair
                      ? familyPrecisionValue
                      : 0
                }
                disabled={!panelHasPair}
                onChange={(value) => {
                  if (kerningMode === "single") {
                    if (precisionLeft && precisionRight) {
                      setKerningPair(precisionLeft, precisionRight, value);
                    }
                  } else if (familyPrecisionLeft && familyPrecisionRight) {
                    setFamilyKerningPair(
                      familyContext,
                      familyPrecisionLeft,
                      familyPrecisionRight,
                      value
                    );
                  }
                }}
                data-testid="kern-value-input"
              />
              <span className="fm-kern-history-btns">
                <button
                  type="button"
                  disabled={!canUndo}
                  onClick={undo}
                  title="Undo kerning (Cmd/Ctrl+Z)"
                  data-testid="kern-undo-btn"
                >
                  <Undo2 size={13} />
                </button>
                <button
                  type="button"
                  disabled={!canRedo}
                  onClick={redo}
                  title="Redo kerning (Cmd/Ctrl+Shift+Z)"
                  data-testid="kern-redo-btn"
                >
                  <Redo2 size={13} />
                </button>
              </span>
            </div>
          </div>

          <div className="fm-kern-mode-toggle" data-testid="kern-test-mode">
            <button
              className={kerningMode === "single" ? "active" : ""}
              onClick={() => setKerningMode("single")}
              data-testid="kern-single-test"
            >
              <Type size={14} /> Single Test
            </button>
            <button
              className={kerningMode === "family" ? "active" : ""}
              onClick={() => setKerningMode("family")}
              data-testid="kern-family-test"
            >
              <Layers3 size={14} /> Family Test
            </button>
          </div>

          {kerningMode === "family" && (
            <div className="fm-field fm-kern-layer-field">
              <label>Kerning Context</label>
              <select
                value={familyContext}
                onChange={(e) => setFamilyContext(e.target.value as KerningContext)}
                data-testid="family-kern-context"
              >
                <option value="shared">Shared</option>
                {FONT_STYLES.map(({ id, label }) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
              <div className="fm-kern-layer-note">
                {familyContext === "shared"
                  ? "Shared values flow to every style without an override."
                  : `${fontStyleLabel(familyContext)} edits stay in its sparse override layer.`}
              </div>
            </div>
          )}

          <div className="fm-kern-side-actions">
            <button
              className="fm-action-btn accent"
              onClick={
                kerningMode === "single"
                  ? autoKernAllPairs
                  : () => autoKernAllPairsForContext(familyContext)
              }
              data-testid="kern-auto-common"
            >
              <Zap className="fm-auto-kern-icon" size={14} strokeWidth={2} aria-hidden="true" /> Auto Kerning
            </button>
            <button
              className="fm-action-btn fm-kern-reset-btn"
              disabled={
                kerningMode === "single"
                  ? !activeChar
                  : !hasFamilyPrecisionPair ||
                    (familyContext === "shared"
                      ? !familyPairKey || !(familyPairKey in kerningPairs)
                      : !familyHasOverride)
              }
              onClick={kerningMode === "single" ? resetActiveContext : resetFamilyActivePair}
              data-testid={kerningMode === "single" ? "kern-reset-pair" : "kern-reset-family"}
            >
              <RotateCcw size={14} />{" "}
              {kerningMode === "single"
                ? "Reset"
                : familyContext === "shared"
                  ? "Reset Shared"
                  : "Reset Override"}
            </button>
          </div>

          {autoKernLastRun && (
            <div className="fm-kern-complete" role="status" data-testid="kern-auto-complete">
              <span className="fm-status-dot" />
              {autoKernLastRun.processed} pairs · {autoKernLastRun.updated} updated
              {autoKernLastRun.preservedManual > 0
                ? ` · ${autoKernLastRun.preservedManual} manual kept`
                : ""}
            </div>
          )}
        </div>

        <div className="fm-lab-side-section">
          <div className="fm-section-title">Specimen</div>
          <div className="fm-field">
            <div className="fm-slider-row-label"><label>Font Size</label><span>{fontSize}px</span></div>
            <input type="range" min={16} max={280} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} data-testid="lab-fontsize" />
          </div>
          <div className="fm-field">
            <div className="fm-slider-row-label"><label>Line Height</label><span>{lineHeight.toFixed(2)}×</span></div>
            <input type="range" min={1} max={2.5} step={0.05} value={lineHeight} onChange={(e) => setLineHeight(Number(e.target.value))} data-testid="lab-lineheight" />
          </div>
          <div className="fm-field">
            <div className="fm-slider-row-label"><label>Tracking</label><span>{tracking}u</span></div>
            <input type="range" min={-60} max={200} value={tracking} onChange={(e) => setTracking(Number(e.target.value))} data-testid="lab-tracking" />
          </div>
          <div className="fm-field">
            <label>Alignment</label>
            <div className="fm-tab-select" data-testid="lab-align">
              <button className={align === "left" ? "active" : ""} onClick={() => setAlign("left")}>Left</button>
              <button className={align === "center" ? "active" : ""} onClick={() => setAlign("center")}>Center</button>
              <button className={align === "right" ? "active" : ""} onClick={() => setAlign("right")}>Right</button>
            </div>
          </div>
          <div className="fm-field">
            <label>Preview Background</label>
            <div className="fm-tab-select" data-testid="lab-bg">
              <button className={bg === "dark" ? "active" : ""} onClick={() => setBg("dark")}>Dark</button>
              <button className={bg === "light" ? "active" : ""} onClick={() => setBg("light")}>Light</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
