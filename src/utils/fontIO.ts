import * as opentype from "opentype.js";
import { expandStrokeObject } from "@/brushes/strokeToOutline";
import type { Contour, PathNode, VectorObject } from "@/types/geometry";
import type { FontInfo, FontMetrics } from "@/types/font";
import type { Glyph, GlyphCategory, GlyphMap } from "@/types/glyph";
import type { KerningPairs } from "@/types/kerning";
import { kerningKey, parseKerningKey } from "@/types/kerning";
import { shortId } from "@/utils/id";
import { buildTrueTypeFont, type TrueTypeGlyphInput } from "@/utils/trueTypeWriter";
import { toWoff, toWoff2 } from "fontverter";

export interface ImportedFontProject {
  fontName: string;
  fontInfo: FontInfo;
  metrics: FontMetrics;
  glyphs: GlyphMap;
  kerningPairs: KerningPairs;
}

export type ExportFontFormat = "otf" | "ttf" | "both" | "woff" | "woff2" | "webfont";

function categoryFor(cp: number): GlyphCategory {
  if (cp >= 0x41 && cp <= 0x5a) return "upper";
  if (cp >= 0x61 && cp <= 0x7a) return "lower";
  if (cp >= 0x30 && cp <= 0x39) return "digits";
  if ((cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)) return "punct";
  return "symbols";
}

export interface NormalizedFontMetadata extends FontInfo {
  manufacturer: string;
  manufacturerURL: string;
  uniqueID: string;
  /** OpenType style-link metadata derived from the subfamily name. */
  weightClass: number;
  fsSelection: number;
  macStyle: number;
  italicAngle: number;
}

export interface GeneratedFontFile {
  extension: "otf" | "ttf" | "woff" | "woff2";
  mimeType: "font/otf" | "font/ttf" | "font/woff" | "font/woff2";
  buffer: ArrayBuffer;
}

export interface NormalizedExportFontData {
  familyName: string;
  subfamilyName: string;
  fullName: string;
  postScriptName: string;
  version: string;
  creator: string;
  license: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphs: Glyph[];
  metrics: FontMetrics;
  info: NormalizedFontMetadata;
  kerningPairs: KerningPairs;
}


const DEFAULT_UPM = 1000;
const MIN_FONT_COORD = -32760;
const MAX_FONT_COORD = 32760;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read an OpenType name record without assuming that English exists.
 * Imported fonts may expose BCP-47 language keys other than `en`.
 */
export function getFontName(record: unknown, fallback = ""): string {
  if (typeof record === "string") return record.trim() || fallback;
  if (!record || typeof record !== "object") return fallback;

  const values = record as Record<string, unknown>;
  for (const language of ["en", "en-US", "en-GB"]) {
    const value = asText(values[language]);
    if (value) return value;
  }
  for (const value of Object.values(values)) {
    const resolved = getFontName(value, "");
    if (resolved) return resolved;
  }
  return fallback;
}

/**
 * Read a name field from an opentype.js-parsed font's `names` object.
 *
 * opentype.js nests parsed name records by platform first
 * (e.g. `names.windows.fontFamily.en`), not flat as `names.fontFamily.en`.
 * Reading the flat shape against a real parsed font silently returns
 * undefined for every field, which previously caused freshly generated,
 * perfectly valid fonts to fail FontSeru's own post-export validation
 * ("family name is missing") even though the font's name table was fine.
 * This checks platforms in priority order and also accepts the flat shape
 * for forward/backward compatibility with other opentype.js versions.
 */
const NAME_PLATFORM_PRIORITY = ["windows", "unicode", "macintosh"] as const;

export function getParsedFontName(names: unknown, field: string, fallback = ""): string {
  if (!names || typeof names !== "object") return fallback;
  const byPlatform = names as Record<string, unknown>;

  for (const platform of NAME_PLATFORM_PRIORITY) {
    const platformNames = byPlatform[platform];
    if (platformNames && typeof platformNames === "object") {
      const value = getFontName((platformNames as Record<string, unknown>)[field], "");
      if (value) return value;
    }
  }

  const direct = getFontName(byPlatform[field], "");
  return direct || fallback;
}

function cleanPostScriptPart(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\s()[\]{}<>/%]+/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "");
  return cleaned || fallback;
}

export function sanitizePostScriptName(familyName: string, styleName: string, requested = ""): string {
  const requestedName = cleanPostScriptPart(requested, "");
  if (requestedName) return requestedName.slice(0, 63);
  const family = cleanPostScriptPart(familyName, "UntitledFont");
  const style = cleanPostScriptPart(styleName, "Regular");
  return `${family}-${style}`.replace(/-+/g, "-").slice(0, 63);
}

function normalizedStyleWords(styleName: string): string {
  return styleName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
}

function weightClassForStyle(styleName: string): number {
  const style = normalizedStyleWords(styleName);
  if (/\b(thin|hairline)\b/.test(style)) return 100;
  if (/\b(extra light|ultra light|extralight|ultralight)\b/.test(style)) return 200;
  if (/\blight\b/.test(style)) return 300;
  if (/\bmedium\b/.test(style)) return 500;
  if (/\b(semi bold|demi bold|semibold|demibold)\b/.test(style)) return 600;
  if (/\b(extra bold|ultra bold|extrabold|ultrabold)\b/.test(style)) return 800;
  if (/\b(black|heavy)\b/.test(style)) return 900;
  if (/\bbold\b/.test(style)) return 700;
  return 400;
}

/**
 * Resolve the metadata that desktop font managers and applications use to
 * connect Regular/Bold/Italic files as one installed family.
 *
 * This remains name-driven because FontSeru currently stores style identity
 * as a subfamily name rather than as a separate weight/slant model.
 */
