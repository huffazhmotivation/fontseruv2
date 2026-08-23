import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import { FileCode2, ImagePlus, Layers, Loader2, RefreshCw, Wand2, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import { hasOutline } from "@/types/glyph";
import type { Glyph, GlyphMap } from "@/types/glyph";
import { unicodeHex } from "@/utils/unicode";
import { GlyphThumbnail } from "@/components/GlyphThumbnail";
import { Slider } from "@/components/RightPanel";
import { Toast, type ToastMessage } from "@/components/Toast";
import type { FontMetrics } from "@/types/font";
import type { VectorObject } from "@/types/geometry";
import {
  DEFAULT_TRACE_SETTINGS,
  TraceError,
  fitTracedObjectsToGlyph,
  tracedObjectFillPath,
  traceImageFile,
  type TraceDetail,
  type TraceLetterGroup,
  type TraceSettings,
} from "@/trace/imageTrace";
import { SvgImportError, importSvgFile } from "@/trace/svgImport";

/** Debounce delay before the left-panel live preview re-traces after the image, threshold, detail, or invert setting changes — long enough to not re-run on every slider tick, short enough to feel live. */
const LIVE_PREVIEW_DEBOUNCE_MS = 350;

const IMAGE_TYPE_RE = /^image\/(png|jpe?g)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g)$/i;

const SVG_TYPE_RE = /^image\/svg\+xml$/i;
const SVG_EXT_RE = /\.svg$/i;

/** Fixed preview advance width for per-letter result thumbnails — GlyphThumbnail sizes itself from the outline's own bounds, so this only needs to be a stable, reasonable value. */
const PREVIEW_ADVANCE = 600;

/**
 * Same grouping the main GlyphNav uses (base categories in order, plus any
 * imported extras) — kept as a local copy rather than importing from
 * GlyphNav so this overlay never risks touching that file's behavior. Only
 * difference: no search-query filter, since this panel is a fixed target
 * list, not a searchable nav.
 */
function groupRegularGlyphs(glyphs: GlyphMap) {
  const baseChars = new Set(GLYPH_GROUPS.flatMap((g) => g.chars));
  const extrasByCategory = new Map<string, string[]>();
  for (const [ch, glyph] of Object.entries(glyphs)) {
    if (baseChars.has(ch)) continue;
    const arr = extrasByCategory.get(glyph.category) ?? [];
    arr.push(ch);
    extrasByCategory.set(glyph.category, arr);
  }
  const groups = GLYPH_GROUPS.map((g) => ({
    ...g,
    chars: [
      ...g.chars.filter((ch) => Boolean(glyphs[ch])),
      ...(extrasByCategory.get(g.id) ?? []).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode),
    ],
  })).filter((g) => g.chars.length > 0);
  const assigned = new Set(groups.flatMap((g) => g.chars));
  const remaining = Object.keys(glyphs)
    .filter((ch) => !assigned.has(ch))
    .sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
  return remaining.length ? [...groups, { id: "symbols" as const, label: "Imported", chars: remaining }] : groups;
}

function isImageFile(file: File): boolean {
  return IMAGE_TYPE_RE.test(file.type) || IMAGE_EXT_RE.test(file.name);
}

function isSvgFile(file: File): boolean {
  return SVG_TYPE_RE.test(file.type) || SVG_EXT_RE.test(file.name);
}

/** Builds a throwaway preview Glyph wrapping a flat list of traced objects, purely so GlyphThumbnail can render it. */
function objectsPreviewGlyph(objects: VectorObject[], metrics: FontMetrics): Glyph {
  const outline = fitTracedObjectsToGlyph(objects, metrics, PREVIEW_ADVANCE);
  return {
    char: "",
    unicode: 0,
    category: "symbols",
    advanceWidth: PREVIEW_ADVANCE,
    lsb: 0,
    rsb: 0,
    outline,
    components: [],
  };
}

/** Builds a throwaway preview Glyph wrapping one letter group's traced objects, purely so GlyphThumbnail can render it. */
function letterPreviewGlyph(group: TraceLetterGroup, metrics: FontMetrics): Glyph {
  return objectsPreviewGlyph(group.objects, metrics);
}

