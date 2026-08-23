import { useEffect, useRef } from "react";
import { useAppStore } from "@/glyph/store";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { loadProject, saveProject } from "@/glyph/persist";
import { TopBar } from "@/components/TopBar";
import { FloatingToolbar } from "@/components/FloatingToolbar";
import { SketchModeToggle } from "@/components/SketchModeToggle";
import { SketchToolbar } from "@/components/SketchToolbar";
import { SketchRightPanelToggle } from "@/components/SketchRightPanelToggle";
import { GlyphStepper } from "@/components/GlyphStepper";
import { GlyphSideNav } from "@/components/GlyphSideNav";
import { GlyphNav } from "@/components/GlyphNav";
import { RightPanel } from "@/components/RightPanel";
import { BottomBar } from "@/components/BottomBar";
import { GlyphCanvas } from "@/editor/GlyphCanvas";
import { TestLabOverlay } from "@/components/TestLab/TestLabOverlay";
import { FamilyAutoGenerateOverlay } from "@/components/FamilyAutoGenerateOverlay";
import { TraceImageOverlay } from "@/components/TraceImage/TraceImageOverlay";
import { LoginModal } from "@/components/LoginModal";
import { ProUpsellModal } from "@/components/ProUpsellModal";

export default function App() {
  const theme = useAppStore((s) => s.theme);
  const sketchMode = useAppStore((s) => s.sketchMode);
  const sketchRightPanelOpen = useAppStore((s) => s.sketchRightPanelOpen);
  useKeyboardShortcuts();

  const hydratedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore the saved project from IndexedDB on first mount.
  useEffect(() => {
    let cancelled = false;
    loadProject().then((snap) => {
      if (cancelled) return;
      if (snap?.glyphs) useAppStore.getState().hydrate({
        glyphs: snap.glyphs,
        glyphsByStyle: snap.glyphsByStyle,
        fontStyle: snap.fontStyle,
        fontName: snap.fontName,
        fontInfo: snap.fontInfo,
        metrics: snap.metrics,
        kerningPairs: snap.kerningPairs,
        kerningManual: snap.kerningManual,
        kerningOverridesByStyle: snap.kerningOverridesByStyle,
        kerningOverrideManualByStyle: snap.kerningOverrideManualByStyle,
      });
      hydratedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);

  // Persist glyphs + font name (debounced) whenever they change, and flush
  // immediately when the tab is hidden/closed so a quick reload can't lose work.
  useEffect(() => {
    const flush = () => {
      if (!hydratedRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const state = useAppStore.getState();
      saveProject({
        glyphs: state.glyphsByStyle.regular,
        glyphsByStyle: state.glyphsByStyle,
        fontStyle: state.fontStyle,
        fontName: state.fontName,
        fontInfo: state.fontInfo,
        metrics: state.metrics,
        kerningPairs: state.kerningPairs,
        kerningManual: state.kerningManual,
        kerningOverridesByStyle: state.kerningOverridesByStyle,
        kerningOverrideManualByStyle: state.kerningOverrideManualByStyle,
      });
    };
    const unsub = useAppStore.subscribe(() => {
      if (!hydratedRef.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, 350);
    });
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <div
      className="fm-root"
      data-theme={theme}
      data-sketch-mode={sketchMode ? "true" : "false"}
      data-sketch-panel-open={sketchRightPanelOpen ? "true" : "false"}
    >
      <TopBar />
      <div className="fm-body">
        <GlyphNav />
        <div className="fm-canvas-wrap">
          <div className="fm-canvas-area">
            <GlyphCanvas />
            <FloatingToolbar />
            <SketchModeToggle />
            {sketchMode && <SketchToolbar />}
            {sketchMode && <GlyphStepper />}
            {sketchMode && <SketchRightPanelToggle />}
            {!sketchMode && <GlyphSideNav />}
          </div>
          <BottomBar />
        </div>
        <RightPanel />
      </div>
      <TestLabOverlay />
      <FamilyAutoGenerateOverlay />
      <TraceImageOverlay />
      <LoginModal />
      <ProUpsellModal />
    </div>
  );
}