export function fontStyleLinkMetadata(styleName: string): {
  weightClass: number;
  fsSelection: number;
  macStyle: number;
  italicAngle: number;
} {
  const style = normalizedStyleWords(styleName);
  const weightClass = weightClassForStyle(styleName);
  const italic = /\b(italic|oblique)\b/.test(style);
  const bold = weightClass >= 700;
  const regular = !bold && !italic && (weightClass === 400 || /\b(regular|normal|roman|book)\b/.test(style));

  // OS/2.fsSelection: bit 0 ITALIC, bit 5 BOLD, bit 6 REGULAR.
  const fsSelection = (italic ? 0x0001 : 0) | (bold ? 0x0020 : 0) | (regular ? 0x0040 : 0);
  // head.macStyle: bit 0 BOLD, bit 1 ITALIC.
  const macStyle = (bold ? 0x0001 : 0) | (italic ? 0x0002 : 0);

  return {
    weightClass,
    fsSelection,
    macStyle,
    italicAngle: italic ? -12 : 0,
  };
}

export function normalizeFontMetadata(
  info: Partial<FontInfo> | null | undefined,
  fallbackFamily = "Untitled Font",
): NormalizedFontMetadata {
  const familyName = asText(info?.familyName) || asText(fallbackFamily) || "Untitled Font";
  const styleName = asText(info?.styleName) || "Regular";
  const fullName = asText(info?.fullName) || `${familyName} ${styleName}`;
  const version = asText(info?.version).replace(/^Version\s+/i, "") || "1.000";
  const designer = asText(info?.designer);
  const manufacturer = asText(info?.manufacturer) || designer || "FontSeru";
  const manufacturerURL = asText(info?.manufacturerURL);
  const license = asText(info?.license) || "All Rights Reserved";
  const licenseURL = asText(info?.licenseURL);
  const copyright = asText(info?.copyright) || `Copyright © ${new Date().getFullYear()} ${familyName}`;
  const description = asText(info?.description);
  const postscriptName = sanitizePostScriptName(familyName, styleName, asText(info?.postscriptName));
  const uniqueID = asText(info?.uniqueID) || `${manufacturer}:${postscriptName}:Version ${version}`;
  const styleLink = fontStyleLinkMetadata(styleName);

  return {
    familyName,
    styleName,
    fullName,
    postscriptName,
    designer,
    copyright,
    version,
    description,
    license,
    licenseURL,
    manufacturer,
    manufacturerURL,
    uniqueID,
    ...styleLink,
  };
}


/**
 * Build the name-record object opentype.js's `name.make()` encoder expects.
 *
 * opentype.js's encoder indexes its input by platform first, then by field,
 * then by language (e.g. `{ windows: { fontFamily: { en: "X" } } }`) — the
 * mirror image of the flat `{ fontFamily: { en: "X" } }` shape one might
 * reasonably expect. Passing the flat shape doesn't just drop names
 * silently: the encoder's platform lookup fails for every field and it
 * throws ('Name table entry "en" does not exist...'), so OTF export never
 * produced a file at all before this fix.
 */
