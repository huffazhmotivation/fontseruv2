import { create } from "zustand";
import type { UserPlan } from "@/auth/AuthProvider";
import type { GlyphMap, Glyph, GlyphFamily, FontStyle } from "@/types/glyph";
import type { GlyphOutline, StrokeCap, VectorObject } from "@/types/geometry";
import type { ToolId } from "@/types/tool";
import type { BrushSettings, BrushType } from "@/types/brush";
import { buildDefaultGlyphs } from "./defaultGlyphs";
import { cloneGlyphMap, familyFromRegular } from "./family";
import { generateBoldFromRegular, generateItalicFromRegular, type FamilyGenerationResult } from "./autoGenerate";
import { DEFAULT_METRICS, defaultFontInfo, type FontInfo, type FontMetrics } from "@/types/font";
import { BRUSH_PRESETS } from "@/brushes/presets";
import { cloneObject, deleteNodes } from "@/editor/nodeOps";
import { cloneObjectWithNewIds, translateObject, objectsBounds, scaleObject } from "@/editor/objectOps";
import { shortId } from "@/utils/id";
import { expandStrokeObject } from "@/brushes/strokeToOutline";
import { applyBooleanOp, type BooleanOp } from "@/editor/booleanOps";
import { composeMultilingualGlyphs, type MultilingualResult } from "@/glyph/multilingual";
import type { KerningPairs, KerningManualFlags, KerningOverridesByStyle, KerningOverrideManualByStyle, KerningContext } from "@/types/kerning";
import { kerningKey } from "@/types/kerning";
import { suggestKerningPair, autoKernAllAvailablePairs } from "@/kerning/autoKern";

export type Theme = "light" | "dark";
export type PenMode = "shape" | "line";
export type GlyphMetricKey = "advanceWidth" | "lsb" | "rsb";
export type GlyphMetricScope = "current" | "all";
export type SelectionSkewHandle = "skew-x-top" | "skew-x-bottom" | "skew-y-left" | "skew-y-right";

export interface NodeRef {
  contourId: string;
  nodeId: string;
}
export interface HandleRef extends NodeRef {
  part: "handleIn" | "handleOut";
}

export type GhostMode = "sample" | "family" | "image";

export interface GhostSettings {
  enabled: boolean;
  mode: GhostMode;
  opacity: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Data URL of a user-uploaded custom ghost/reference image, or null when
   * none has been set. Reference-only: never part of glyph/vector data. */
  imageSrc: string | null;
  /** Natural width/height ratio of imageSrc, so it renders without
   * stretching. Undefined until an image is uploaded. */
  imageAspect?: number;
}

interface HistoryEntry {
  glyphs: GlyphMap;
  /** Present only for atomic operations that mutate a non-active family style. */
  glyphsByStyle?: GlyphFamily;
  metrics: FontMetrics;
  kerningPairs: KerningPairs;
  kerningManual: KerningManualFlags;
  /** Optional so history created by pre-family operations remains compatible. */
  kerningOverridesByStyle?: KerningOverridesByStyle;
  kerningOverrideManualByStyle?: KerningOverrideManualByStyle;
  autoKernLastRun?: { processed: number; updated: number; preservedManual: number } | null;
}
const HISTORY_LIMIT = 120;

function normalizedFontMetric(metrics: FontMetrics, key: keyof FontMetrics, raw: number): number {
  const rounded = Math.round(raw);
  const limit = Math.max(1000, metrics.unitsPerEm * 4);
  if (key === "unitsPerEm") return Math.max(16, Math.min(16384, rounded));
  if (key === "ascender") return Math.max(Math.max(metrics.baseline, metrics.capHeight, metrics.xHeight) + 1, Math.min(limit, rounded));
  if (key === "descender") return Math.min(metrics.baseline - 1, Math.max(-limit, rounded));
  if (key === "baseline") return Math.max(metrics.descender + 1, Math.min(metrics.ascender - 1, rounded));
  if (key === "capHeight") return Math.max(metrics.descender, Math.min(metrics.ascender, rounded));
  if (key === "xHeight") return Math.max(metrics.descender, Math.min(metrics.ascender, rounded));
  return rounded;
}

function sameRef(a: NodeRef, b: NodeRef): boolean {
  return a.contourId === b.contourId && a.nodeId === b.nodeId;
}


function applyGlyphMetricPatch(
  glyph: Glyph,
  patch: Partial<Pick<Glyph, GlyphMetricKey>>
): Glyph {
  let next: Glyph = { ...glyph };

  // LSB is the left ink position in the editor. Moving it translates the
  // outline and the advance by the same amount, preserving the current RSB.
  if (patch.lsb !== undefined && Number.isFinite(patch.lsb)) {
    const nextLsb = Math.round(patch.lsb);
    const dx = nextLsb - next.lsb;
    next = {
      ...next,
      lsb: nextLsb,
      advanceWidth: Math.max(1, next.advanceWidth + dx),
      outline: { objects: next.outline.objects.map((o) => translateObject(o, dx, 0)) },
    };
  }

  // RSB is the distance from the rightmost ink edge to the advance boundary.
  // Changing it keeps the ink fixed and moves the advance boundary.
  if (patch.rsb !== undefined && Number.isFinite(patch.rsb)) {
    const nextRsb = Math.round(patch.rsb);
    next = {
      ...next,
      advanceWidth: Math.max(1, next.advanceWidth + (nextRsb - next.rsb)),
      rsb: nextRsb,
    };
  }

  // Direct Advance Width edits move the same right boundary. Keep the stored
  // RSB coherent with that movement instead of leaving stale metric metadata.
  if (patch.advanceWidth !== undefined && Number.isFinite(patch.advanceWidth)) {
    const nextAdvance = Math.max(1, Math.round(patch.advanceWidth));
    const delta = nextAdvance - next.advanceWidth;
    next = {
      ...next,
      advanceWidth: nextAdvance,
      rsb: next.rsb + delta,
    };
  }

  return next;
}

function applyGlyphMetricToMap(
  glyphs: GlyphMap,
  char: string,
  patch: Partial<Pick<Glyph, GlyphMetricKey>>,
  scope: GlyphMetricScope
): GlyphMap {
  if (scope === "all") {
    const next: GlyphMap = {};
    for (const [key, glyph] of Object.entries(glyphs)) {
      next[key] = applyGlyphMetricPatch(glyph, patch);
    }
    return next;
  }
  const glyph = glyphs[char];
  if (!glyph) return glyphs;
  return { ...glyphs, [char]: applyGlyphMetricPatch(glyph, patch) };
}



/**
 * Mirrors `AuthContextValue.plan` (src/auth/AuthProvider.tsx), which is the
 * single source of truth and is always derived fresh from `profiles.plan`.
 * This copy exists ONLY so store actions below (setFontStyle,
 * generateFromRegular, generateFamilyBold/Italic, openFamily) can enforce
 * the FREE/PRO lock at the actual entry point — not just in UI components —
 * so calling these actions directly (devtools, console, a different UI
 * path) can't bypass the lock. AuthProvider pushes updates here via
 * `setPlan` whenever `profiles.plan` changes; nothing in this file ever
 * computes or guesses a plan value itself.
 */
