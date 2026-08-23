import { Grid3x3, Ruler, Ghost, Maximize2, RotateCcw, Minus, Plus } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { NumericInput } from "./NumericInput";

export function BottomBar() {
  const zoom = useAppStore((s) => s.zoom);
  const setZoom = useAppStore((s) => s.setZoom);
  const showGrid = useAppStore((s) => s.showGrid);
  const toggleGrid = useAppStore((s) => s.toggleGrid);
  const gridSize = useAppStore((s) => s.gridSize);
  const setGridSize = useAppStore((s) => s.setGridSize);
  const showGuides = useAppStore((s) => s.showGuides);
  const toggleGuides = useAppStore((s) => s.toggleGuides);
  const upm = useAppStore((s) => s.metrics.unitsPerEm);
  const tool = useAppStore((s) => s.tool);
  const penMode = useAppStore((s) => s.penMode);
  const lineWidth = useAppStore((s) => s.lineWidth);
  const setLineWidth = useAppStore((s) => s.setLineWidth);
  const ghost = useAppStore((s) => s.ghost);
  const setGhost = useAppStore((s) => s.setGhost);
  const fitGlyph = useAppStore((s) => s.fitGlyph);
  const resetView = useAppStore((s) => s.resetView);

  return (
    <div className="fm-bottombar" data-testid="bottom-bar">
      <div className="fm-zoom-controls">
        <button className="fm-icon-btn" onClick={() => setZoom(zoom - 10)} title="Zoom out"><Minus size={13} /></button>
        <span className="fm-zoom-value" data-testid="zoom-value">{zoom}%</span>
        <button className="fm-icon-btn" onClick={() => setZoom(zoom + 10)} title="Zoom in"><Plus size={13} /></button>
        <input type="range" min={20} max={800} step={5} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} data-testid="zoom-slider" />
      </div>

      <div className="fm-bottom-divider" />

      <button className={showGrid ? "on" : ""} onClick={toggleGrid} data-testid="toggle-grid"><Grid3x3 size={13} /> Grid</button>
      {showGrid && (
        <div className="fm-inline-field" data-testid="grid-size-field">
          <button className="fm-icon-btn" onClick={() => setGridSize(gridSize - 5)} title="Smaller grid" data-testid="grid-size-down"><Minus size={12} /></button>
          <span className="fm-grid-size-value" data-testid="grid-size-value">{gridSize}u</span>
          <button className="fm-icon-btn" onClick={() => setGridSize(gridSize + 5)} title="Larger grid" data-testid="grid-size-up"><Plus size={12} /></button>
        </div>
      )}
      <button className={showGuides ? "on" : ""} onClick={toggleGuides} data-testid="toggle-guides"><Ruler size={13} /> Guides</button>
      <button className={ghost.enabled ? "on" : ""} onClick={() => setGhost({ enabled: !ghost.enabled })} data-testid="toggle-ghost"><Ghost size={13} /> Ghost</button>

      {tool === "pen" && penMode === "line" && (
        <div className="fm-inline-field">
          <span>Width</span>
          <NumericInput min={1} max={200} value={lineWidth} onChange={setLineWidth} data-testid="line-width" />
        </div>
      )}

      <div className="fm-hint-inline">
        <button onClick={() => fitGlyph()} title="Fit Glyph" data-testid="fit-btn"><Maximize2 size={13} /> Fit</button>
        <button onClick={() => resetView()} title="Reset View" data-testid="reset-btn"><RotateCcw size={13} /> Reset</button>
        <span className="fm-upm">UPM {upm}</span>
      </div>
    </div>
  );
}
