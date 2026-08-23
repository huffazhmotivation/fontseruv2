import type { FontInfo, FontMetrics } from "@/types/font";
import type { FontStyle, GlyphFamily, GlyphMap } from "@/types/glyph";
import type { KerningManualFlags, KerningPairs, KerningOverridesByStyle, KerningOverrideManualByStyle } from "@/types/kerning";
import type { BrushSettings } from "@/types/brush";
import {
  FONTSERU_PROJECT_FORMAT,
  FONTSERU_PROJECT_VERSION,
  type FontSeruProject,
} from "@/types/project";

export interface ProjectSource {
  fontName: string;
  fontInfo: FontInfo;
  metrics: FontMetrics;
  /** Regular glyphs for backward-compatible project readers. */
  glyphs: GlyphMap;
  glyphsByStyle?: GlyphFamily;
  fontStyle?: FontStyle;
  kerningPairs: KerningPairs;
  kerningManual: KerningManualFlags;
  kerningOverridesByStyle?: KerningOverridesByStyle;
  kerningOverrideManualByStyle?: KerningOverrideManualByStyle;
  activeChar: string;
  gridSize: number;
  showGrid: boolean;
  showGuides: boolean;
  ghost: { enabled: boolean; mode: "sample" | "family" | "image"; opacity: number; scale: number; offsetX: number; offsetY: number; imageSrc?: string | null; imageAspect?: number };
  brush: BrushSettings;
}

export function createFontSeruProject(source: ProjectSource): FontSeruProject {
  // JSON round-trip intentionally snapshots the current editable graph instead
  // of retaining any Zustand references.
  const project: FontSeruProject = {
    format: FONTSERU_PROJECT_FORMAT,
    version: FONTSERU_PROJECT_VERSION,
    appVersion: "0.5.0",
    savedAt: new Date().toISOString(),
    font: {
      name: source.fontName,
      info: source.fontInfo,
      metrics: source.metrics,
      glyphs: source.glyphs,
      glyphsByStyle: source.glyphsByStyle,
      kerningPairs: source.kerningPairs,
      kerningManual: source.kerningManual,
      kerningOverridesByStyle: source.kerningOverridesByStyle,
      kerningOverrideManualByStyle: source.kerningOverrideManualByStyle,
    },
    editor: {
      activeChar: source.activeChar,
      fontStyle: source.fontStyle,
      gridSize: source.gridSize,
      showGrid: source.showGrid,
      showGuides: source.showGuides,
      ghost: source.ghost,
      brush: source.brush,
    },
  };
  return JSON.parse(JSON.stringify(project)) as FontSeruProject;
}

export function serializeFontSeruProject(project: FontSeruProject): string {
  return JSON.stringify(project, null, 2);
}

export function parseFontSeruProject(text: string): FontSeruProject {
  const data = JSON.parse(text) as Partial<FontSeruProject> & Record<string, unknown>;
  if (data.format !== FONTSERU_PROJECT_FORMAT) throw new Error("Not a FontSeru .fs project.");
  if (data.version !== 1) throw new Error(`Unsupported FontSeru project version: ${String(data.version)}`);
  if (!data.font || !data.editor) throw new Error("Incomplete FontSeru project.");
  return data as FontSeruProject;
}

export function safeProjectBaseName(value: string): string {
  const trimmed = value.trim().replace(/\.(fs|ttf|otf)$/i, "");
  return (trimmed || "Untitled-Font").replace(/[\\/:*?"<>|]+/g, "-");
}

export function safeFontFileBaseName(value: string): string {
  const trimmed = value.trim().replace(/\.(fs|ttf|otf)$/i, "");
  const ascii = trimmed.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const safe = ascii
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return safe || "Untitled-Font";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadProject(project: FontSeruProject, filename: string): void {
  downloadBlob(
    new Blob([serializeFontSeruProject(project)], { type: "application/octet-stream" }),
    `${safeProjectBaseName(filename)}.fs`,
  );
}
