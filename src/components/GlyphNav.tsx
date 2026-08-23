import { useMemo, useState } from "react";
import { Lock, Search, Zap, Globe } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import { FONT_STYLES, hasOutline } from "@/types/glyph";
import { unicodeHex } from "@/utils/unicode";
import { GlyphThumbnail } from "./GlyphThumbnail";

export function GlyphNav() {
  const [query, setQuery] = useState("");
  const glyphs = useAppStore((s) => s.glyphs);
  const activeChar = useAppStore((s) => s.activeChar);
  const setActiveChar = useAppStore((s) => s.setActiveChar);
  const fontStyle = useAppStore((s) => s.fontStyle);
  const setFontStyle = useAppStore((s) => s.setFontStyle);
  const generateFromRegular = useAppStore((s) => s.generateFromRegular);
  const openProModal = useAppStore((s) => s.openProModal);
  const addMultilingualGlyphs = useAppStore((s) => s.addMultilingualGlyphs);
  const { isPro } = useAuth();
  const [multilingualStatus, setMultilingualStatus] = useState<string | null>(null);

  const runAddMultilingual = () => {
    const result = addMultilingualGlyphs();
    const parts: string[] = [];
    if (result.created > 0) parts.push(`${result.created} glyph${result.created === 1 ? "" : "s"} added`);
    const slotsAdded = result.markSlotsAdded + result.symbolSlotsAdded;
    if (slotsAdded > 0) parts.push(`${slotsAdded} accent mark${slotsAdded === 1 ? "" : "s"} ready to draw`);
    setMultilingualStatus(parts.length > 0 ? parts.join(" · ") : "Nothing new — draw more accent marks first");
    window.setTimeout(() => setMultilingualStatus(null), 4000);
  };

  const filteredGroups = useMemo(() => {
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
      chars: [...g.chars.filter((ch) => Boolean(glyphs[ch])), ...(extrasByCategory.get(g.id) ?? []).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode)],
    })).filter((g) => g.chars.length > 0);
    const assigned = new Set(groups.flatMap((g) => g.chars));
    const remaining = Object.keys(glyphs).filter((ch) => !assigned.has(ch)).sort((a, b) => glyphs[a].unicode - glyphs[b].unicode);
    const allGroups = remaining.length ? [...groups, { id: "symbols" as const, label: "Imported", chars: remaining }] : groups;
    if (!query.trim()) return allGroups;
    const q = query.trim().toLowerCase();
    return allGroups.map((g) => ({
      ...g,
      chars: g.chars.filter((ch) => {
        if (ch.toLowerCase() === q) return true;
        const info = glyphs[ch];
        return info ? unicodeHex(info.unicode).toLowerCase().includes(q) || (info.name ?? "").toLowerCase().includes(q) : false;
      }),
    })).filter((g) => g.chars.length > 0);
  }, [query, glyphs]);

  return (
    <div className="fm-glyphnav" data-testid="glyph-nav">
      <div className="fm-glyphnav-head">
        <span className="fm-panel-eyebrow">Glyphs</span>

        <div className="fm-family-tabs" role="tablist" aria-label="Font family style" data-testid="family-tabs">
          {FONT_STYLES.map((style) => {
            // Regular is free for everyone; Bold/Italic are PRO-only. Locked
            // tabs stay visible (dimmed + lock icon) and open the existing
            // ProUpsellModal instead of switching styles — the actual switch
            // is also blocked at the store level (setFontStyle) so this is
            // UI polish, not the only line of defense.
            const locked = style.id !== "regular" && !isPro;
            return (
              <button
                key={style.id}
                type="button"
                role="tab"
                aria-selected={fontStyle === style.id}
                className={`${fontStyle === style.id ? "active" : ""} ${locked ? "fm-family-tab-locked" : ""}`}
                onClick={() => (locked ? openProModal("family") : setFontStyle(style.id))}
                title={locked ? `${style.label} (PRO)` : undefined}
                data-testid={`family-tab-${style.id}`}
              >
                {style.label}
                {locked && <Lock size={10} className="fm-lock-badge-inline" />}
              </button>
            );
          })}
        </div>

        {fontStyle !== "regular" && (
          <button
            type="button"
            className={`fm-action-btn accent fm-family-generate ${!isPro ? "fm-action-btn-locked" : ""}`}
            onClick={() => (isPro ? generateFromRegular() : openProModal("family"))}
            data-testid="generate-from-regular"
          >
            <Zap size={15} fill="currentColor" />
            <span>Generate From Regular</span>
            {!isPro && <Lock size={12} className="fm-lock-badge-inline" />}
          </button>
        )}

        <div className="fm-search">
          <Search size={14} />
          <input
            placeholder="Search glyph or U+…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            data-testid="glyph-search"
          />
        </div>
      </div>
      <div className="fm-glyphlist">
        {filteredGroups.map((g) => (
          <div key={g.id}>
            <div className="fm-group-label">{g.label}</div>
            <div className="fm-grid">
              {g.chars.map((ch) => {
                const info = glyphs[ch];
                if (!info) return null;
                const done = hasOutline(info);
                return (
                  <button
                    key={ch}
                    className={`fm-tile ${activeChar === ch ? "active" : ""} ${done ? "done" : ""}`}
                    onClick={() => setActiveChar(ch)}
                    title={`${ch} — ${unicodeHex(info.unicode)}`}
                    data-testid={`glyph-tile-${ch}`}
                  >
                    {done && <span className="fm-tile-dot" />}
                    <span className="fm-tile-thumb"><GlyphThumbnail glyph={info} /></span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {filteredGroups.length === 0 && (
          <div className="fm-hint" style={{ padding: "10px 4px" }}>No glyph matches “{query}”.</div>
        )}
      </div>
      <div className="fm-glyphnav-foot">
        <button
          type="button"
          className="fm-action-btn accent"
          onClick={runAddMultilingual}
          title="Compose accented letters (É, ü, ñ…) from glyphs you've already drawn"
          data-testid="add-multilingual-btn"
        >
          <Globe size={14} /> + Multilingual Glyphs
        </button>
        {multilingualStatus && (
          <div className="fm-hint" style={{ padding: "6px 4px 0" }} data-testid="add-multilingual-status">
            {multilingualStatus}
          </div>
        )}
      </div>
    </div>
  );
}
