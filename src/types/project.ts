import type { BrushSettings } from "./brush";
import type { FontInfo, FontMetrics } from "./font";
import type { FontStyle, GlyphFamily, GlyphMap } from "./glyph";
import type { KerningManualFlags, KerningPairs, KerningOverridesByStyle, KerningOverrideManualByStyle } from "./kerning";

export const FONTSERU_PROJECT_FORMAT = "fontseru-project" as const;
export const FONTSERU_PROJECT_VERSION = 1 as const;

export interface FontSeruProjectV1 {
  format: typeof FONTSERU_PROJECT_FORMAT;
  version: typeof FONTSERU_PROJECT_VERSION;
  appVersion: string;
  savedAt: string;
  font: {
    name: string;
    info: FontInfo;
    metrics: FontMetrics;
    /** Regular glyph map kept for backward compatibility with older .fs files. */
    glyphs: GlyphMap;
    glyphsByStyle?: GlyphFamily;
    kerningPairs: KerningPairs;
    kerningManual: KerningManualFlags;
    /** Optional additive family-kerning fields keep v1 projects backward compatible. */
    kerningOverridesByStyle?: KerningOverridesByStyle;
    kerningOverrideManualByStyle?: KerningOverrideManualByStyle;
  };
  editor: {
    activeChar: string;
    fontStyle?: FontStyle;
    gridSize: number;
    showGrid: boolean;
    showGuides: boolean;
    ghost: { enabled: boolean; mode?: "sample" | "family" | "image"; opacity: number; scale: number; offsetX: number; offsetY: number; imageSrc?: string | null; imageAspect?: number };
    brush: BrushSettings;
  };
}

export type FontSeruProject = FontSeruProjectV1;