function toOpenTypeNames(info: NormalizedFontMetadata): Record<string, Record<string, Record<string, string>>> {
  const fields: Record<string, Record<string, string>> = {
    fontFamily: localized(info.familyName),
    fontSubfamily: localized(info.styleName),
    uniqueID: localized(info.uniqueID),
    fullName: localized(info.fullName),
    version: localized(`Version ${info.version}`),
    postScriptName: localized(info.postscriptName),
    manufacturer: localized(info.manufacturer),
    designer: localized(info.designer || "FontSeru"),
    license: localized(info.license),
    copyright: localized(info.copyright),
    preferredFamily: localized(info.familyName),
    preferredSubfamily: localized(info.styleName),
  };
  if (info.description) fields.description = localized(info.description);
  if (info.licenseURL) fields.licenseURL = localized(info.licenseURL);
  if (info.manufacturerURL) fields.manufacturerURL = localized(info.manufacturerURL);
  return { windows: fields };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeMetric(value: unknown, fallback: number): number {
  const n = finiteNumber(value);
  return n == null ? fallback : Math.round(n);
}

/**
 * Font-level metrics are never allowed to block export. Values outside the
 * supported OpenType/TrueType range fall back to a conservative 1000 UPM
 * coordinate system while preserving valid project values whenever possible.
 */
export function normalizeFontMetrics(metrics: Partial<FontMetrics> | null | undefined): FontMetrics {
  const rawUpm = safeMetric(metrics?.unitsPerEm, DEFAULT_UPM);
  const unitsPerEm = rawUpm >= 16 && rawUpm <= 16384 ? rawUpm : DEFAULT_UPM;
  const ascFallback = Math.round(unitsPerEm * 0.8);
  const descFallback = -Math.round(unitsPerEm * 0.2);

  const rawAscender = safeMetric(metrics?.ascender, ascFallback);
  const rawDescender = safeMetric(metrics?.descender, descFallback);
  const ascender = Math.min(MAX_FONT_COORD, rawAscender > 0 ? rawAscender : ascFallback);
  const descender = Math.max(MIN_FONT_COORD, rawDescender <= 0 ? rawDescender : descFallback);
  const capHeightRaw = safeMetric(metrics?.capHeight, Math.round(ascender * 0.875));
  const xHeightRaw = safeMetric(metrics?.xHeight, Math.round(ascender * 0.625));

  return {
    unitsPerEm,
    ascender,
    baseline: 0,
    descender,
    capHeight: Math.max(0, Math.min(ascender, capHeightRaw)),
    xHeight: Math.max(0, Math.min(ascender, xHeightRaw)),
  };
}

function isUnicodeScalar(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 0x10ffff
    && !(value >= 0xd800 && value <= 0xdfff);
}

function clampFontCoord(value: number): number {
  return Math.max(MIN_FONT_COORD, Math.min(MAX_FONT_COORD, Math.round(value)));
}

function safePoint(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const point = value as { x?: unknown; y?: unknown };
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  if (x == null || y == null) return null;
  return { x: clampFontCoord(x), y: clampFontCoord(y) };
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}


interface ExportContourGeometry {
  contour: Contour;
  polygon: { x: number; y: number }[];
  signedArea: number;
  absArea: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function cubicPointAt(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Flatten just enough for containment/orientation tests. The actual exported
 * outline remains the original Bézier geometry; these samples are never
 * written into the font.
 */
function flattenContourForExport(contour: Contour, curveSteps = 16): { x: number; y: number }[] {
  const nodes = contour.nodes ?? [];
  if (!nodes.length) return [];

  const points: { x: number; y: number }[] = [{ ...nodes[0].point }];
  const segmentCount = contour.closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const from = nodes[i];
    const to = nodes[(i + 1) % nodes.length];
    if (from.handleOut || to.handleIn) {
      const c1 = from.handleOut ?? from.point;
      const c2 = to.handleIn ?? to.point;
      for (let step = 1; step <= curveSteps; step++) {
        points.push(cubicPointAt(from.point, c1, c2, to.point, step / curveSteps));
      }
    } else {
      points.push({ ...to.point });
    }
  }
  return points;
}

function polygonSignedArea(points: { x: number; y: number }[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

function polygonBounds(points: { x: number; y: number }[]): ExportContourGeometry["bounds"] {
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function pointInPolygonForExport(
  point: { x: number; y: number },
  polygon: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-12) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function boundsContainForExport(
  outer: ExportContourGeometry["bounds"],
  inner: ExportContourGeometry["bounds"],
): boolean {
  const eps = 1e-6;
  return outer.minX <= inner.minX + eps
    && outer.minY <= inner.minY + eps
    && outer.maxX >= inner.maxX - eps
    && outer.maxY >= inner.maxY - eps;
}

/**
 * Reverse a contour without changing its curve. When traversal reverses,
 * incoming/outgoing Bézier handles swap roles at every node.
 */
function reverseContourForExport(contour: Contour): Contour {
  return {
    ...contour,
    nodes: [...contour.nodes].reverse().map((node) => ({
      ...node,
      point: { ...node.point },
      handleIn: node.handleOut ? { ...node.handleOut } : null,
      handleOut: node.handleIn ? { ...node.handleIn } : null,
    })),
  };
}

/**
 * Normalize winding PER VECTOR OBJECT before all contours are flattened into
 * a single sfnt glyph.
 *
 * FontSeru deliberately renders separate objects as separate SVG paths. That
 * means two independent filled shapes may overlap without subtracting from
 * each other. In an exported font, however, every contour lives in one glyph
 * outline and a rasterizer applies winding to the combined set. If independent
 * outer contours happen to have opposite directions, their overlap can cancel
 * and become an accidental hole.
 *
 * Preserve FontSeru's object semantics by normalizing every object's outer
 * contour to the requested format convention, then alternating direction by
 * nesting depth for true counters/islands inside THAT SAME object. The default
 * is TrueType (outer clockwise); the CFF/OTF writer requests the inverse.
 *
 * We intentionally do not infer holes across different VectorObjects. A shape
 * placed inside or across another object is still independent ink in the editor
 * and must stay independent ink after export.
 */
function normalizeObjectContourDirections(contours: Contour[], outerClockwise = true): Contour[] {
  if (contours.length <= 1) {
    if (!contours.length) return contours;
    const polygon = flattenContourForExport(contours[0]);
    const area = polygonSignedArea(polygon);
    if (Math.abs(area) <= 1e-6) return contours;
    const isClockwise = area < 0;
    return isClockwise === outerClockwise
      ? contours
      : [reverseContourForExport(contours[0])];
  }

  const geometry: ExportContourGeometry[] = contours.map((contour) => {
    const polygon = flattenContourForExport(contour);
    const signedArea = polygonSignedArea(polygon);
    return {
      contour,
      polygon,
      signedArea,
      absArea: Math.abs(signedArea),
      bounds: polygonBounds(polygon),
    };
  });

  return geometry.map((item, index) => {
    if (item.polygon.length < 3 || item.absArea <= 1e-6) return item.contour;

    const probe = item.polygon[0];
    let depth = 0;
    for (let otherIndex = 0; otherIndex < geometry.length; otherIndex++) {
      if (otherIndex === index) continue;
      const other = geometry[otherIndex];

      // A true container must be geometrically larger. This keeps coincident
      // duplicate contours and ordinary overlaps at the same nesting level.
      if (other.absArea <= item.absArea + 1e-6) continue;
      if (!boundsContainForExport(other.bounds, item.bounds)) continue;
      if (pointInPolygonForExport(probe, other.polygon)) depth++;
    }

    const shouldBeClockwise = depth % 2 === 0 ? outerClockwise : !outerClockwise;
    const isClockwise = item.signedArea < 0;
    return shouldBeClockwise === isClockwise
      ? item.contour
      : reverseContourForExport(item.contour);
  });
}

function sanitizeContour(contour: Contour): Contour | null {
  const nodes: PathNode[] = [];
  for (const node of contour.nodes ?? []) {
    const point = safePoint(node?.point);
    if (!point) continue;
    const handleIn = safePoint(node?.handleIn);
    const handleOut = safePoint(node?.handleOut);
    if (nodes.length && samePoint(nodes[nodes.length - 1].point, point) && !handleIn && !handleOut) continue;
    nodes.push({
      id: node?.id || shortId("node"),
      point,
      handleIn,
      handleOut,
      type: node?.type === "smooth" || node?.type === "symmetric" ? node.type : "corner",
    });
  }

  if (nodes.length > 1 && samePoint(nodes[0].point, nodes[nodes.length - 1].point)) {
    nodes.pop();
  }
  if (nodes.length < 2) return null;

  return {
    id: contour.id || shortId("contour"),
    nodes,
    // sfnt outlines are filled contours. Closing here keeps a recoverable
    // editor-side open contour from producing a malformed font outline.
    closed: true,
  };
}

function exportableObjects(glyph: Glyph): VectorObject[] {
  const out: VectorObject[] = [];
  for (const obj of glyph.outline?.objects ?? []) {
    try {
      if (obj.kind === "shape" || obj.kind === "expanded") out.push(obj);
      else {
        const expanded = expandStrokeObject(obj);
        if (expanded) out.push(expanded);
      }
    } catch (error) {
      console.warn(`[FontSeru] Skipping malformed stroke object in U+${glyph.unicode.toString(16).toUpperCase()}.`, error);
    }
  }
  return out;
}

function sanitizeGlyph(glyph: Glyph, metrics: FontMetrics): Glyph | null {
  if (!isUnicodeScalar(glyph.unicode)) return null;
  const fallbackAdvance = Math.max(1, Math.round(metrics.unitsPerEm * 0.6));
  const rawAdvance = finiteNumber(glyph.advanceWidth);
  const advanceWidth = Math.max(1, Math.min(65535, Math.round(rawAdvance != null && rawAdvance > 0 ? rawAdvance : fallbackAdvance)));
  const objects: VectorObject[] = [];

  for (const obj of exportableObjects(glyph)) {
    const sanitizedContours = (obj.contours ?? [])
      .map(sanitizeContour)
      .filter((contour): contour is Contour => contour != null);
    if (!sanitizedContours.length) continue;

    const contours = normalizeObjectContourDirections(sanitizedContours);
    objects.push({
      ...obj,
      id: obj.id || shortId("obj"),
      kind: obj.kind === "expanded" ? "expanded" : "shape",
      contours,
    });
  }

  const unicodes = [...new Set([glyph.unicode, ...(glyph.unicodes ?? [])].filter(isUnicodeScalar))];
  return {
    ...glyph,
    unicode: glyph.unicode,
    unicodes,
    advanceWidth,
    lsb: Number.isFinite(glyph.lsb) ? Math.round(glyph.lsb) : 0,
    rsb: Number.isFinite(glyph.rsb) ? Math.round(glyph.rsb) : 0,
    outline: { objects },
    components: [],
  };
}

function syntheticSpace(metrics: FontMetrics): Glyph {
  return {
    char: " ",
    unicode: 0x20,
    unicodes: [0x20],
    name: "space",
    category: "symbols",
    advanceWidth: Math.max(1, Math.round(metrics.unitsPerEm * 0.5)),
    lsb: 0,
    rsb: 0,
    outline: { objects: [] },
    components: [],
  };
}

function prepareGlyphs(glyphs: GlyphMap, metrics: FontMetrics): Glyph[] {
  const byUnicode = new Map<number, Glyph>();
  for (const glyph of Object.values(glyphs ?? {})) {
    const clean = sanitizeGlyph(glyph, metrics);
    if (!clean || byUnicode.has(clean.unicode)) continue;
    byUnicode.set(clean.unicode, clean);
  }

  // A usable font should always have a space even if the editor's current
  // navigation set does not expose one.
  if (!byUnicode.has(0x20)) byUnicode.set(0x20, syntheticSpace(metrics));

  return [...byUnicode.values()].sort((a, b) => a.unicode - b.unicode);
}

export function normalizeExportFontData(input: {
  glyphs: GlyphMap;
  metrics: Partial<FontMetrics> | null | undefined;
  info: Partial<FontInfo> | null | undefined;
  fontName?: string;
  kerningPairs?: KerningPairs;
}): NormalizedExportFontData {
  const metrics = normalizeFontMetrics(input.metrics);
  const info = normalizeFontMetadata(input.info, input.fontName || input.info?.familyName || "Untitled Font");
  const glyphs = prepareGlyphs(input.glyphs, metrics);
  return {
    familyName: info.familyName,
    subfamilyName: info.styleName,
    fullName: info.fullName,
    postScriptName: info.postscriptName,
    version: info.version,
    creator: info.designer || "FontSeru",
    license: info.license,
    unitsPerEm: metrics.unitsPerEm,
    ascender: metrics.ascender,
    descender: metrics.descender,
    glyphs,
    metrics,
    info,
    kerningPairs: input.kerningPairs ?? {},
  };
}

function appendContour(path: opentype.Path, contour: Contour): void {
  if (contour.nodes.length < 2) return;
  const first = contour.nodes[0];
  path.moveTo(first.point.x, first.point.y);
  const segmentCount = contour.closed ? contour.nodes.length : contour.nodes.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const from = contour.nodes[i];
    const to = contour.nodes[(i + 1) % contour.nodes.length];
    if (from.handleOut || to.handleIn) {
      const c1 = from.handleOut ?? from.point;
      const c2 = to.handleIn ?? to.point;
      path.curveTo(c1.x, c1.y, c2.x, c2.y, to.point.x, to.point.y);
    } else {
      path.lineTo(to.point.x, to.point.y);
    }
  }
  if (contour.closed) path.close();
}

function glyphName(glyph: Glyph): string {
  const fallback = `uni${glyph.unicode.toString(16).toUpperCase().padStart(4, "0")}`;
  const raw = asText(glyph.name).normalize("NFKD").replace(/[^\x20-\x7E]/g, "");
  const clean = raw.replace(/[^A-Za-z0-9_.-]+/g, "");
  return clean || (glyph.unicode === 0x20 ? "space" : fallback);
}


/**
 * Build the glyph model used by the CFF writer. We re-run direction
 * normalization per VectorObject with the PostScript/CFF convention instead
 * of merely trusting whatever direction the editor stored.
 *
 * This is deliberately format-specific:
 *   TrueType: outer clockwise, counter counter-clockwise.
 *   CFF/OTF:  outer counter-clockwise, counter clockwise.
 *
 * Keeping the operation per object preserves FontSeru's visual rule that
 * independently drawn shapes remain additive even when they overlap.
 */
function glyphForOpenTypeCFF(glyph: Glyph): Glyph {
  return {
    ...glyph,
    outline: {
      objects: glyph.outline.objects.map((obj) => ({
        ...obj,
        contours: normalizeObjectContourDirections(obj.contours, false),
      })),
    },
  };
}

function glyphToOpenType(glyph: Glyph, index: number): opentype.Glyph {
  const path = new opentype.Path();
  for (const obj of glyph.outline.objects) {
    for (const contour of obj.contours) appendContour(path, contour);
  }

  const result = new opentype.Glyph({
    name: glyphName(glyph),
    unicode: glyph.unicode,
    advanceWidth: glyph.advanceWidth,
    path,
  });
  for (const cp of glyph.unicodes ?? []) {
    if (cp !== glyph.unicode && typeof (result as any).addUnicode === "function") (result as any).addUnicode(cp);
  }
  (result as any).index = index;
  return result;
}

function notdefGlyph(metrics: FontMetrics): opentype.Glyph {
  return new opentype.Glyph({
    name: ".notdef",
    advanceWidth: Math.max(1, Math.round(metrics.unitsPerEm * 0.5)),
    path: new opentype.Path(),
  });
}

function localized(value: string): Record<string, string> {
  return { en: value || " " };
}

function setNames(font: opentype.Font, info: NormalizedFontMetadata): void {
  // Replace, rather than mutate, the table. This guarantees that a malformed
  // imported/project name object cannot leak into the generated OTF.
  (font as any).names = toOpenTypeNames(info);
}

function buildOpenTypeFont(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
): { font: opentype.Font; glyphIndexByChar: Map<string, number> } {
  const otGlyphs: opentype.Glyph[] = [notdefGlyph(metrics)];
  const index = new Map<string, number>();
  glyphs.forEach((glyph, i) => {
    const gid = i + 1;
    otGlyphs.push(glyphToOpenType(glyph, gid));
    index.set(glyph.char, gid);
  });

  const font = new opentype.Font({
    familyName: info.familyName,
    styleName: info.styleName,
    fullName: info.fullName,
    postScriptName: info.postscriptName,
    designer: info.designer || "FontSeru",
    manufacturer: info.manufacturer,
    license: info.license,
    licenseURL: info.licenseURL,
    version: `Version ${info.version}`,
    description: info.description,
    copyright: info.copyright,
    unitsPerEm: metrics.unitsPerEm,
    ascender: metrics.ascender,
    descender: metrics.descender,
    glyphs: otGlyphs,
  } as any);
  setNames(font, info);

  const tables = ((font as any).tables ||= {});
  const os2 = tables.os2 ||= {};
  os2.sCapHeight = metrics.capHeight;
  os2.sxHeight = metrics.xHeight;
  os2.sTypoAscender = metrics.ascender;
  os2.sTypoDescender = metrics.descender;
  os2.usWinAscent = Math.max(0, metrics.ascender);
  os2.usWinDescent = Math.max(0, -metrics.descender);
  os2.usWeightClass = info.weightClass;
  os2.fsSelection = info.fsSelection;

  const head = tables.head ||= {};
  head.macStyle = info.macStyle;

  const post = tables.post ||= {};
  post.italicAngle = info.italicAngle;

  return { font, glyphIndexByChar: index };
}

function u16(view: DataView, off: number): number { return view.getUint16(off, false); }
function u32(view: DataView, off: number): number { return view.getUint32(off, false); }
function writeTag(view: DataView, off: number, tag: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(off + i, tag.charCodeAt(i) || 0x20);
}
function tagAt(view: DataView, off: number): string {
  return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}
function checksum(bytes: Uint8Array): number {
  let sum = 0 >>> 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const a = bytes[i] ?? 0, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0, d = bytes[i + 3] ?? 0;
    sum = (sum + (((a << 24) | (b << 16) | (c << 8) | d) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}
function align4(n: number): number { return (n + 3) & ~3; }

function makeKernTable(pairs: KerningPairs, glyphIndexByChar: Map<string, number>): Uint8Array | null {
  const records: { left: number; right: number; value: number }[] = [];
  for (const [key, rawValue] of Object.entries(pairs ?? {})) {
    const pair = parseKerningKey(key);
    if (!pair) continue;
    const left = glyphIndexByChar.get(pair.left);
    const right = glyphIndexByChar.get(pair.right);
    if (left == null || right == null || !Number.isFinite(rawValue)) continue;
    const value = Math.max(-32768, Math.min(32767, Math.round(rawValue)));
    if (value) records.push({ left, right, value });
  }
  if (!records.length) return null;
  records.sort((a, b) => a.left - b.left || a.right - b.right);
  const nPairs = records.length;
  const maxPow2 = 2 ** Math.floor(Math.log2(Math.max(1, nPairs)));
  const searchRange = maxPow2 * 6;
  const entrySelector = Math.floor(Math.log2(maxPow2));
  const rangeShift = nPairs * 6 - searchRange;
  const length = 14 + nPairs * 6;
  const out = new Uint8Array(4 + length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, false); view.setUint16(2, 1, false);
  view.setUint16(4, 0, false); view.setUint16(6, length, false); view.setUint16(8, 1, false);
  view.setUint16(10, nPairs, false); view.setUint16(12, searchRange, false);
  view.setUint16(14, entrySelector, false); view.setUint16(16, rangeShift, false);
  records.forEach((rec, i) => {
    const off = 18 + i * 6;
    view.setUint16(off, rec.left, false);
    view.setUint16(off + 2, rec.right, false);
    view.setInt16(off + 4, rec.value, false);
  });
  return out;
}

/** Add/replace a classic horizontal format-0 `kern` table in an sfnt font. */
export function injectKernTable(buffer: ArrayBuffer, pairs: KerningPairs, glyphIndexByChar: Map<string, number>): ArrayBuffer {
  const kern = makeKernTable(pairs, glyphIndexByChar);
  if (!kern) return buffer.slice(0);
  const input = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const numTables = u16(view, 4);
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const d = 12 + i * 16;
    const tag = tagAt(view, d);
    if (tag === "kern") continue;
    const offset = u32(view, d + 8), length = u32(view, d + 12);
    if (offset + length > input.length) throw new Error("Generated font has a malformed sfnt table directory.");
    const data = input.slice(offset, offset + length);
    if (tag === "head" && data.length >= 12) data.fill(0, 8, 12);
    tables.push({ tag, data });
  }
  tables.push({ tag: "kern", data: kern });
  tables.sort((a, b) => a.tag.localeCompare(b.tag));

  const count = tables.length;
  const maxPow2 = 2 ** Math.floor(Math.log2(count));
  const searchRange = maxPow2 * 16;
  const entrySelector = Math.floor(Math.log2(maxPow2));
  const rangeShift = count * 16 - searchRange;
  let cursor = 12 + count * 16;
  const total = cursor + tables.reduce((n, t) => n + align4(t.data.length), 0);
  const output = new Uint8Array(total);
  const ov = new DataView(output.buffer);
  for (let i = 0; i < 4; i++) output[i] = input[i];
  ov.setUint16(4, count, false); ov.setUint16(6, searchRange, false);
  ov.setUint16(8, entrySelector, false); ov.setUint16(10, rangeShift, false);

  let headOffset = -1;
  tables.forEach((table, i) => {
    const d = 12 + i * 16;
    writeTag(ov, d, table.tag);
    ov.setUint32(d + 4, checksum(table.data), false);
    ov.setUint32(d + 8, cursor, false);
    ov.setUint32(d + 12, table.data.length, false);
    output.set(table.data, cursor);
    if (table.tag === "head") headOffset = cursor;
    cursor += align4(table.data.length);
  });

  if (headOffset >= 0) {
    const sum = checksum(output);
    ov.setUint32(headOffset + 8, (0xB1B0AFBA - sum) >>> 0, false);
  }
  return output.buffer;
}

function signatureFor(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return String.fromCharCode(...bytes);
}

export function validateGeneratedFont(
  buffer: ArrayBuffer,
  format: "otf" | "ttf",
  expected?: { familyName?: string; hasUpperA?: boolean },
): opentype.Font {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 64) {
    throw new Error(`Generated ${format.toUpperCase()} data is incomplete.`);
  }

  const bytes = new Uint8Array(buffer, 0, 4);
  const tag = signatureFor(buffer);
  const validSignature = format === "otf"
    ? tag === "OTTO"
    : (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || tag === "true";
  if (!validSignature) throw new Error(`Generated ${format.toUpperCase()} data has an invalid sfnt signature.`);

  try {
    const parsed = opentype.parse(buffer.slice(0));
    const unitsPerEm = (parsed as any).unitsPerEm;
    const glyphCount = (parsed as any).glyphs?.length ?? 0;
    if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) {
      throw new Error("unitsPerEm is invalid");
    }
    if (!Number.isFinite(glyphCount) || glyphCount < 2) {
      throw new Error("glyph table is incomplete");
    }
    const family = getParsedFontName((parsed as any).names, "fontFamily", "");
    if (!family) throw new Error("family name is missing");
    if (expected?.familyName && family !== expected.familyName) {
      throw new Error(`family name mismatch (expected "${expected.familyName}", got "${family}")`);
    }
    if (expected?.hasUpperA && typeof (parsed as any).charToGlyphIndex === "function") {
      const aIndex = (parsed as any).charToGlyphIndex("A");
      if (!Number.isFinite(aIndex) || aIndex <= 0) throw new Error('encoded glyph "A" is missing');
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Generated ${format.toUpperCase()} failed parser validation: ${detail}`);
  }
}

function generateOTFBase(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
): { buffer: ArrayBuffer; glyphIndexByChar: Map<string, number> } {
  // The shared export model is normalized for TrueType. CFF/OpenType uses
  // the opposite canonical direction, so convert only for the OTF writer.
  const cffGlyphs = glyphs.map(glyphForOpenTypeCFF);
  const { font, glyphIndexByChar } = buildOpenTypeFont(cffGlyphs, metrics, info);
  const buffer = font.toArrayBuffer();
  validateGeneratedFont(buffer, "otf", {
    familyName: info.familyName,
    hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
  });
  return { buffer, glyphIndexByChar };
}

function generateOTF(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
  kerningPairs: KerningPairs,
): ArrayBuffer {
  const base = generateOTFBase(glyphs, metrics, info);
  if (!Object.keys(kerningPairs ?? {}).length) return base.buffer;

  // Kerning is an enhancement, never a reason to lose a valid base font.
  try {
    const withKerning = injectKernTable(base.buffer, kerningPairs, base.glyphIndexByChar);
    validateGeneratedFont(withKerning, "otf", {
      familyName: info.familyName,
      hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
    });
    return withKerning;
  } catch (error) {
    console.warn("[FontSeru] Kerning export skipped; using the valid base OTF.", error);
    return base.buffer;
  }
}

function glyphToTrueTypeInput(glyph: Glyph): TrueTypeGlyphInput {
  const contours = glyph.outline.objects.flatMap((obj) =>
    obj.contours.map((contour) => ({
      nodes: contour.nodes.map((node) => ({
        point: { x: node.point.x, y: node.point.y },
        handleIn: node.handleIn ? { x: node.handleIn.x, y: node.handleIn.y } : null,
        handleOut: node.handleOut ? { x: node.handleOut.x, y: node.handleOut.y } : null,
      })),
    })),
  );

  return {
    name: glyphName(glyph),
    unicodes: glyph.unicodes?.length ? glyph.unicodes : [glyph.unicode],
    advanceWidth: glyph.advanceWidth,
    contours,
  };
}

function generateTTFBase(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
): { buffer: ArrayBuffer; glyphIndexByChar: Map<string, number> } {
  // TTF is now written directly from FontSeru's normalized glyph model.
  // There is no SVG intermediary and no OTF -> TTF conversion step.
  const result = buildTrueTypeFont({
    unitsPerEm: metrics.unitsPerEm,
    ascender: metrics.ascender,
    descender: metrics.descender,
    capHeight: metrics.capHeight,
    xHeight: metrics.xHeight,
    metadata: {
      familyName: info.familyName,
      subfamilyName: info.styleName,
      fullName: info.fullName,
      postScriptName: info.postscriptName,
      version: info.version,
      creator: info.designer || "FontSeru",
      manufacturer: info.manufacturer || "FontSeru",
      manufacturerURL: info.manufacturerURL,
      uniqueID: info.uniqueID,
      copyright: info.copyright,
      description: info.description,
      license: info.license,
      licenseURL: info.licenseURL,
      weightClass: info.weightClass,
      fsSelection: info.fsSelection,
      macStyle: info.macStyle,
      italicAngle: info.italicAngle,
    },
    glyphs: glyphs.map(glyphToTrueTypeInput),
  });

  const glyphIndexByChar = new Map<string, number>();
  for (const glyph of glyphs) {
    const gid = result.glyphIndexByUnicode.get(glyph.unicode);
    if (gid != null) glyphIndexByChar.set(glyph.char, gid);
  }

  validateGeneratedFont(result.buffer, "ttf", {
    familyName: info.familyName,
    hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
  });

  return { buffer: result.buffer, glyphIndexByChar };
}

function generateTTF(
  glyphs: Glyph[],
  metrics: FontMetrics,
  info: NormalizedFontMetadata,
  kerningPairs: KerningPairs,
): ArrayBuffer {
  const base = generateTTFBase(glyphs, metrics, info);
  if (!Object.keys(kerningPairs ?? {}).length) return base.buffer;

  // Kerning is optional. A valid base TTF always wins over a broken kern
  // injection, and the technical reason remains visible in the console.
  try {
    const withKerning = injectKernTable(base.buffer, kerningPairs, base.glyphIndexByChar);
    validateGeneratedFont(withKerning, "ttf", {
      familyName: info.familyName,
      hasUpperA: glyphs.some((glyph) => glyph.unicode === 0x41 || glyph.unicodes?.includes(0x41) === true),
    });
    return withKerning;
  } catch (error) {
    console.warn("[FontSeru] Kerning export skipped; using the valid base TTF.", error);
    return base.buffer;
  }
}

function technicalMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exportOTF(glyphs: GlyphMap, metrics: FontMetrics, info: FontInfo, kerningPairs: KerningPairs): ArrayBuffer {
  const data = normalizeExportFontData({ glyphs, metrics, info, fontName: info?.familyName, kerningPairs });
  return generateOTF(data.glyphs, data.metrics, data.info, data.kerningPairs);
}

export async function exportTTF(glyphs: GlyphMap, metrics: FontMetrics, info: FontInfo, kerningPairs: KerningPairs): Promise<ArrayBuffer> {
  const data = normalizeExportFontData({ glyphs, metrics, info, fontName: info?.familyName, kerningPairs });
  return generateTTF(data.glyphs, data.metrics, data.info, data.kerningPairs);
}

export async function generateFontFiles(
  glyphs: GlyphMap,
  metrics: FontMetrics,
  info: FontInfo,
  kerningPairs: KerningPairs,
  format: ExportFontFormat,
): Promise<GeneratedFontFile[]> {
  const data = normalizeExportFontData({
    glyphs,
    metrics,
    info,
    fontName: info?.familyName,
    kerningPairs,
  });
  const files: GeneratedFontFile[] = [];

  // Generate both selected binaries before the caller opens any Save As UI.
  // Each format is independent: no OTF->TTF rename/conversion chain exists.
  if (format === "ttf" || format === "both") {
    try {
      const ttf = generateTTF(data.glyphs, data.metrics, data.info, data.kerningPairs);
      files.push({ extension: "ttf", mimeType: "font/ttf", buffer: ttf });
    } catch (error) {
      console.error("[FontSeru] TTF generation failed:", error);
      throw new Error(`Unable to generate TTF. ${technicalMessage(error)}`);
    }
  }

  if (format === "otf" || format === "both") {
    try {
      const otf = generateOTF(data.glyphs, data.metrics, data.info, data.kerningPairs);
      files.push({ extension: "otf", mimeType: "font/otf", buffer: otf });
    } catch (error) {
      console.error("[FontSeru] OTF generation failed:", error);
      throw new Error(`Unable to generate OTF. ${technicalMessage(error)}`);
    }
  }

  return files;
}
function commandContours(commands: any[]): Contour[] {
  const contours: Contour[] = [];
  let current: Contour | null = null;
  let last: PathNode | null = null;
  const start = (x: number, y: number) => {
    current = { id: shortId("contour"), nodes: [], closed: false };
    contours.push(current);
    const node: PathNode = { id: shortId("node"), point: { x, y }, handleIn: null, handleOut: null, type: "corner" };
    current.nodes.push(node); last = node;
  };
  const addLine = (x: number, y: number) => {
    if (!current) start(x, y);
    else {
      const node: PathNode = { id: shortId("node"), point: { x, y }, handleIn: null, handleOut: null, type: "corner" };
      current.nodes.push(node); last = node;
    }
  };
  for (const cmd of commands) {
    if (cmd.type === "M") {
      start(cmd.x, cmd.y);
      continue;
    }
    if (cmd.type === "L") {
      addLine(cmd.x, cmd.y);
      continue;
    }

    // Assignments inside start()/addLine() are intentionally hidden behind
    // closures; use stable locals so TypeScript does not incorrectly narrow
    // the mutable parser state to `never`.
    const activeContour = current as Contour | null;
    const activeNode = last as PathNode | null;
    if (cmd.type === "C" && activeContour && activeNode) {
      activeNode.handleOut = { x: cmd.x1, y: cmd.y1 };
      const node: PathNode = { id: shortId("node"), point: { x: cmd.x, y: cmd.y }, handleIn: { x: cmd.x2, y: cmd.y2 }, handleOut: null, type: "smooth" };
      activeContour.nodes.push(node); last = node;
    } else if (cmd.type === "Q" && activeContour && activeNode) {
      const p0 = activeNode.point, p2 = { x: cmd.x, y: cmd.y }, q = { x: cmd.x1, y: cmd.y1 };
      activeNode.handleOut = { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) };
      const node: PathNode = {
        id: shortId("node"), point: p2,
        handleIn: { x: p2.x + (2 / 3) * (q.x - p2.x), y: p2.y + (2 / 3) * (q.y - p2.y) },
        handleOut: null, type: "smooth",
      };
      activeContour.nodes.push(node); last = node;
    } else if (cmd.type === "Z" && activeContour) {
      // opentype paths sometimes repeat the start point before Z; remove that
      // duplicate because FontSeru expresses closure with `closed`.
      if (activeContour.nodes.length > 1) {
        const a = activeContour.nodes[0].point, b = activeContour.nodes[activeContour.nodes.length - 1].point;
        if (a.x === b.x && a.y === b.y) activeContour.nodes.pop();
      }
      activeContour.closed = true;
      last = activeContour.nodes[activeContour.nodes.length - 1] ?? null;
    }
  }
  return contours.filter((c) => c.nodes.length > 0);
}

function parseOpenTypeKerning(font: any, charByGid: Map<number, string>): KerningPairs {
  const out: KerningPairs = {};
  const legacy = font.kerningPairs ?? {};
  for (const [pair, value] of Object.entries(legacy)) {
    const parts = pair.split(",");
    if (parts.length !== 2) continue;
    const left = charByGid.get(Number(parts[0])), right = charByGid.get(Number(parts[1]));
    if (left && right && Number.isFinite(Number(value))) out[kerningKey(left, right)] = Math.round(Number(value));
  }
  // GPOS pair positioning is exposed through getKerningValue even when no
  // legacy kern map exists. Probe only encoded glyphs to avoid an O(n^2)
  // scan across unencoded production glyphs.
  const encoded = [...charByGid.entries()];
  if (typeof font.getKerningValue === "function" && encoded.length <= 800) {
    for (const [lgid, left] of encoded) for (const [rgid, right] of encoded) {
      const v = font.getKerningValue(font.glyphs.get(lgid), font.glyphs.get(rgid));
      if (v) out[kerningKey(left, right)] = Math.round(v);
    }
  }
  return out;
}

export function importOpenType(buffer: ArrayBuffer): ImportedFontProject {
  const font = opentype.parse(buffer);
  const glyphs: GlyphMap = {};
  const charByGid = new Map<number, string>();
  const count = (font as any).glyphs.length;
  for (let gid = 0; gid < count; gid++) {
    const og: any = (font as any).glyphs.get(gid);
    const unicodes: number[] = Array.isArray(og.unicodes) && og.unicodes.length
      ? [...new Set<number>(og.unicodes.filter((u: unknown): u is number => typeof u === "number" && Number.isFinite(u)))]
      : (Number.isFinite(og.unicode) ? [Number(og.unicode)] : []);
    if (!unicodes.length) continue; // current editor navigation is Unicode-centric
    const cp = unicodes[0];
    const char = String.fromCodePoint(cp);
    const contours = commandContours(og.path?.commands ?? []);
    const advanceWidth = Math.round(og.advanceWidth ?? font.unitsPerEm * 0.6);
    const left = Number.isFinite(og.xMin) ? og.xMin : 0;
    const right = Number.isFinite(og.xMax) ? advanceWidth - og.xMax : 0;
    glyphs[char] = {
      char, unicode: cp, unicodes, name: og.name || undefined,
      category: categoryFor(cp),
      advanceWidth,
      lsb: Math.round(left),
      rsb: Math.round(right),
      outline: { objects: contours.length ? [{ id: shortId("obj"), kind: "shape", contours }] : [] },
      components: [],
    };
    charByGid.set(gid, char);
  }
  if (!Object.keys(glyphs).length) throw new Error("The font has no Unicode-mapped glyphs that FontSeru can edit.");

  const names: unknown = (font as any).names ?? {};
  const familyName = getParsedFontName(names, "fontFamily", "Imported Font");
  const styleName = getParsedFontName(names, "fontSubfamily", "Regular");
  const fullName = getParsedFontName(names, "fullName", `${familyName} ${styleName}`);
  const postscriptName = sanitizePostScriptName(
    familyName,
    styleName,
    getParsedFontName(names, "postScriptName", ""),
  );
  const os2: any = (font as any).tables?.os2 ?? {};
  const metrics: FontMetrics = {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    baseline: 0,
    descender: font.descender,
    capHeight: Number.isFinite(os2.sCapHeight) ? os2.sCapHeight : Math.round(font.ascender * 0.875),
    xHeight: Number.isFinite(os2.sxHeight) ? os2.sxHeight : Math.round(font.ascender * 0.625),
  };
  const versionName = getParsedFontName(names, "version", "").replace(/^Version\s+/i, "") || "1.000";
  const fontInfo: FontInfo = {
    familyName, styleName, fullName, postscriptName,
    version: versionName,
    designer: getParsedFontName(names, "designer", ""),
    copyright: getParsedFontName(names, "copyright", ""),
    description: getParsedFontName(names, "description", ""),
    license: getParsedFontName(names, "license", ""),
    licenseURL: getParsedFontName(names, "licenseURL", ""),
    manufacturer: getParsedFontName(names, "manufacturer", ""),
    manufacturerURL: getParsedFontName(names, "manufacturerURL", ""),
    uniqueID: getParsedFontName(names, "uniqueID", ""),
  };
  return { fontName: familyName, fontInfo, metrics, glyphs, kerningPairs: parseOpenTypeKerning(font as any, charByGid) };
}
