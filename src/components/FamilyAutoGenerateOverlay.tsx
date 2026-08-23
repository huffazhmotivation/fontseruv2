import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent } from "react";
import { Italic, Layers, Sparkles, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { FONT_STYLES, hasOutline, type FontStyle, type Glyph, type GlyphCategory, type GlyphMap } from "@/types/glyph";
import { GlyphThumbnail } from "@/components/GlyphThumbnail";
import { Slider } from "@/components/RightPanel";
import { autoBoldOutline, autoItalicOutline, type FamilyGenerationResult } from "@/glyph/autoGenerate";


const FAMILY_CATEGORIES: ReadonlyArray<{ id: GlyphCategory; label: string }> = [
  { id: "upper", label: "Uppercase" },
  { id: "lower", label: "Lowercase" },
  { id: "digits", label: "Number" },
  { id: "punct", label: "Punctuation" },
  { id: "symbols", label: "Symbol" },
];

const FAMILY_CATEGORY_ORDER: Record<GlyphCategory, number> = {
  upper: 0,
  lower: 1,
  digits: 2,
  punct: 3,
  symbols: 4,
  multilingual: 5,
};

function resultMessage(label: "Bold" | "Italic", result: FamilyGenerationResult): string {
  const changed = result.generated + result.replaced;
  if (changed === 0) {
    if (result.preserved > 0) {
      return `${label}: no glyphs changed; ${result.preserved} existing glyph${result.preserved === 1 ? "" : "s"} preserved.`;
    }
    return `${label}: no Regular vector glyphs are available to generate yet.`;
  }

  const parts = [`${label}: ${result.generated} generated`];
  if (result.replaced > 0) parts.push(`${result.replaced} replaced`);
  if (result.preserved > 0) parts.push(`${result.preserved} existing preserved`);
  return `${parts.join(" · ")}.`;
}

function FamilyVectorRow({
  style,
  label,
  glyphs,
}: {
  style: FontStyle;
  label: string;
  glyphs: GlyphMap;
}) {
  const [activeCategory, setActiveCategory] = useState<GlyphCategory | null>(null);
  const entries = useMemo(
    () =>
      Object.entries(glyphs)
        .sort((a, b) => {
          const categoryDelta =
            FAMILY_CATEGORY_ORDER[a[1].category] - FAMILY_CATEGORY_ORDER[b[1].category];
          return categoryDelta || a[1].unicode - b[1].unicode;
        })
        .filter(([, glyph]) => activeCategory === null || glyph.category === activeCategory),
    [glyphs, activeCategory]
  );

  return (
    <section className="fm-family-auto-row" data-testid={`family-auto-preview-${style}`}>
      <div className="fm-family-auto-row-head">
        <div>
          <strong>{label}</strong>
          <div className="fm-family-auto-categories" role="tablist" aria-label={`${label} glyph categories`}>
            {FAMILY_CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                className={activeCategory === category.id ? "is-active" : ""}
                role="tab"
                aria-selected={activeCategory === category.id}
                onClick={() => setActiveCategory((current) => current === category.id ? null : category.id)}
                data-testid={`family-auto-filter-${style}-${category.id}`}
              >
                {category.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="fm-family-auto-strip" role="list" aria-label={`${label} ${FAMILY_CATEGORIES.find((category) => category.id === activeCategory)?.label ?? "all"} vector glyphs`}>
        {entries.map(([char, glyph]) => {
          const outlined = hasOutline(glyph);
          return (
            <div
              key={`${style}-${char}`}
              className={`fm-family-auto-glyph ${outlined ? "has-vector" : "is-empty"}`}
              role="listitem"
              title={`${label} · ${char === " " ? "Space" : char}${outlined ? "" : " · Empty"}`}
            >
              <span className="fm-family-auto-char">{char === " " ? "SP" : char}</span>
              <div className="fm-family-auto-thumb">
                {outlined ? (
                  <GlyphThumbnail glyph={glyph} />
                ) : (
                  <span className="fm-family-auto-empty" aria-label={`${char} has no ${label} vector`}>
                    Empty
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {entries.length === 0 && (
          <div className="fm-family-auto-empty-row">No glyphs in this category.</div>
        )}
      </div>
    </section>
  );
}

export function FamilyAutoGenerateOverlay() {
  const open = useAppStore((s) => s.familyOpen);
  const close = useAppStore((s) => s.closeFamily);
  const glyphsByStyle = useAppStore((s) => s.glyphsByStyle);
  const generateFamilyBold = useAppStore((s) => s.generateFamilyBold);
  const generateFamilyItalic = useAppStore((s) => s.generateFamilyItalic);

  const [boldAmount, setBoldAmount] = useState(32);
  const [italicAngle, setItalicAngle] = useState(12);
  const [replaceBold, setReplaceBold] = useState(false);
  const [replaceItalic, setReplaceItalic] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Full A–Z live preview strip: every Uppercase Regular glyph, sorted by
  // codepoint, so the preview reflects the whole alphabet instead of a
  // single sampled character.
  const upperRegularGlyphs = useMemo(
    () =>
      Object.values(glyphsByStyle.regular)
        .filter((g) => g.category === "upper")
        .sort((a, b) => a.unicode - b.unicode),
    [glyphsByStyle.regular]
  );
  const hasUpperVectors = useMemo(() => upperRegularGlyphs.some(hasOutline), [upperRegularGlyphs]);

  const boldPreviewGlyphs = useMemo<Glyph[]>(
    () => upperRegularGlyphs.map((g) =>
      hasOutline(g) ? { ...g, outline: autoBoldOutline(g.outline, boldAmount) } : g
    ),
    [upperRegularGlyphs, boldAmount]
  );
  const italicPreviewGlyphs = useMemo<Glyph[]>(
    () => upperRegularGlyphs.map((g) =>
      hasOutline(g) ? { ...g, outline: autoItalicOutline(g.outline, italicAngle) } : g
    ),
    [upperRegularGlyphs, italicAngle]
  );

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const runBold = () => {
    const result = generateFamilyBold(boldAmount, replaceBold);
    setStatus(resultMessage("Bold", result));
  };

  const runItalic = () => {
    const result = generateFamilyItalic(italicAngle, replaceItalic);
    setStatus(resultMessage("Italic", result));
  };

  return (
    <div
      className="fm-lab-backdrop fm-family-auto-backdrop"
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) close();
      }}
      data-testid="family-auto-overlay"
    >
      <div className="fm-lab-modal fm-family-auto-modal" role="dialog" aria-modal="true" aria-labelledby="family-auto-title">
        <div className="fm-lab-head">
          <div className="fm-lab-title" id="family-auto-title">
            <Layers size={14} />
            <span>Family Auto Generate</span>
          </div>
          <div className="fm-spacer" />
          <button className="fm-theme-toggle" onClick={close} title="Close (Esc)" data-testid="family-auto-close">
            <X size={16} />
          </button>
        </div>

        <div className="fm-family-auto-body">
          <div className="fm-family-auto-previews">
            {FONT_STYLES.map(({ id, label }) => (
              <FamilyVectorRow key={id} style={id} label={label} glyphs={glyphsByStyle[id]} />
            ))}
          </div>

          <div className="fm-family-auto-generators" aria-label="Family vector generators">
            <section className="fm-family-auto-generator">
              <div className="fm-family-auto-generator-title">
                <Sparkles size={14} />
                <div>
                  <strong>Auto Bold</strong>
                  <span>Regular → Bold vector glyphs</span>
                </div>
              </div>

              <div className="fm-family-auto-live-preview fm-family-auto-live-preview--strip" aria-label="Auto Bold live preview, Uppercase A to Z">
                <span>LIVE PREVIEW · UPPERCASE A–Z</span>
                {hasUpperVectors ? (
                  <div className="fm-family-auto-live-strip" role="list">
                    {boldPreviewGlyphs.map((g) => (
                      <div key={`bold-${g.char}`} className="fm-family-auto-live-glyph" role="listitem" title={g.char}>
                        {hasOutline(g) ? <GlyphThumbnail glyph={g} /> : <span className="fm-family-auto-live-char">{g.char}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="fm-family-auto-live-empty"><em>No Regular vector</em></div>
                )}
              </div>

              <Slider
                label="Bold Amount"
                value={boldAmount}
                min={0}
                max={120}
                step={2}
                onChange={setBoldAmount}
                format={(value) => `${Math.round(value)}u`}
              />

              <label className="fm-checkbox-row fm-family-auto-replace">
                <input
                  type="checkbox"
                  checked={replaceBold}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setReplaceBold(event.target.checked)}
                />
                <span>Replace existing Bold glyphs</span>
              </label>
              <div className="fm-hint">Off by default, so existing Bold vectors are preserved.</div>

              <button className="fm-action-btn accent" onClick={runBold} data-testid="auto-bold-btn">
                <Sparkles size={14} />
                Auto Bold
              </button>
            </section>

            <section className="fm-family-auto-generator">
              <div className="fm-family-auto-generator-title">
                <Italic size={14} />
                <div>
                  <strong>Auto Italic</strong>
                  <span>Regular → Italic vector glyphs</span>
                </div>
              </div>

              <div className="fm-family-auto-live-preview fm-family-auto-live-preview--strip" aria-label="Auto Italic live preview, Uppercase A to Z">
                <span>LIVE PREVIEW · UPPERCASE A–Z</span>
                {hasUpperVectors ? (
                  <div className="fm-family-auto-live-strip" role="list">
                    {italicPreviewGlyphs.map((g) => (
                      <div key={`italic-${g.char}`} className="fm-family-auto-live-glyph" role="listitem" title={g.char}>
                        {hasOutline(g) ? <GlyphThumbnail glyph={g} /> : <span className="fm-family-auto-live-char">{g.char}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="fm-family-auto-live-empty"><em>No Regular vector</em></div>
                )}
              </div>

              <Slider
                label="Italic Angle"
                value={italicAngle}
                min={-20}
                max={20}
                step={1}
                onChange={setItalicAngle}
                format={(value) => `${Math.round(value)}°`}
              />

              <label className="fm-checkbox-row fm-family-auto-replace">
                <input
                  type="checkbox"
                  checked={replaceItalic}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setReplaceItalic(event.target.checked)}
                />
                <span>Replace existing Italic glyphs</span>
              </label>
              <div className="fm-hint">Uses the same X-skew direction and degree convention as Transform → Skew.</div>

              <button className="fm-action-btn accent" onClick={runItalic} data-testid="auto-italic-btn">
                <Italic size={14} />
                Auto Italic
              </button>
            </section>
          </div>

          {status && (
            <div className="fm-family-auto-status" role="status" data-testid="family-auto-status">
              <span className="fm-status-dot" />
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