interface AppState {
  /** Synced from AuthProvider via `setPlan` (see the module doc comment
   * above); never computed here. Defaults to "free" (the safe default)
   * until the first sync happens. */
  plan: UserPlan;
  setPlan: (plan: UserPlan) => void;
  theme: Theme;
  fontName: string;
  fontInfo: FontInfo;
  projectFileName: string;
  /** Sketch Mode: an additive canvas mode for tablet/pen drawing. Does not
   * replace or alter normal mode; toggling it back off restores the usual UI. */
  sketchMode: boolean;
  /** Sketch Mode only: whether the right inspector drawer is slid open over
   * the canvas. Ignored outside Sketch Mode (the right panel is always
   * visible there, unaffected by this flag). */
  sketchRightPanelOpen: boolean;
  tool: ToolId;
  penMode: PenMode;
  /** Pen tool (Shape mode) only: when true, finishing an open path (Escape /
   * double-click the last point) auto-closes it into a filled shape instead
   * of leaving it open. Default false preserves the pre-existing behavior. */
  penAutoClose: boolean;
  lineWidth: number;
  lineCap: StrokeCap;
  brushCap: StrokeCap;
  /** When on, resizing/scaling a selected object keeps its stroke width
   * constant instead of scaling it with the object. Purely a transform-time
   * behavior flag; does not affect the brush/line default width elsewhere. */
  strokeWidthLocked: boolean;
  zoom: number;
  /** View center, in SVG coordinate space (Y-down). */
  pan: { x: number; y: number };
  fitNonce: number;
  showGrid: boolean;
  gridSize: number;
  showGuides: boolean;
  metrics: FontMetrics;
  ghost: GhostSettings;
  brush: BrushSettings;
  glyphMetricScope: GlyphMetricScope;
  glyphMetricFocus: GlyphMetricKey | null;

  /** Glyph map for the currently selected family style. */
  glyphs: GlyphMap;
  glyphsByStyle: GlyphFamily;
  fontStyle: FontStyle;
  activeChar: string;

  // Kerning (kept separate from glyph geometry — see types/kerning.ts)
  kerningPairs: KerningPairs;
  kerningManual: KerningManualFlags;
  /** Sparse style-specific layer; absence means inherit Shared kerningPairs. */
  kerningOverridesByStyle: KerningOverridesByStyle;
  kerningOverrideManualByStyle: KerningOverrideManualByStyle;
  autoKernLastRun: { processed: number; updated: number; preservedManual: number } | null;

  // Font Test Lab / Kerning editor overlay
  testLabOpen: boolean;
  testLabTab: "kerning" | "specimen";

  // Family Auto Generate overlay
  familyOpen: boolean;

  // Trace Image overlay (additive — image-to-vector tracing workspace)
  traceOpen: boolean;

  // Login modal (auth UI trigger) — additive UI state only, separate from
  // feature-locking (proModalOpen/proModalFeature below). Lets the
  // account button in TopBar/AuthWidget re-open the login popup on
  // demand; actual auth calls still live entirely in AuthProvider.
  loginModalOpen: boolean;

  // PRO feature-locking (Tracing/Family/Brush/Export limit) — additive UI
  // state only; plan itself always comes from AuthProvider/profiles, never
  // written here.
  proModalOpen: boolean;
  proModalFeature: "tracing" | "family" | "brush" | "export" | null;

  selectedObjectIds: string[];
  /** Transient transform UI state; geometry remains the source of truth and project format stays unchanged. */
  selectionSkewAngle: number;
  selectionSkewHandle: SelectionSkewHandle;
  selectedNodes: NodeRef[];
  selectedHandle: HandleRef | null;
  drawingContourId: string | null;
  liveOutline: GlyphOutline | null;
  clipboard: VectorObject[] | null;

  past: HistoryEntry[];
  future: HistoryEntry[];

