import React from "react";
import { Download, FlaskConical, Layers, Lock, Maximize, Minimize, Moon, Redo2, Sun, Undo2 } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import { FileMenu } from "@/components/FileMenu";
import { FontSeruLogo } from "@/components/FontSeruLogo";
import { AuthWidget } from "@/components/AuthWidget";

export function TopBar() {
  const exportRef = React.useRef<(() => void) | null>(null);
  const handleExportReady = React.useCallback((open: () => void) => {
    exportRef.current = open;
  }, []);

  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const fontName = useAppStore((s) => s.fontName);
  const setFontName = useAppStore((s) => s.setFontName);
  const past = useAppStore((s) => s.past);
  const future = useAppStore((s) => s.future);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const openTestLab = useAppStore((s) => s.openTestLab);
  const openFamily = useAppStore((s) => s.openFamily);
  const openProModal = useAppStore((s) => s.openProModal);
  const { isPro } = useAuth();

  const [isFullscreen, setIsFullscreen] = React.useState(false);
  React.useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  return (
    <div className="fm-topbar">
      <FontSeruLogo />
      <div className="fm-divider" />
      <FileMenu onExportButtonReady={handleExportReady} />
      <input
        className="fm-fontname"
        value={fontName}
        onChange={(event) => setFontName(event.target.value)}
        spellCheck={false}
        data-testid="font-name-input"
      />
      <div className="fm-topbtn-group">
        <button className="fm-topbtn" disabled={past.length === 0} onClick={undo} title="Undo (Cmd/Ctrl+Z)" data-testid="undo-btn">
          <Undo2 size={15} /> Undo
        </button>
        <button className="fm-topbtn" disabled={future.length === 0} onClick={redo} title="Redo (Cmd/Ctrl+Shift+Z)" data-testid="redo-btn">
          <Redo2 size={15} /> Redo
        </button>
      </div>

      <div className="fm-spacer" />

      <button
        className={`fm-topbtn fm-testlab-nav ${!isPro ? "fm-topbtn-locked" : ""}`}
        onClick={() => (isPro ? openFamily() : openProModal("family"))}
        title={isPro ? "Open Family Auto Generate" : "Family (PRO)"}
        data-testid="family-btn"
      >
        <Layers size={15} /> Family {!isPro && <Lock size={11} className="fm-lock-badge-inline" />}
      </button>
      <button className="fm-topbtn fm-testlab-nav" onClick={() => openTestLab("specimen")} title="Open Test Lab" data-testid="test-lab-btn">
        <FlaskConical size={15} /> Test Lab
      </button>
      <button
        className="fm-topbtn fm-export-nav"
        onClick={() => exportRef.current?.()}
        title="Export font"
        data-testid="export-font-btn"
      >
        <Download size={15} /> Export
      </button>
      <button
        className="fm-theme-toggle"
        onClick={toggleFullscreen}
        title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        data-testid="fullscreen-toggle"
      >
        {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
      </button>
      <button className="fm-theme-toggle" onClick={toggleTheme} title="Toggle theme" data-testid="theme-toggle">
        {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
      </button>
      <AuthWidget />
    </div>
  );
}