export function TraceImageOverlay() {
  const open = useAppStore((s) => s.traceOpen);
  const close = useAppStore((s) => s.closeTrace);
  const metrics = useAppStore((s) => s.metrics);
  const regularGlyphs = useAppStore((s) => s.glyphsByStyle.regular);
  const commitTracedGlyphOutline = useAppStore((s) => s.commitTracedGlyphOutline);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const svgFileInputRef = useRef<HTMLInputElement>(null);
  const toastId = useRef(0);
  const [isImportingSvg, setIsImportingSvg] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<TraceSettings>(DEFAULT_TRACE_SETTINGS);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isTracing, setIsTracing] = useState(false);
  const [letterGroups, setLetterGroups] = useState<TraceLetterGroup[] | null>(null);
  const [traceCanvasSize, setTraceCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [selectedLetterId, setSelectedLetterId] = useState<string | null>(null);
  const [draggingLetterId, setDraggingLetterId] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [appliedFlash, setAppliedFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  // Hover-to-zoom magnifier lens over the "Preview Hasil Trace" box — lets
  // the user inspect fine detail of the auto-generated preview shape before
  // committing to the full trace. Content is vector (SVG via GlyphThumbnail),
  // so the lens works by rendering a second, transform-scaled copy clipped
  // to a small circular window that follows the cursor, rather than panning
  // a raster background image.
  const livePreviewBoxRef = useRef<HTMLDivElement>(null);
  const [tracePreviewMagnifier, setTracePreviewMagnifier] = useState<{ mx: number; my: number; w: number; h: number } | null>(null);
  const TRACE_PREVIEW_ZOOM = 6;
  const TRACE_PREVIEW_LENS_SIZE = 190;

  function handleTracePreviewMouseMove(e: MouseEvent<HTMLDivElement>) {
    const box = livePreviewBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
      setTracePreviewMagnifier(null);
      return;
    }
    setTracePreviewMagnifier({ mx, my, w: rect.width, h: rect.height });
  }

  // Quick, automatic preview of the whole traced image — updates on a short
  // debounce whenever the source image or trace settings change, so the
  // user can compare against the upload before ever pressing "Trace Image".
  // Kept fully separate from `letterGroups`/`traceCanvasSize`: those are
  // only (re)committed when the user explicitly presses the button.
  const [livePreviewObjects, setLivePreviewObjects] = useState<VectorObject[] | null>(null);
  const [livePreviewLoading, setLivePreviewLoading] = useState(false);

  const showToast = useCallback((message: string, kind: ToastMessage["kind"] = "success") => {
    setToast({ id: ++toastId.current, kind, message });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const groups = useMemo(() => groupRegularGlyphs(regularGlyphs), [regularGlyphs]);

  // Small render-only Glyph wrappers per detected letter, rebuilt whenever
  // the trace result or font metrics change. Kept separate from the raw
  // TraceLetterGroup data so re-fitting for preview never touches the
  // pixel-space objects that get applied to a real glyph.
  const letterPreviews = useMemo(() => {
    const map = new Map<string, Glyph>();
    if (!letterGroups) return map;
    for (const g of letterGroups) map.set(g.id, letterPreviewGlyph(g, metrics));
    return map;
  }, [letterGroups, metrics]);

  const selectedGroup = useMemo(
    () => (selectedLetterId ? letterGroups?.find((g) => g.id === selectedLetterId) ?? null : null),
    [letterGroups, selectedLetterId]
  );
  const selectedPreviewGlyph = selectedLetterId ? letterPreviews.get(selectedLetterId) ?? null : null;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Revoke the previous preview's object URL whenever it changes or the
  // overlay unmounts, so repeated tracing sessions never leak blob URLs.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Auto-updating live preview: re-traces on a short debounce whenever the
  // image or the settings that affect the result (detail/threshold/invert)
  // change, so the left panel always shows an up-to-date "before you press
  // Trace" comparison right under the uploaded image.
  useEffect(() => {
    if (!open || !file) {
      setLivePreviewObjects(null);
      setLivePreviewLoading(false);
      return;
    }
    let cancelled = false;
    setLivePreviewLoading(true);
    const timer = window.setTimeout(() => {
      traceImageFile(file, settings)
        .then(({ objects }) => {
          if (!cancelled) setLivePreviewObjects(objects);
        })
        .catch(() => {
          if (!cancelled) setLivePreviewObjects(null);
        })
        .finally(() => {
          if (!cancelled) setLivePreviewLoading(false);
        });
    }, LIVE_PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file, settings.detail, settings.threshold, settings.invert]);

  const livePreviewGlyph = useMemo(
    () => (livePreviewObjects && livePreviewObjects.length > 0 ? objectsPreviewGlyph(livePreviewObjects, metrics) : null),
    [livePreviewObjects, metrics]
  );

  if (!open) return null;

  function resetTraceResult() {
    setLetterGroups(null);
    setTraceCanvasSize(null);
    setSelectedLetterId(null);
    setDraggingLetterId(null);
    setSelectedTarget(null);
  }

  function handleFileSelected(next: File) {
    if (!isImageFile(next)) {
      showToast("Format tidak didukung. Gunakan file PNG atau JPG.", "error");
      return;
    }
    setFile(next);
    resetTraceResult();
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(next);
    });
  }

  function resetForNewImage() {
    setFile(null);
    resetTraceResult();
    setTracePreviewMagnifier(null);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleTrace() {
    if (!file) return;
    setIsTracing(true);
    // Yield one tick so the button's loading state actually paints before
    // the synchronous, CPU-heavy tracing work runs on the main thread.
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const { letters, canvas } = await traceImageFile(file, settings);
      setLetterGroups(letters);
      setTraceCanvasSize({ width: canvas.width, height: canvas.height });
      setSelectedLetterId(letters[0]?.id ?? null);
    } catch (err) {
      resetTraceResult();
      showToast(err instanceof TraceError ? err.message : "Gagal melakukan tracing. Coba lagi.", "error");
    } finally {
      setIsTracing(false);
    }
  }

  // Import SVG is intentionally independent from the Trace Image workflow
  // above: no tracing, no threshold/detail/invert, no live preview. It just
  // parses the file straight into vector objects and drops them into the
  // same results canvas (`letterGroups` / `traceCanvasSize`) the tracer
  // fills, so everything after that point — selecting a shape, dragging it
  // onto a target glyph, applying it — reuses that existing code untouched.
  async function handleImportSvg(next: File) {
    if (!isSvgFile(next)) {
      showToast("Format tidak didukung. Gunakan file SVG.", "error");
      return;
    }
    setIsImportingSvg(true);
    try {
      const { letters, canvas } = await importSvgFile(next);
      setLetterGroups(letters);
      setTraceCanvasSize(canvas);
      setSelectedLetterId(letters[0]?.id ?? null);
      setDraggingLetterId(null);
      setSelectedTarget(null);
      showToast(`SVG diimpor: ${letters.length} objek vektor siap dipilih.`);
    } catch (err) {
      showToast(err instanceof SvgImportError ? err.message : "Gagal mengimpor SVG. Coba file lain.", "error");
    } finally {
      setIsImportingSvg(false);
    }
  }

  function applyLetterToChar(letterId: string, ch: string) {
    const group = letterGroups?.find((g) => g.id === letterId);
    const target = regularGlyphs[ch];
    if (!group || !target) return;
    const outline = fitTracedObjectsToGlyph(group.objects, metrics, target.advanceWidth);
    commitTracedGlyphOutline(ch, outline);
    setSelectedLetterId(letterId);
    setSelectedTarget(ch);
    setAppliedFlash(ch);
    showToast(`Diterapkan ke glyph “${ch}”.`);
    window.setTimeout(() => setAppliedFlash((c) => (c === ch ? null : c)), 1200);
  }

  function onDropzoneDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDraggingFile(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) handleFileSelected(dropped);
  }

  return (
    <div
      className="fm-lab-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      data-testid="trace-overlay"
    >
      <div className="fm-lab-modal fm-trace-modal" role="dialog" aria-modal="true" aria-labelledby="trace-title">
        <div className="fm-lab-head">
          <div className="fm-lab-title" id="trace-title">
            <ImagePlus size={14} />
            <span>Trace Image</span>
          </div>
          <div className="fm-spacer" />
          <button className="fm-theme-toggle" onClick={close} title="Close (Esc)" data-testid="trace-close-btn">
            <X size={16} />
          </button>
        </div>

        <div className="fm-trace-body">
          <div className="fm-trace-left">
            <div className="fm-trace-controls">
              <button
                type="button"
                className="fm-trace-import-svg-btn"
                onClick={() => svgFileInputRef.current?.click()}
                disabled={isImportingSvg}
                data-testid="trace-import-svg-btn"
              >
                {isImportingSvg ? <Loader2 size={14} className="fm-spin" /> : <FileCode2 size={14} />}
                {isImportingSvg ? "Mengimpor…" : "Import SVG"}
              </button>
              <input
                ref={svgFileInputRef}
                type="file"
                accept="image/svg+xml,.svg"
                className="fm-trace-svg-file-input"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) handleImportSvg(picked);
                  e.target.value = "";
                }}
                data-testid="trace-svg-file-input"
              />

              <div
                className={`fm-trace-dropzone ${isDraggingFile ? "dragging" : ""} ${previewUrl ? "has-image" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); setIsDraggingFile(true); }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={onDropzoneDrop}
                data-testid="trace-dropzone"
              >
                {previewUrl ? (
                  <img src={previewUrl} alt="Pratinjau gambar yang diunggah" className="fm-trace-preview-img" />
                ) : (
                  <>
                    <ImagePlus size={26} strokeWidth={1.5} />
                    <span>Klik atau seret gambar PNG/JPG ke sini</span>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="fm-trace-file-input"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    if (picked) handleFileSelected(picked);
                  }}
                  data-testid="trace-file-input"
                />
              </div>
              {file && (
                <div className="fm-trace-filename">
                  <span>{file.name}</span>
                  <button type="button" className="fm-trace-filename-reset" onClick={resetForNewImage} data-testid="trace-reset-image">
                    <RefreshCw size={12} /> Gambar lain
                  </button>
                </div>
              )}

              <div className="fm-trace-live-preview" data-testid="trace-live-preview">
                <div className="fm-trace-result-head">Preview Hasil Trace</div>
                <div
                  className="fm-trace-live-preview-box"
                  ref={livePreviewBoxRef}
                  onMouseMove={livePreviewGlyph ? handleTracePreviewMouseMove : undefined}
                  onMouseLeave={() => setTracePreviewMagnifier(null)}
                >
                  {!file ? (
                    <span className="fm-hint">Unggah gambar untuk melihat preview otomatis di sini.</span>
                  ) : livePreviewLoading && !livePreviewGlyph ? (
                    <Loader2 size={18} className="fm-spin" />
                  ) : livePreviewGlyph ? (
                    <GlyphThumbnail glyph={livePreviewGlyph} />
                  ) : (
                    <span className="fm-hint">Tidak ada bentuk terdeteksi. Coba sesuaikan Threshold.</span>
                  )}
                  {livePreviewLoading && livePreviewGlyph && <Loader2 size={14} className="fm-spin fm-trace-live-preview-spinner" />}
                  {tracePreviewMagnifier && livePreviewGlyph && (
                    <div
                      className="fm-trace-preview-lens"
                      style={{ left: tracePreviewMagnifier.mx, top: tracePreviewMagnifier.my }}
                    >
                      <div
                        className="fm-trace-preview-lens-inner"
                        style={{
                          width: tracePreviewMagnifier.w,
                          height: tracePreviewMagnifier.h,
                          left: TRACE_PREVIEW_LENS_SIZE / 2 - tracePreviewMagnifier.mx * TRACE_PREVIEW_ZOOM,
                          top: TRACE_PREVIEW_LENS_SIZE / 2 - tracePreviewMagnifier.my * TRACE_PREVIEW_ZOOM,
                          transform: `scale(${TRACE_PREVIEW_ZOOM})`,
                        }}
                      >
                        <GlyphThumbnail glyph={livePreviewGlyph} />
                      </div>
                    </div>
                  )}
                </div>
                <div className="fm-hint">Preview otomatis ini mengikuti Detail, Threshold, dan Balik warna — bandingkan dulu sebelum menekan Trace Image.</div>
              </div>

              <div className="fm-field">
                <label>Detail</label>
                <div className="fm-trace-detail-toggle" role="group" aria-label="Tingkat detail tracing">
                  {(["low", "medium", "high"] as TraceDetail[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={settings.detail === level ? "active" : ""}
                      aria-pressed={settings.detail === level}
                      onClick={() => setSettings((s) => ({ ...s, detail: level }))}
                      data-testid={`trace-detail-${level}`}
                    >
                      {level === "low" ? "Rendah" : level === "medium" ? "Sedang" : "Tinggi"}
                    </button>
                  ))}
                </div>
                <div className="fm-hint">Rendah = node paling sedikit &amp; paling halus. Tinggi = mengikuti garis tipis lebih ketat &amp; presisi.</div>
              </div>

              <Slider
                label="Threshold"
                value={settings.threshold}
                min={10}
                max={245}
                step={1}
                directInput
                onChange={(v) => setSettings((s) => ({ ...s, threshold: v }))}
              />
              <div className="fm-hint">Piksel lebih gelap dari nilai ini dianggap tinta (bentuk glyph).</div>

              <label className="fm-checkbox-row" style={{ marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={settings.invert}
                  onChange={(e) => setSettings((s) => ({ ...s, invert: e.target.checked }))}
                  data-testid="trace-invert"
                />
                Balik warna (gambar terang di atas latar gelap)
              </label>

              <button
                type="button"
                className="fm-action-btn accent"
                disabled={!file || isTracing}
                onClick={handleTrace}
                data-testid="trace-run-btn"
                style={{ marginTop: 10 }}
              >
                {isTracing ? <Loader2 size={14} className="fm-spin" /> : <ImagePlus size={14} />}
                {isTracing ? "Melacak…" : "Trace Image"}
              </button>
            </div>

            <div className="fm-trace-canvas">
              <div className="fm-trace-canvas-head">
                <span className="fm-panel-eyebrow">
                  <Layers size={12} /> Canvas Hasil Tracing
                </span>
                {letterGroups && letterGroups.length > 0 && (
                  <span className="fm-trace-canvas-count">{letterGroups.length} objek terdeteksi</span>
                )}
              </div>

              {!letterGroups ? (
                <div className="fm-trace-canvas-empty" data-testid="trace-canvas-empty">
                  <ImagePlus size={22} strokeWidth={1.4} />
                  <span>Unggah gambar lalu klik “Trace Image”. Hasil tracing akan muncul utuh di canvas ini, dan tiap bentuk tetap bisa dipilih satu per satu.</span>
                </div>
              ) : letterGroups.length === 0 ? (
                <div className="fm-trace-canvas-empty">
                  <span>Tidak ada bentuk yang terdeteksi. Coba sesuaikan Threshold.</span>
                </div>
              ) : (
                <div className="fm-trace-artboard-wrap">
                  <div
                    className="fm-trace-artboard"
                    style={{ aspectRatio: `${traceCanvasSize?.width ?? 1} / ${traceCanvasSize?.height ?? 1}` }}
                    data-testid="trace-artboard"
                  >
                    {letterGroups.map((g, i) => {
                      const isActive = selectedLetterId === g.id;
                      const w = traceCanvasSize?.width || 1;
                      const h = traceCanvasSize?.height || 1;
                      const left = (g.bounds.minX / w) * 100;
                      const top = (g.bounds.minY / h) * 100;
                      const width = ((g.bounds.maxX - g.bounds.minX) / w) * 100;
                      const height = ((g.bounds.maxY - g.bounds.minY) / h) * 100;
                      return (
                        <button
                          key={g.id}
                          type="button"
                          className={`fm-trace-artboard-item ${isActive ? "active" : ""}`}
                          style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                          onClick={() => setSelectedLetterId(g.id)}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "copy";
                            e.dataTransfer.setData("text/plain", g.id);
                            setSelectedLetterId(g.id);
                            setDraggingLetterId(g.id);
                          }}
                          onDragEnd={() => setDraggingLetterId(null)}
                          title={`Bentuk #${i + 1} — seret ke glyph target atau klik untuk pilih`}
                          data-testid={`trace-letter-${i}`}
                        >
                          <svg
                            viewBox={`${g.bounds.minX} ${g.bounds.minY} ${Math.max(1e-6, g.bounds.maxX - g.bounds.minX)} ${Math.max(1e-6, g.bounds.maxY - g.bounds.minY)}`}
                            preserveAspectRatio="none"
                            className="fm-trace-artboard-svg"
                          >
                            {g.objects.map((obj) => (
                              <path key={obj.id} d={tracedObjectFillPath(obj)} fillRule="nonzero" />
                            ))}
                          </svg>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {letterGroups && letterGroups.length > 0 && (
                <div className="fm-trace-apply-bar" data-testid="trace-apply-bar">
                  <div className="fm-trace-apply-info">
                    {selectedPreviewGlyph && (
                      <div
                        className="fm-trace-apply-thumb"
                        draggable
                        onDragStart={(e) => {
                          if (!selectedGroup) return;
                          e.dataTransfer.effectAllowed = "copy";
                          e.dataTransfer.setData("text/plain", selectedGroup.id);
                          setDraggingLetterId(selectedGroup.id);
                        }}
                        onDragEnd={() => setDraggingLetterId(null)}
                        title="Seret ke glyph target"
                      >
                        <GlyphThumbnail glyph={selectedPreviewGlyph} />
                      </div>
                    )}
                    <span className="fm-hint fm-trace-apply-hint">
                      {!selectedGroup
                        ? "Klik salah satu bentuk di atas untuk memilih."
                        : selectedTarget
                        ? `Terpilih: bentuk → “${selectedTarget}”`
                        : "Pilih glyph target di kanan, atau seret bentuk ini langsung ke sana."}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="fm-action-btn accent"
                    disabled={!selectedGroup || !selectedTarget}
                    onClick={() => selectedGroup && selectedTarget && applyLetterToChar(selectedGroup.id, selectedTarget)}
                    data-testid="trace-apply-btn"
                  >
                    <Wand2 size={14} />
                    {!selectedGroup ? "Pilih bentuk" : selectedTarget ? `Terapkan ke “${selectedTarget}”` : "Pilih glyph target"}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="fm-trace-right">
            <div className="fm-trace-right-head">
              <span className="fm-panel-eyebrow">Target Glyph</span>
              <span className="fm-hint fm-trace-right-hint">
                {selectedTarget ? `Terpilih: “${selectedTarget}”` : "Pilih target di sini"}
              </span>
            </div>
            <div className="fm-trace-glyphlist">
              {groups.map((g) => (
                <div key={g.id}>
                  <div className="fm-group-label">{g.label}</div>
                  <div className="fm-grid fm-trace-target-grid">
                    {g.chars.map((ch) => {
                      const info = regularGlyphs[ch];
                      if (!info) return null;
                      const done = hasOutline(info);
                      const isTarget = selectedTarget === ch;
                      const flashed = appliedFlash === ch;
                      return (
                        <button
                          key={ch}
                          type="button"
                          className={`fm-tile fm-trace-target-tile ${isTarget ? "active" : ""} ${done ? "done" : ""} ${flashed ? "fm-trace-tile-applied" : ""}`}
                          onClick={() => setSelectedTarget(ch)}
                          onDragOver={(e) => { if (draggingLetterId) e.preventDefault(); }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (draggingLetterId) applyLetterToChar(draggingLetterId, ch);
                            setDraggingLetterId(null);
                          }}
                          title={`${ch} — ${unicodeHex(info.unicode)}`}
                          data-testid={`trace-target-${ch}`}
                        >
                          {done && <span className="fm-tile-dot" />}
                          <span className="fm-tile-thumb"><GlyphThumbnail glyph={info} /></span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <Toast toast={toast} onClose={dismissToast} />
      </div>
    </div>
  );
}