  // chrome
  toggleTheme: () => void;
  toggleSketchMode: () => void;
  toggleSketchRightPanel: () => void;
  setFontName: (name: string) => void;
  setFontInfo: (patch: Partial<FontInfo>) => void;
  setProjectFileName: (name: string) => void;
  newProject: () => void;
  setTool: (tool: ToolId) => void;
  setPenMode: (mode: PenMode) => void;
  setPenAutoClose: (on: boolean) => void;
  setLineWidth: (w: number) => void;
  setLineCap: (cap: StrokeCap) => void;
  setBrushCap: (cap: StrokeCap) => void;
  toggleStrokeWidthLock: () => void;
  setZoom: (z: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  resetView: () => void;
  fitGlyph: () => void;
  toggleGrid: () => void;
  setGridSize: (n: number) => void;
  toggleGuides: () => void;
  setFontMetric: (key: keyof FontMetrics, value: number) => void;
  beginMetricDrag: () => void;
  setFontMetricLive: (key: keyof FontMetrics, value: number) => void;
  endMetricDrag: () => void;
  metricFocus: keyof FontMetrics | null;
  setMetricFocus: (key: keyof FontMetrics | null) => void;
  setActiveChar: (char: string) => void;
  setFontStyle: (style: FontStyle) => void;
  generateFromRegular: () => void;
  generateFamilyBold: (amount: number, replaceExisting?: boolean) => FamilyGenerationResult;
  generateFamilyItalic: (angle: number, replaceExisting?: boolean) => FamilyGenerationResult;
  setGhost: (patch: Partial<GhostSettings>) => void;
  setBrushType: (type: BrushType) => void;
  setBrush: (patch: Partial<BrushSettings>) => void;

  // glyph editing
  updateGlyphMetrics: (char: string, patch: Partial<Pick<Glyph, GlyphMetricKey>>, scope?: GlyphMetricScope) => void;
  setGlyphMetricScope: (scope: GlyphMetricScope) => void;
  setGlyphMetricFocus: (key: GlyphMetricKey | null) => void;
  beginGlyphMetricDrag: () => void;
  setGlyphMetricLive: (char: string, key: GlyphMetricKey, value: number, scope?: GlyphMetricScope) => void;
  endGlyphMetricDrag: () => void;
  commitOutline: (char: string, outline: GlyphOutline) => void;
  setLiveOutline: (outline: GlyphOutline | null) => void;
  updateSelectedObject: (patch: Partial<VectorObject>) => void;

  // object selection / clipboard / transforms
  selectObjects: (ids: string[], additive?: boolean) => void;
  clearObjectSelection: () => void;
  setSelectionSkewState: (angle: number, handle?: SelectionSkewHandle) => void;
  nudgeSelectedObjects: (dx: number, dy: number) => void;
  deleteSelectedObjects: () => void;
  /**
   * Deletes whichever nodes are currently selected (Node tool selection
   * state). Mirrors deleteSelectedObjects but for selectedNodes — used by
   * Sketch Mode's floating toolbar Delete button so it follows whichever
   * selection (nodes or objects) is currently active. Never touches
   * selectedObjectIds.
   */
  deleteSelectedNodes: () => void;
  expandSelectedStrokes: () => void;
  flipSelectedObjects: (axis: "horizontal" | "vertical") => void;
  booleanSelectedObjects: (op: BooleanOp) => void;
  togglePenAutoClose: () => void;
  /** Composes accented-Latin + a few symbol glyphs from existing Regular
   * glyphs (see src/glyph/multilingual.ts). Never touches Bold/Italic
   * directly — those pick the new Regular glyphs up the same way any other
   * Regular glyph does, via the existing Generate From Regular pipeline. */
  addMultilingualGlyphs: () => MultilingualResult;
  copySelection: () => void;
  cutSelection: () => void;
  pasteClipboard: () => void;
  groupSelectedObjects: () => void;
  ungroupSelectedObjects: () => void;

  // node selection
  selectNodes: (refs: NodeRef[], additive?: boolean) => void;
  toggleNodeSelection: (ref: NodeRef) => void;
  clearSelection: () => void;
  setSelectedHandle: (ref: HandleRef | null) => void;
  setDrawingContourId: (id: string | null) => void;

  // history / persistence
  undo: () => void;
  redo: () => void;
  hydrate: (patch: { glyphs?: GlyphMap; glyphsByStyle?: Partial<GlyphFamily>; fontStyle?: FontStyle; fontName?: string; fontInfo?: Partial<FontInfo>; projectFileName?: string; metrics?: Partial<FontMetrics>; kerningPairs?: KerningPairs; kerningManual?: KerningManualFlags; kerningOverridesByStyle?: KerningOverridesByStyle; kerningOverrideManualByStyle?: KerningOverrideManualByStyle; activeChar?: string; gridSize?: number; showGrid?: boolean; showGuides?: boolean; ghost?: Partial<GhostSettings>; brush?: BrushSettings }) => void;

  // kerning
  setKerningPair: (left: string, right: string, value: number) => void;
  applyKerningSuggestion: (left: string, right: string) => void;
  resetKerningPair: (left: string, right: string) => void;
  autoKernAllPairs: () => void;
  beginKerningDrag: () => void;
  setKerningPairLive: (left: string, right: string, value: number) => void;
  endKerningDrag: () => void;

  // Family kerning — additive layer over the existing Single Test API.
  setFamilyKerningPair: (context: KerningContext, left: string, right: string, value: number) => void;
  resetFamilyKerningPair: (context: KerningContext, left: string, right: string) => void;
  autoKernAllPairsForContext: (context: KerningContext) => void;
  beginFamilyKerningDrag: (context: KerningContext) => void;
  setFamilyKerningPairLive: (context: KerningContext, left: string, right: string, value: number) => void;
  endFamilyKerningDrag: () => void;

  // Test Lab overlay
  openTestLab: (tab?: "kerning" | "specimen") => void;
  closeTestLab: () => void;
  setTestLabTab: (tab: "kerning" | "specimen") => void;
  openFamily: () => void;
  closeFamily: () => void;

  // Trace Image overlay
  openTrace: () => void;
  closeTrace: () => void;
  /**
   * Applies a traced vector outline to a Regular-style glyph, always
   * targeting `glyphsByStyle.regular` regardless of which family style is
   * currently active in the main editor — the Trace Image panel shows the
   * Regular glyph set specifically. Fully undoable and keeps `glyphs` (the
   * active-style working copy) in sync when Regular happens to be active,
   * exactly like the other family-aware commit helpers above.
   */
  commitTracedGlyphOutline: (char: string, outline: GlyphOutline) => void;

  // PRO feature-locking modal ("Join PRO")
  openProModal: (feature: "tracing" | "family" | "brush" | "export") => void;
  closeProModal: () => void;

  // Login modal (auth UI trigger only — see loginModalOpen above)
  openLoginModal: () => void;
  closeLoginModal: () => void;
}

export const useAppStore = create<AppState>()((set, get) => {
  let kerningDragSnapshot: { kerningPairs: KerningPairs; kerningManual: KerningManualFlags } | null = null;
  let familyKerningDragSnapshot: {
    context: KerningContext;
    kerningPairs: KerningPairs;
    kerningManual: KerningManualFlags;
    kerningOverridesByStyle: KerningOverridesByStyle;
    kerningOverrideManualByStyle: KerningOverrideManualByStyle;
  } | null = null;
  let metricDragSnapshot: FontMetrics | null = null;
  let glyphMetricDragSnapshot: GlyphMap | null = null;
  function commit(nextGlyphs: GlyphMap) {
    const { glyphs, glyphsByStyle, fontStyle, metrics, past, kerningPairs, kerningManual } = get();
    set({
      glyphs: nextGlyphs,
      glyphsByStyle: { ...glyphsByStyle, [fontStyle]: nextGlyphs },
      past: [...past, { glyphs, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
      future: [],
    });
  }

  /** Same history stack as `commit`, for edits that touch kerning instead of glyph geometry. */
  function commitKerning(nextPairs: KerningPairs, nextManual: KerningManualFlags) {
    const { glyphs, metrics, past, kerningPairs, kerningManual } = get();
    set({
      kerningPairs: nextPairs,
      kerningManual: nextManual,
      past: [...past, { glyphs, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
      future: [],
    });
  }

  function commitFamilyStyleKerning(style: FontStyle, nextPairs: KerningPairs, nextManual: KerningManualFlags) {
    const state = get();
    set({
      kerningOverridesByStyle: { ...state.kerningOverridesByStyle, [style]: nextPairs },
      kerningOverrideManualByStyle: { ...state.kerningOverrideManualByStyle, [style]: nextManual },
      past: [
        ...state.past,
        {
          glyphs: state.glyphs,
          metrics: state.metrics,
          kerningPairs: state.kerningPairs,
          kerningManual: state.kerningManual,
          kerningOverridesByStyle: state.kerningOverridesByStyle,
          kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
        },
      ].slice(-HISTORY_LIMIT),
      future: [],
    });
  }

  function commitFamilyGeneration(
    targetStyle: "bold" | "italic",
    result: FamilyGenerationResult
  ): FamilyGenerationResult {
    if (result.glyphs === get().glyphsByStyle[targetStyle]) return result;
    const state = get();
    const nextFamily: GlyphFamily = { ...state.glyphsByStyle, [targetStyle]: result.glyphs };
    set({
      glyphsByStyle: nextFamily,
      glyphs: state.fontStyle === targetStyle ? result.glyphs : state.glyphs,
      past: [
        ...state.past,
        {
          glyphs: state.glyphs,
          glyphsByStyle: state.glyphsByStyle,
          metrics: state.metrics,
          kerningPairs: state.kerningPairs,
          kerningManual: state.kerningManual,
          kerningOverridesByStyle: state.kerningOverridesByStyle,
          kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
        },
      ].slice(-HISTORY_LIMIT),
      future: [],
      selectedObjectIds: [],
      selectedNodes: [],
      selectedHandle: null,
      drawingContourId: null,
      liveOutline: null,
    });
    return result;
  }

  /** Real (non-UI) enforcement point for PRO-only actions: used by every
   * store action below that must stay locked for FREE even if it's invoked
   * directly (console/devtools, a different UI path, etc.) instead of
   * through the gated buttons. Opens the existing ProUpsellModal instead of
   * performing the action. */
  function requirePro(feature: "tracing" | "family" | "brush" | "export"): boolean {
    if (get().plan === "pro") return true;
    set({ proModalOpen: true, proModalFeature: feature });
    return false;
  }

  function finalizeLive() {
    const { liveOutline, activeChar, glyphs } = get();
    if (!liveOutline) return;
    const glyph = glyphs[activeChar];
    if (!glyph) return set({ liveOutline: null });
    commit({ ...glyphs, [activeChar]: { ...glyph, outline: liveOutline } });
    set({ liveOutline: null });
  }

  function activeGlyph(): Glyph | undefined {
    const { glyphs, activeChar } = get();
    return glyphs[activeChar];
  }

  const initialRegular = buildDefaultGlyphs();
  const initialFamily = familyFromRegular(initialRegular);

  return {
    plan: "free",
    setPlan: (plan) => set({ plan }),
    theme: "dark",
    fontName: "Untitled Font",
    fontInfo: defaultFontInfo("Untitled Font"),
    projectFileName: "Untitled Font.fs",
    sketchMode: false,
    sketchRightPanelOpen: false,
    tool: "select",
    penMode: "shape",
    penAutoClose: false,
    lineWidth: 24,
    lineCap: "round",
    brushCap: "round",
    strokeWidthLocked: false,
    zoom: 100,
    pan: { x: 500, y: 500 },
    fitNonce: 0,
    showGrid: true,
    gridSize: 50,
    showGuides: true,
    metrics: { ...DEFAULT_METRICS },
    metricFocus: null,
    ghost: { enabled: true, mode: "sample", opacity: 0.12, scale: 1, offsetX: 0, offsetY: 0, imageSrc: null, imageAspect: undefined },
    brush: { type: "monoline", ...BRUSH_PRESETS.monoline.settings },
    glyphMetricScope: "current",
    glyphMetricFocus: null,

    glyphs: initialRegular,
    glyphsByStyle: initialFamily,
    fontStyle: "regular",
    activeChar: "A",

    kerningPairs: {},
    kerningManual: {},
    kerningOverridesByStyle: {},
    kerningOverrideManualByStyle: {},
    autoKernLastRun: null,
    testLabOpen: false,
    testLabTab: "specimen",
    familyOpen: false,
    traceOpen: false,
    loginModalOpen: false,
    proModalOpen: false,
    proModalFeature: null,

    selectedObjectIds: [],
    selectionSkewAngle: 0,
    selectionSkewHandle: "skew-x-top",
    selectedNodes: [],
    selectedHandle: null,
    drawingContourId: null,
    liveOutline: null,
    clipboard: null,

    past: [],
    future: [],

    toggleTheme: () => set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
    // Entering Sketch Mode nudges the tool to Brush (its whole purpose is
    // drawing); leaving it never forces a tool change, so normal mode is
    // left exactly as the user had it.
    toggleSketchMode: () =>
      set((s) => ({
        sketchMode: !s.sketchMode,
        tool: !s.sketchMode ? "brush" : s.tool,
        // Always start Sketch Mode's right drawer closed so canvas space
        // is maximized the moment Sketch Mode turns on.
        sketchRightPanelOpen: !s.sketchMode ? false : s.sketchRightPanelOpen,
      })),
    // Sketch Mode's right-panel drawer only; closing it on exit keeps every
    // re-entry into Sketch Mode starting from the same clean, canvas-first
    // state rather than remembering a stale open drawer.
    toggleSketchRightPanel: () => set((s) => ({ sketchRightPanelOpen: !s.sketchRightPanelOpen })),
    setFontName: (name) => set((s) => ({
      fontName: name,
      fontInfo: s.fontInfo.familyName === s.fontName ? { ...s.fontInfo, familyName: name, fullName: `${name} ${s.fontInfo.styleName}` } : s.fontInfo,
    })),
    setFontInfo: (patch) => set((s) => ({ fontInfo: { ...s.fontInfo, ...patch } })),
    setProjectFileName: (name) => set({ projectFileName: name }),
    newProject: () => {
      const name = "Untitled Font";
      const regular = buildDefaultGlyphs();
      const family = familyFromRegular(regular);
      set({
        fontName: name,
        fontInfo: defaultFontInfo(name),
        projectFileName: `${name}.fs`,
        metrics: { ...DEFAULT_METRICS },
        glyphs: regular,
        glyphsByStyle: family,
        fontStyle: "regular",
        activeChar: "A",
        kerningPairs: {},
        kerningManual: {},
        kerningOverridesByStyle: {},
        kerningOverrideManualByStyle: {},
        autoKernLastRun: null,
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
        clipboard: null,
        glyphMetricScope: "current",
        glyphMetricFocus: null,
        past: [],
        future: [],
      });
    },
    setTool: (tool) => {
      finalizeLive();
      set((s) => ({
        tool,
        drawingContourId: null,
        selectedNodes: tool === "node" ? s.selectedNodes : [],
        selectedHandle: tool === "node" ? s.selectedHandle : null,
        selectedObjectIds: tool === "select" ? s.selectedObjectIds : [],
      }));
    },
    setPenMode: (mode) => set({ penMode: mode }),
    setPenAutoClose: (on) => set({ penAutoClose: on }),
    togglePenAutoClose: () => set((s) => ({ penAutoClose: !s.penAutoClose })),
    setLineWidth: (w) => set({ lineWidth: Math.max(1, Math.round(w)) }),
    setLineCap: (cap) => set({ lineCap: cap }),
    setBrushCap: (cap) => set({ brushCap: cap }),
    toggleStrokeWidthLock: () => set((s) => ({ strokeWidthLocked: !s.strokeWidthLocked })),
    setZoom: (z) => set({ zoom: Math.min(800, Math.max(20, Math.round(z))) }),
    setPan: (pan) => set({ pan }),
    resetView: () => {
      const { metrics } = get();
      set({ zoom: 100, pan: { x: metrics.unitsPerEm / 2, y: (metrics.ascender - metrics.descender) / 2 } });
    },
    fitGlyph: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
    toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
    setGridSize: (n) => set({ gridSize: Math.min(200, Math.max(2, Math.round(n))) }),
    toggleGuides: () => set((s) => ({ showGuides: !s.showGuides })),
    setFontMetric: (key, value) => {
      const { metrics, glyphs, past, kerningPairs, kerningManual } = get();
      const nextValue = normalizedFontMetric(metrics, key, value);
      if (metrics[key] === nextValue) return;
      set({
        metrics: { ...metrics, [key]: nextValue },
        past: [...past, { glyphs, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },
    beginMetricDrag: () => {
      if (!metricDragSnapshot) metricDragSnapshot = { ...get().metrics };
    },
    setFontMetricLive: (key, value) =>
      set((s) => ({
        metrics: {
          ...s.metrics,
          [key]: normalizedFontMetric(s.metrics, key, value),
        },
      })),
    endMetricDrag: () => {
      if (!metricDragSnapshot) return;
      const before = metricDragSnapshot;
      metricDragSnapshot = null;
      const { metrics, glyphs, past, kerningPairs, kerningManual } = get();
      if (JSON.stringify(before) === JSON.stringify(metrics)) return;
      set({
        past: [...past, { glyphs, metrics: before, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },
    setMetricFocus: (key) => set({ metricFocus: key }),
    setActiveChar: (char) => {
      finalizeLive();
      set({ activeChar: char, selectedNodes: [], selectedHandle: null, selectedObjectIds: [], drawingContourId: null });
    },

    setFontStyle: (style) => {
      if (style === get().fontStyle) return;
      // Bold/Italic are PRO-only; Regular always stays open to everyone.
      if (style !== "regular" && !requirePro("family")) return;
      finalizeLive();
      const state = get();
      const nextGlyphs = state.glyphsByStyle[style];
      const nextActiveChar = nextGlyphs[state.activeChar]
        ? state.activeChar
        : Object.keys(nextGlyphs)[0] ?? state.activeChar;
      set({
        fontStyle: style,
        glyphs: nextGlyphs,
        activeChar: nextActiveChar,
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
        clipboard: null,
        glyphMetricFocus: null,
        past: [],
        future: [],
      });
    },

    generateFromRegular: () => {
      if (!requirePro("family")) return;
      finalizeLive();
      const state = get();
      if (state.fontStyle === "regular") return;
      const generated = cloneGlyphMap(state.glyphsByStyle.regular);
      const nextActiveChar = generated[state.activeChar]
        ? state.activeChar
        : Object.keys(generated)[0] ?? state.activeChar;
      set({
        glyphs: generated,
        glyphsByStyle: { ...state.glyphsByStyle, [state.fontStyle]: generated },
        activeChar: nextActiveChar,
        selectedObjectIds: [],
        selectedNodes: [],
        selectedHandle: null,
        drawingContourId: null,
        liveOutline: null,
        clipboard: null,
        glyphMetricFocus: null,
        past: [],
        future: [],
      });
    },

    generateFamilyBold: (amount, replaceExisting = false) => {
      if (!requirePro("family")) {
        return { glyphs: get().glyphsByStyle.bold, generated: 0, replaced: 0, preserved: 0, skippedRegular: 0 };
      }
      finalizeLive();
      const state = get();
      return commitFamilyGeneration(
        "bold",
        generateBoldFromRegular(state.glyphsByStyle.regular, state.glyphsByStyle.bold, amount, replaceExisting)
      );
    },

    generateFamilyItalic: (angle, replaceExisting = false) => {
      if (!requirePro("family")) {
        return { glyphs: get().glyphsByStyle.italic, generated: 0, replaced: 0, preserved: 0, skippedRegular: 0 };
      }
      finalizeLive();
      const state = get();
      return commitFamilyGeneration(
        "italic",
        generateItalicFromRegular(state.glyphsByStyle.regular, state.glyphsByStyle.italic, angle, replaceExisting)
      );
    },

    setGhost: (patch) => set((s) => ({ ghost: { ...s.ghost, ...patch } })),
    // Full replace, NOT a merge over the previous brush: presets like Pixel
    // set flags (gridSnap) that plain object-spread merging would let leak
    // into the next brush if the new preset simply omits that key. Every
    // brush switch must fully reset to the target preset's own settings —
    // this is what guarantees pixel grid-snapping never survives a switch
    // to Monoline/Marker/Calligraphic/Pencil/Grunge.
    setBrushType: (type) =>
      set(() => {
        const next = { type, ...BRUSH_PRESETS[type].settings } as BrushSettings;
        if (type !== "pixel") delete next.gridSnap;
        return { brush: next };
      }),
    setBrush: (patch) =>
      set((s) => {
        const next = { ...s.brush, ...patch };
        if (next.type === "pixel") next.gridSnap = true;
        else delete next.gridSnap;
        return { brush: next };
      }),

    updateGlyphMetrics: (char, patch, scope) => {
      const { glyphs, glyphMetricScope } = get();
      const nextGlyphs = applyGlyphMetricToMap(glyphs, char, patch, scope ?? glyphMetricScope);
      if (nextGlyphs === glyphs) return;
      commit(nextGlyphs);
    },

    setGlyphMetricScope: (scope) => set({ glyphMetricScope: scope }),
    setGlyphMetricFocus: (key) => set({ glyphMetricFocus: key }),

    beginGlyphMetricDrag: () => {
      if (!glyphMetricDragSnapshot) glyphMetricDragSnapshot = get().glyphs;
    },

    setGlyphMetricLive: (char, key, value, scope) => {
      if (!Number.isFinite(value)) return;
      const { glyphs, glyphsByStyle, fontStyle, glyphMetricScope } = get();
      const nextGlyphs = applyGlyphMetricToMap(glyphs, char, { [key]: value }, scope ?? glyphMetricScope);
      set({
        glyphs: nextGlyphs,
        glyphsByStyle: { ...glyphsByStyle, [fontStyle]: nextGlyphs },
      });
    },

    endGlyphMetricDrag: () => {
      if (!glyphMetricDragSnapshot) return;
      const before = glyphMetricDragSnapshot;
      glyphMetricDragSnapshot = null;
      const { glyphs, metrics, past, kerningPairs, kerningManual } = get();
      if (before === glyphs) return;
      set({
        past: [...past, { glyphs: before, metrics, kerningPairs, kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    commitOutline: (char, outline) => {
      const { glyphs } = get();
      const glyph = glyphs[char];
      if (!glyph) return;
      commit({ ...glyphs, [char]: { ...glyph, outline } });
      set({ liveOutline: null });
    },

    setLiveOutline: (outline) => set({ liveOutline: outline }),

    updateSelectedObject: (patch) => {
      const { glyphs, activeChar, selectedObjectIds } = get();
      const glyph = glyphs[activeChar];
      if (!glyph || selectedObjectIds.length === 0) return;
      const objects = glyph.outline.objects.map((o) => {
        if (!selectedObjectIds.includes(o.id)) return o;
        const next = cloneObject(o);
        if (patch.strokeWidth !== undefined && (o.kind === "line" || o.kind === "brush")) {
          next.strokeWidth = patch.strokeWidth;
        }
        if (
          patch.cap !== undefined &&
          (o.kind === "line" || (o.kind === "brush" && o.brushType === "monoline"))
        ) {
          next.cap = patch.cap;
        }
        const rest = { ...patch };
        delete rest.strokeWidth;
        delete rest.cap;
        return { ...next, ...rest };
      });
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    selectObjects: (ids, additive) =>
      set((s) => {
        if (!additive) {
          return {
            selectedObjectIds: ids,
            selectedNodes: [],
            selectedHandle: null,
            selectionSkewAngle: 0,
            selectionSkewHandle: "skew-x-top",
          };
        }
        const merged = new Set(s.selectedObjectIds);
        for (const id of ids) merged.has(id) ? merged.delete(id) : merged.add(id);
        return {
          selectedObjectIds: [...merged],
          selectionSkewAngle: 0,
          selectionSkewHandle: "skew-x-top",
        };
      }),
    clearObjectSelection: () => set({
      selectedObjectIds: [],
      selectionSkewAngle: 0,
      selectionSkewHandle: "skew-x-top",
    }),
    setSelectionSkewState: (angle, handle) =>
      set((s) => ({
        selectionSkewAngle: angle,
        selectionSkewHandle: handle ?? s.selectionSkewHandle,
      })),

    nudgeSelectedObjects: (dx, dy) => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph || selectedObjectIds.length === 0) return;
      const objects = glyph.outline.objects.map((o) =>
        selectedObjectIds.includes(o.id) ? translateObject(o, dx, dy) : o
      );
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    deleteSelectedObjects: () => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph || selectedObjectIds.length === 0) return;
      const objects = glyph.outline.objects.filter((o) => !selectedObjectIds.includes(o.id));
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      set({ selectedObjectIds: [] });
    },

    deleteSelectedNodes: () => {
      const glyph = activeGlyph();
      const { activeChar, selectedNodes } = get();
      if (!glyph || selectedNodes.length === 0) return;
      get().commitOutline(activeChar, deleteNodes(glyph.outline, selectedNodes));
      set({ selectedNodes: [], selectedHandle: null });
    },

    expandSelectedStrokes: () => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph) return;
      const newIds: string[] = [];
      const objects: VectorObject[] = [];
      for (const o of glyph.outline.objects) {
        if (selectedObjectIds.includes(o.id) && (o.kind === "line" || o.kind === "brush")) {
          const expanded = expandStrokeObject(o);
          if (expanded) { if (o.groupId) expanded.groupId = o.groupId; objects.push(expanded); newIds.push(expanded.id); continue; }
        }
        objects.push(o);
      }
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      set({ selectedObjectIds: newIds });
    },

    // Mirrors the current selection in place around its combined bounding
    // box center. Position, transform state, per-object selection and all
    // glyph data (node types, groupId, stroke settings, samples) survive
    // untouched — only point/handle coordinates are reflected.
    flipSelectedObjects: (axis) => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph || selectedObjectIds.length === 0) return;
      const bounds = objectsBounds(glyph.outline, selectedObjectIds);
      if (!bounds) return;
      const anchor = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
      const sx = axis === "horizontal" ? -1 : 1;
      const sy = axis === "vertical" ? -1 : 1;
      const objects = glyph.outline.objects.map((o) =>
        selectedObjectIds.includes(o.id) ? scaleObject(o, anchor, sx, sy, true) : o
      );
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    // Combines 2+ selected filled objects (shape/expanded) into one new
    // shape via a real polygon boolean op, and replaces them in place —
    // other objects, their order, and the rest of the glyph are untouched.
    booleanSelectedObjects: (op) => {
      const glyph = activeGlyph();
      const { glyphs, activeChar, selectedObjectIds } = get();
      if (!glyph) return;
      const inZOrder = glyph.outline.objects.filter((o) => selectedObjectIds.includes(o.id));
      const result = applyBooleanOp(inZOrder, op);
      if (!result) return;
      const eligibleIds = new Set(inZOrder.filter((o) => o.kind === "shape" || o.kind === "expanded").map((o) => o.id));
      const firstEligibleIndex = glyph.outline.objects.findIndex((o) => eligibleIds.has(o.id));
      const remaining = glyph.outline.objects.filter((o) => !eligibleIds.has(o.id));
      const insertAt = glyph.outline.objects.slice(0, firstEligibleIndex).filter((o) => !eligibleIds.has(o.id)).length;
      const objects = [...remaining.slice(0, insertAt), result, ...remaining.slice(insertAt)];
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      set({ selectedObjectIds: [result.id] });
    },

    addMultilingualGlyphs: () => {
      finalizeLive();
      const state = get();
      const regularGlyphs = state.glyphsByStyle.regular;
      const result = composeMultilingualGlyphs(regularGlyphs, state.metrics);
      if (result.created === 0 && result.markSlotsAdded === 0 && result.symbolSlotsAdded === 0) {
        return result;
      }
      const nextGlyphsByStyle = { ...state.glyphsByStyle, regular: result.glyphs };
      const nextGlyphs = state.fontStyle === "regular" ? result.glyphs : state.glyphs;
      set({
        glyphs: nextGlyphs,
        glyphsByStyle: nextGlyphsByStyle,
        past: [
          ...state.past,
          { glyphs: state.glyphs, metrics: state.metrics, kerningPairs: state.kerningPairs, kerningManual: state.kerningManual },
        ].slice(-HISTORY_LIMIT),
        future: [],
      });
      return result;
    },

    copySelection: () => {
      const glyph = activeGlyph();
      if (!glyph) return;
      const { selectedObjectIds } = get();
      const objs = glyph.outline.objects.filter((o) => selectedObjectIds.includes(o.id));
      if (objs.length) set({ clipboard: objs.map(cloneObject) });
    },
    cutSelection: () => {
      get().copySelection();
      get().deleteSelectedObjects();
    },
    pasteClipboard: () => {
      const { clipboard, glyphs, activeChar } = get();
      const glyph = glyphs[activeChar];
      if (!clipboard || clipboard.length === 0 || !glyph) return;
      const groupMap = new Map<string, string>();
      const pasted = clipboard.map((source) => {
        const o = translateObject(cloneObjectWithNewIds(source), 40, -40);
        if (source.groupId) {
          let nextGroup = groupMap.get(source.groupId);
          if (!nextGroup) {
            nextGroup = shortId("group");
            groupMap.set(source.groupId, nextGroup);
          }
          o.groupId = nextGroup;
        } else {
          delete o.groupId;
        }
        return o;
      });
      const objects = [...glyph.outline.objects, ...pasted];
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
      set({ tool: "select", selectedObjectIds: pasted.map((o) => o.id), selectedNodes: [], selectedHandle: null });
    },

    groupSelectedObjects: () => {
      const { glyphs, activeChar, selectedObjectIds } = get();
      const glyph = glyphs[activeChar];
      if (!glyph || selectedObjectIds.length < 2) return;
      const groupId = shortId("group");
      const objects = glyph.outline.objects.map((o) =>
        selectedObjectIds.includes(o.id) ? { ...cloneObject(o), groupId } : o
      );
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    ungroupSelectedObjects: () => {
      const { glyphs, activeChar, selectedObjectIds } = get();
      const glyph = glyphs[activeChar];
      if (!glyph || selectedObjectIds.length === 0) return;
      const groupIds = new Set(
        glyph.outline.objects
          .filter((o) => selectedObjectIds.includes(o.id) && o.groupId)
          .map((o) => o.groupId as string)
      );
      if (groupIds.size === 0) return;
      const objects = glyph.outline.objects.map((o) => {
        if (!o.groupId || !groupIds.has(o.groupId)) return o;
        const next = cloneObject(o);
        delete next.groupId;
        return next;
      });
      commit({ ...glyphs, [activeChar]: { ...glyph, outline: { objects } } });
    },

    selectNodes: (refs, additive) =>
      set((s) => {
        if (!additive) return { selectedNodes: refs, selectedHandle: null };
        const merged = [...s.selectedNodes];
        for (const r of refs) if (!merged.some((m) => sameRef(m, r))) merged.push(r);
        return { selectedNodes: merged, selectedHandle: null };
      }),
    toggleNodeSelection: (ref) =>
      set((s) => {
        const exists = s.selectedNodes.some((m) => sameRef(m, ref));
        return {
          selectedNodes: exists ? s.selectedNodes.filter((m) => !sameRef(m, ref)) : [...s.selectedNodes, ref],
          selectedHandle: null,
        };
      }),
    clearSelection: () => set({ selectedNodes: [], selectedHandle: null }),
    setSelectedHandle: (ref) =>
      set({ selectedHandle: ref, selectedNodes: ref ? [{ contourId: ref.contourId, nodeId: ref.nodeId }] : [] }),
    setDrawingContourId: (id) => set({ drawingContourId: id }),

    undo: () => {
      const {
        past, future, glyphs, glyphsByStyle, fontStyle, metrics, kerningPairs, kerningManual,
        kerningOverridesByStyle, kerningOverrideManualByStyle,
      } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      const familyTransaction = Boolean(prev.glyphsByStyle);
      const restoredFamily = prev.glyphsByStyle ?? { ...glyphsByStyle, [fontStyle]: prev.glyphs };
      set({
        glyphs: familyTransaction ? restoredFamily[fontStyle] : prev.glyphs,
        glyphsByStyle: restoredFamily,
        metrics: prev.metrics,
        kerningPairs: prev.kerningPairs,
        kerningManual: prev.kerningManual,
        kerningOverridesByStyle: prev.kerningOverridesByStyle ?? kerningOverridesByStyle,
        kerningOverrideManualByStyle: prev.kerningOverrideManualByStyle ?? kerningOverrideManualByStyle,
        past: past.slice(0, -1),
        future: [{
          glyphs,
          glyphsByStyle: familyTransaction ? glyphsByStyle : undefined,
          metrics,
          kerningPairs,
          kerningManual,
          kerningOverridesByStyle,
          kerningOverrideManualByStyle,
        }, ...future].slice(0, HISTORY_LIMIT),
        selectedNodes: [], selectedHandle: null, selectedObjectIds: [], drawingContourId: null, liveOutline: null,
      });
    },
    redo: () => {
      const {
        past, future, glyphs, glyphsByStyle, fontStyle, metrics, kerningPairs, kerningManual,
        kerningOverridesByStyle, kerningOverrideManualByStyle,
      } = get();
      if (future.length === 0) return;
      const next = future[0];
      const familyTransaction = Boolean(next.glyphsByStyle);
      const restoredFamily = next.glyphsByStyle ?? { ...glyphsByStyle, [fontStyle]: next.glyphs };
      set({
        glyphs: familyTransaction ? restoredFamily[fontStyle] : next.glyphs,
        glyphsByStyle: restoredFamily,
        metrics: next.metrics,
        kerningPairs: next.kerningPairs,
        kerningManual: next.kerningManual,
        kerningOverridesByStyle: next.kerningOverridesByStyle ?? kerningOverridesByStyle,
        kerningOverrideManualByStyle: next.kerningOverrideManualByStyle ?? kerningOverrideManualByStyle,
        future: future.slice(1),
        past: [...past, {
          glyphs,
          glyphsByStyle: familyTransaction ? glyphsByStyle : undefined,
          metrics,
          kerningPairs,
          kerningManual,
          kerningOverridesByStyle,
          kerningOverrideManualByStyle,
        }].slice(-HISTORY_LIMIT),
        selectedNodes: [], selectedHandle: null, selectedObjectIds: [], drawingContourId: null, liveOutline: null,
      });
    },

    hydrate: (patch) =>
      set((s) => {
        const incomingRegular = patch.glyphsByStyle?.regular ?? patch.glyphs;
        const fallbackFamily = incomingRegular ? familyFromRegular(incomingRegular) : s.glyphsByStyle;
        const family: GlyphFamily = {
          regular: patch.glyphsByStyle?.regular ?? fallbackFamily.regular,
          bold: patch.glyphsByStyle?.bold ?? fallbackFamily.bold,
          italic: patch.glyphsByStyle?.italic ?? fallbackFamily.italic,
        };
        const style: FontStyle = patch.fontStyle ?? (incomingRegular ? "regular" : s.fontStyle);
        const activeGlyphs = family[style];
        const activeChar = patch.activeChar && activeGlyphs[patch.activeChar]
          ? patch.activeChar
          : activeGlyphs[s.activeChar]
            ? s.activeChar
            : Object.keys(activeGlyphs)[0] ?? s.activeChar;
        return {
          glyphs: activeGlyphs,
          glyphsByStyle: family,
          fontStyle: style,
          fontName: patch.fontName ?? s.fontName,
          fontInfo: patch.fontInfo ? { ...s.fontInfo, ...patch.fontInfo } : s.fontInfo,
          projectFileName: patch.projectFileName ?? s.projectFileName,
          metrics: patch.metrics ? { ...s.metrics, ...patch.metrics, baseline: patch.metrics.baseline ?? s.metrics.baseline ?? 0 } : s.metrics,
          kerningPairs: patch.kerningPairs ?? s.kerningPairs,
          kerningManual: patch.kerningManual ?? s.kerningManual,
          kerningOverridesByStyle: patch.kerningOverridesByStyle ?? (incomingRegular ? {} : s.kerningOverridesByStyle),
          kerningOverrideManualByStyle: patch.kerningOverrideManualByStyle ?? (incomingRegular ? {} : s.kerningOverrideManualByStyle),
          activeChar,
          gridSize: patch.gridSize ?? s.gridSize,
          showGrid: patch.showGrid ?? s.showGrid,
          showGuides: patch.showGuides ?? s.showGuides,
          ghost: patch.ghost
            ? {
                ...s.ghost,
                ...patch.ghost,
                // Older v1 projects have no mode field. Preserve the original
                // built-in reference behavior for those files.
                mode: patch.ghost.mode === "family" ? "family" : patch.ghost.mode === "image" ? "image" : "sample",
              }
            : s.ghost,
          brush: patch.brush ?? s.brush,
          selectedObjectIds: [],
          selectedNodes: [],
          selectedHandle: null,
          drawingContourId: null,
          liveOutline: null,
          clipboard: null,
          glyphMetricFocus: null,
          past: [],
          future: [],
        };
      }),

    setKerningPair: (left, right, value) => {
      const { kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      commitKerning({ ...kerningPairs, [key]: Math.round(value) }, { ...kerningManual, [key]: true });
    },

    applyKerningSuggestion: (left, right) => {
      const { glyphs, metrics, kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      const suggestion = suggestKerningPair(glyphs, metrics, left, right);
      // Applying the computed suggestion is explicitly NOT a manual override,
      // so a later global auto-kerning pass is still free to refine it.
      commitKerning({ ...kerningPairs, [key]: suggestion }, { ...kerningManual, [key]: false });
    },

    resetKerningPair: (left, right) => {
      const { kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      const nextPairs = { ...kerningPairs };
      const nextManual = { ...kerningManual };
      delete nextPairs[key];
      delete nextManual[key];
      commitKerning(nextPairs, nextManual);
    },

    autoKernAllPairs: () => {
      const { glyphs, metrics, kerningPairs, kerningManual } = get();
      const result = autoKernAllAvailablePairs(glyphs, metrics, kerningPairs, kerningManual);
      commitKerning(result.pairs, result.manual);
      set({ autoKernLastRun: { processed: result.processed, updated: result.updated, preservedManual: result.preservedManual } });
    },

    beginKerningDrag: () => {
      if (kerningDragSnapshot) return;
      const { kerningPairs, kerningManual } = get();
      kerningDragSnapshot = { kerningPairs, kerningManual };
    },

    setKerningPairLive: (left, right, value) => {
      const { kerningPairs, kerningManual } = get();
      const key = kerningKey(left, right);
      set({
        kerningPairs: { ...kerningPairs, [key]: Math.round(value) },
        kerningManual: { ...kerningManual, [key]: true },
      });
    },

    endKerningDrag: () => {
      const snapshot = kerningDragSnapshot;
      kerningDragSnapshot = null;
      if (!snapshot) return;
      const { glyphs, past, kerningPairs, kerningManual } = get();
      if (snapshot.kerningPairs === kerningPairs && snapshot.kerningManual === kerningManual) return;
      set({
        past: [...past, { glyphs, metrics: get().metrics, kerningPairs: snapshot.kerningPairs, kerningManual: snapshot.kerningManual }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    setFamilyKerningPair: (context, left, right, value) => {
      if (context === "shared") {
        get().setKerningPair(left, right, value);
        return;
      }
      const state = get();
      const key = kerningKey(left, right);
      const pairs = state.kerningOverridesByStyle[context] ?? {};
      const manual = state.kerningOverrideManualByStyle[context] ?? {};
      commitFamilyStyleKerning(
        context,
        { ...pairs, [key]: Math.round(value) },
        { ...manual, [key]: true }
      );
    },

    resetFamilyKerningPair: (context, left, right) => {
      if (context === "shared") {
        get().resetKerningPair(left, right);
        return;
      }
      const state = get();
      const key = kerningKey(left, right);
      const currentPairs = state.kerningOverridesByStyle[context] ?? {};
      const currentManual = state.kerningOverrideManualByStyle[context] ?? {};
      if (!(key in currentPairs) && !(key in currentManual)) return;
      const nextPairs = { ...currentPairs };
      const nextManual = { ...currentManual };
      delete nextPairs[key];
      delete nextManual[key];
      commitFamilyStyleKerning(context, nextPairs, nextManual);
    },

    autoKernAllPairsForContext: (context) => {
      if (context === "shared") {
        // Shared family auto-kern uses Regular as the family baseline while
        // keeping the exact existing auto-kern algorithm and manual rules.
        const state = get();
        const result = autoKernAllAvailablePairs(
          state.glyphsByStyle.regular,
          state.metrics,
          state.kerningPairs,
          state.kerningManual
        );
        commitKerning(result.pairs, result.manual);
        set({ autoKernLastRun: {
          processed: result.processed,
          updated: result.updated,
          preservedManual: result.preservedManual,
        } });
        return;
      }

      const state = get();
      const currentPairs = state.kerningOverridesByStyle[context] ?? {};
      const currentManual = state.kerningOverrideManualByStyle[context] ?? {};
      const result = autoKernAllAvailablePairs(
        state.glyphsByStyle[context],
        state.metrics,
        currentPairs,
        currentManual,
        state.kerningPairs
      );
      commitFamilyStyleKerning(context, result.pairs, result.manual);
      set({ autoKernLastRun: {
        processed: result.processed,
        updated: result.updated,
        preservedManual: result.preservedManual,
      } });
    },

    beginFamilyKerningDrag: (context) => {
      if (familyKerningDragSnapshot) return;
      const state = get();
      familyKerningDragSnapshot = {
        context,
        kerningPairs: state.kerningPairs,
        kerningManual: state.kerningManual,
        kerningOverridesByStyle: state.kerningOverridesByStyle,
        kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
      };
    },

    setFamilyKerningPairLive: (context, left, right, value) => {
      const key = kerningKey(left, right);
      const rounded = Math.round(value);
      if (context === "shared") {
        set((state) => ({
          kerningPairs: { ...state.kerningPairs, [key]: rounded },
          kerningManual: { ...state.kerningManual, [key]: true },
        }));
        return;
      }
      set((state) => ({
        kerningOverridesByStyle: {
          ...state.kerningOverridesByStyle,
          [context]: { ...(state.kerningOverridesByStyle[context] ?? {}), [key]: rounded },
        },
        kerningOverrideManualByStyle: {
          ...state.kerningOverrideManualByStyle,
          [context]: { ...(state.kerningOverrideManualByStyle[context] ?? {}), [key]: true },
        },
      }));
    },

    endFamilyKerningDrag: () => {
      const snapshot = familyKerningDragSnapshot;
      familyKerningDragSnapshot = null;
      if (!snapshot) return;
      const state = get();
      const sharedChanged =
        snapshot.kerningPairs !== state.kerningPairs ||
        snapshot.kerningManual !== state.kerningManual;
      const overrideChanged =
        snapshot.kerningOverridesByStyle !== state.kerningOverridesByStyle ||
        snapshot.kerningOverrideManualByStyle !== state.kerningOverrideManualByStyle;
      if (!sharedChanged && !overrideChanged) return;
      set({
        past: [...state.past, {
          glyphs: state.glyphs,
          metrics: state.metrics,
          kerningPairs: snapshot.kerningPairs,
          kerningManual: snapshot.kerningManual,
          kerningOverridesByStyle: snapshot.kerningOverridesByStyle,
          kerningOverrideManualByStyle: snapshot.kerningOverrideManualByStyle,
        }].slice(-HISTORY_LIMIT),
        future: [],
      });
    },

    openTestLab: (tab) => set((s) => ({ testLabOpen: true, familyOpen: false, traceOpen: false, testLabTab: tab ?? s.testLabTab })),
    closeTestLab: () => set({ testLabOpen: false }),
    setTestLabTab: (tab) => set({ testLabTab: tab }),
    openFamily: () => {
      if (!requirePro("family")) return;
      set({ familyOpen: true, testLabOpen: false, traceOpen: false });
    },
    closeFamily: () => set({ familyOpen: false }),

    openTrace: () => set({ traceOpen: true, testLabOpen: false, familyOpen: false }),
    closeTrace: () => set({ traceOpen: false }),

    openProModal: (feature) => set({ proModalOpen: true, proModalFeature: feature }),
    closeProModal: () => set({ proModalOpen: false }),

    openLoginModal: () => set({ loginModalOpen: true }),
    closeLoginModal: () => set({ loginModalOpen: false }),
    commitTracedGlyphOutline: (char, outline) => {
      const state = get();
      const regularGlyphs = state.glyphsByStyle.regular;
      const glyph = regularGlyphs[char];
      if (!glyph) return;
      const nextRegular: GlyphMap = { ...regularGlyphs, [char]: { ...glyph, outline } };
      const nextFamily: GlyphFamily = { ...state.glyphsByStyle, regular: nextRegular };
      set({
        glyphsByStyle: nextFamily,
        glyphs: state.fontStyle === "regular" ? nextRegular : state.glyphs,
        past: [
          ...state.past,
          {
            glyphs: state.glyphs,
            glyphsByStyle: state.glyphsByStyle,
            metrics: state.metrics,
            kerningPairs: state.kerningPairs,
            kerningManual: state.kerningManual,
            kerningOverridesByStyle: state.kerningOverridesByStyle,
            kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
          },
        ].slice(-HISTORY_LIMIT),
        future: [],
      });
    },
  };
});
