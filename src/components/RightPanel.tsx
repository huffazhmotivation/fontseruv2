import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, PenLine, Minus, Highlighter, Feather, Pencil, Zap, Scissors, Copy, Trash2, Flame, Grid3x3, Lock, Unlock, ImagePlus, FlipHorizontal, FlipVertical, CircleDashed } from "lucide-react";
import { useAppStore, type NodeRef, type GlyphMetricKey } from "@/glyph/store";
import { GLYPH_GROUPS } from "@/glyph/defaultGlyphs";
import { hasOutline } from "@/types/glyph";
import type { Glyph } from "@/types/glyph";
import { unicodeHex } from "@/utils/unicode";
import { findNode, retypeNode, retypeNodes, deleteNodes } from "@/editor/nodeOps";
import { objectsBounds, skewObject, scaleObject } from "@/editor/objectOps";
import { isBooleanEligible, type BooleanOp } from "@/editor/booleanOps";
import type { NodeType, PathNode, StrokeCap, VectorObject } from "@/types/geometry";
import { BRUSH_ORDER, BRUSH_PRESETS } from "@/brushes/presets";
import type { BrushType } from "@/types/brush";
import { GlyphThumbnail } from "./GlyphThumbnail";
import { NumericInput } from "./NumericInput";

const NODE_TYPE_LABEL: Record<NodeType, string> = { corner: "Corner", smooth: "Smooth", symmetric: "Symmetric" };

/** Minimal outline icons for the Boolean Select actions (no text by design —
 * used icon-only with a `title` tooltip). Hand-drawn rather than pulled from
 * lucide-react since there's no matching union/subtract/intersect glyph there. */
function BooleanOpIcon({ op, size = 14 }: { op: BooleanOp; size?: number }) {
  const common = { viewBox: "0 0 20 20", width: size, height: size, fill: "none" as const };
  if (op === "union") {
    return (
      <svg {...common}>
        <circle cx="7.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12.5" cy="11.5" r="5.5" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (op === "subtract") {
    return (
      <svg {...common}>
        <circle cx="7.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="12.5" cy="11.5" r="5.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.2" opacity="0.55" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="7.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.1" opacity="0.35" />
      <circle cx="12.5" cy="11.5" r="5.5" stroke="currentColor" strokeWidth="1.1" opacity="0.35" />
      {/* Lens formed by the two circles' actual intersection points. */}
      <path d="M7.6 14 A5.5 5.5 0 0 1 12.4 6 A5.5 5.5 0 0 1 7.6 14 Z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
const BRUSH_ICON: Record<BrushType, typeof PenLine> = {
  round: PenLine, monoline: Minus, marker: Highlighter, calligraphic: Feather, pencil: Pencil, pressureTaper: Zap,
  rough: CircleDashed, grunge: Flame, pixel: Grid3x3,
};

export function RightPanel() {
  const activeChar = useAppStore((s) => s.activeChar);
  const glyph = useAppStore((s) => s.glyphs[activeChar]);
  const tool = useAppStore((s) => s.tool);
  const selectedNodes = useAppStore((s) => s.selectedNodes);
  const selectedObjectIds = useAppStore((s) => s.selectedObjectIds);

  if (!glyph) return <div className="fm-rightpanel" />;

  const category = GLYPH_GROUPS.find((g) => g.id === glyph.category)?.label;
  // Select tool: show its panel as soon as the tool is active, not only once
  // something is selected — same pattern Node already uses (see below). This
  // keeps the Select/Transform panel in place across an Undo/Redo that clears
  // the current selection, instead of falling through to the generic Glyph
  // panel and looking like the tool itself was exited.
  const showSelect = tool === "select";
  const showBrush = tool === "brush";
  // Node tool: show its status/properties panel as soon as the tool is
  // active, not only once a node is selected (NodePanel handles the
  // "nothing selected yet" state itself).
  const showNode = tool === "node";
  const showPenLine = tool === "pen";

  return (
    <div className="fm-rightpanel" data-testid="right-panel">
      <div className="fm-panel-header">
        <div className="fm-panel-glyph"><GlyphThumbnail glyph={glyph} /></div>
        <div className="fm-panel-meta">
          <div className="fm-panel-char">{glyph.char}</div>
          <div className="fm-panel-code">{unicodeHex(glyph.unicode)}</div>
          <div className="fm-panel-cat">{category}</div>
        </div>
      </div>

      {showSelect ? (
        <SelectPanel glyph={glyph} selectedObjectIds={selectedObjectIds} />
      ) : showBrush ? (
        <BrushPanel />
      ) : showNode ? (
        <NodePanel char={activeChar} glyph={glyph} selectedNodes={selectedNodes} />
      ) : showPenLine ? (
        <PenPanel />
      ) : (
        <GlyphPanel char={activeChar} glyph={glyph} />
      )}

      {tool === "home" && (
        <>
          <GlyphMetricsSection char={activeChar} glyph={glyph} />
          <FontMetricsSection />
          <GhostGlyphSection />
        </>
      )}
    </div>
  );
}

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`fm-section ${open ? "open" : "closed"}`}>
      <button className="fm-section-head" onClick={() => setOpen((o) => !o)} data-testid={`section-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        <span className="fm-section-title">{title}</span>
        <ChevronDown size={14} className="fm-section-caret" />
      </button>
      {open && <div className="fm-section-body">{children}</div>}
    </div>
  );
}

function SelectPanel({ glyph, selectedObjectIds }: { glyph: Glyph; selectedObjectIds: string[] }) {
  const expandSelectedStrokes = useAppStore((s) => s.expandSelectedStrokes);
  const updateSelectedObject = useAppStore((s) => s.updateSelectedObject);
  const groupSelectedObjects = useAppStore((s) => s.groupSelectedObjects);
  const ungroupSelectedObjects = useAppStore((s) => s.ungroupSelectedObjects);
  const booleanSelectedObjects = useAppStore((s) => s.booleanSelectedObjects);
  const strokeWidthLocked = useAppStore((s) => s.strokeWidthLocked);
  const toggleStrokeWidthLock = useAppStore((s) => s.toggleStrokeWidthLock);

  const objs = glyph.outline.objects.filter((o) => selectedObjectIds.includes(o.id));
  const booleanEligibleCount = objs.filter(isBooleanEligible).length;
  const strokeObjs = objs.filter((o) => o.kind === "line" || o.kind === "brush");
  const capObjs = objs.filter((o) => o.kind === "line" || (o.kind === "brush" && o.brushType === "monoline"));
  const groupIds = new Set(objs.flatMap((o) => (o.groupId ? [o.groupId] : [])));
  const oneGroupId = groupIds.size === 1 ? [...groupIds][0] : null;
  const isSingleGroup = Boolean(oneGroupId && objs.length > 1 && objs.every((o) => o.groupId === oneGroupId));

  // Mirrors NodePanel's own "nothing selected yet" state below: the Select
  // tool stays in charge of the right panel (see `showSelect` above), so an
  // Undo/Redo that clears the selection lands here instead of bouncing back
  // to the generic Glyph panel.
  if (objs.length === 0) {
    return (
      <Section title="Selection">
        <span className="fm-status-pill" data-testid="select-status-empty">
          <span className="fm-status-dot" />
          Nothing selected
        </span>
        <div className="fm-hint" style={{ marginTop: 8 }}>
          Click an object on the canvas to select it, or drag a marquee to select several.
        </div>
      </Section>
    );
  }

  return (
    <>
      <Section title="Selection">
      {strokeObjs.length > 0 && (
        <Slider label="Stroke Width" value={strokeObjs[0].strokeWidth ?? 20} min={1} max={200} directInput
          onChange={(v) => updateSelectedObject({ strokeWidth: v })}
          labelAdornment={
            <button
              type="button"
              className={`fm-lock-btn ${strokeWidthLocked ? "active" : ""}`}
              onClick={toggleStrokeWidthLock}
              title={strokeWidthLocked ? "Stroke width locked — stays the same when scaling" : "Stroke width unlocked — scales with the object"}
              aria-pressed={strokeWidthLocked}
              data-testid="stroke-width-lock"
            >
              {strokeWidthLocked ? <Lock size={12} strokeWidth={2} /> : <Unlock size={12} strokeWidth={2} />}
            </button>
          }
        />
      )}
      {capObjs.length > 0 && (
        <CapControl value={capObjs[0].cap ?? "round"} onChange={(cap) => updateSelectedObject({ cap })} />
      )}

      {objs.length > 1 && (
        <button className="fm-action-btn" onClick={groupSelectedObjects} disabled={isSingleGroup} data-testid="group-btn">
          Group
        </button>
      )}
      {groupIds.size > 0 && (
        <button className="fm-action-btn" onClick={ungroupSelectedObjects} data-testid="ungroup-btn">
          Ungroup
        </button>
      )}

      {booleanEligibleCount > 1 && (
        <div className="fm-btn-row" style={{ marginTop: 10 }}>
          <button className="fm-action-btn fm-icon-btn" onClick={() => booleanSelectedObjects("union")} title="Add / Union" data-testid="boolean-union-btn">
            <BooleanOpIcon op="union" />
          </button>
          <button className="fm-action-btn fm-icon-btn" onClick={() => booleanSelectedObjects("subtract")} title="Subtract" data-testid="boolean-subtract-btn">
            <BooleanOpIcon op="subtract" />
          </button>
          <button className="fm-action-btn fm-icon-btn" onClick={() => booleanSelectedObjects("intersect")} title="Intersect" data-testid="boolean-intersect-btn">
            <BooleanOpIcon op="intersect" />
          </button>
        </div>
      )}

      {strokeObjs.length > 0 && (
        <button className="fm-action-btn accent" onClick={expandSelectedStrokes} data-testid="expand-stroke-btn">
          <Scissors size={14} /> Expand Stroke{strokeObjs.length > 1 ? "s" : ""}
        </button>
      )}
      <div className="fm-hint" style={{ marginTop: 8 }}>
        Drag to move · corner/edge handles resize (Shift = proportional) · top handle rotates (Shift = 15°). Cmd/Ctrl+G groups · Cmd/Ctrl+U ungroups.
      </div>
      </Section>
      <TransformPanel glyph={glyph} selectedObjectIds={selectedObjectIds} />
    </>
  );
}

function TransformPanel({ glyph, selectedObjectIds }: { glyph: Glyph; selectedObjectIds: string[] }) {
  const skewAngle = useAppStore((s) => s.selectionSkewAngle);
  const skewHandle = useAppStore((s) => s.selectionSkewHandle);
  const setSelectionSkewState = useAppStore((s) => s.setSelectionSkewState);
  const commitOutline = useAppStore((s) => s.commitOutline);
  const activeChar = useAppStore((s) => s.activeChar);
  const copySelection = useAppStore((s) => s.copySelection);
  const pasteClipboard = useAppStore((s) => s.pasteClipboard);
  const deleteSelectedObjects = useAppStore((s) => s.deleteSelectedObjects);

  const applySkewAngle = (rawAngle: number) => {
    if (!Number.isFinite(rawAngle) || selectedObjectIds.length === 0) return;
    const angle = Math.max(-89, Math.min(89, rawAngle));
    const previousShear = Math.tan((skewAngle * Math.PI) / 180);
    const nextShear = Math.tan((angle * Math.PI) / 180);
    const delta = nextShear - previousShear;
    if (Math.abs(delta) < 1e-9) {
      setSelectionSkewState(angle, skewHandle);
      return;
    }

    const bounds = objectsBounds(glyph.outline, selectedObjectIds);
    if (!bounds) return;
    const handle = skewHandle ?? "skew-x-top";
    const horizontal = handle === "skew-x-top" || handle === "skew-x-bottom";
    const topOrRight = handle === "skew-x-top" || handle === "skew-y-right";
    const anchor = horizontal
      ? { x: 0, y: topOrRight ? bounds.minY : bounds.maxY }
      : { x: topOrRight ? bounds.minX : bounds.maxX, y: 0 };

    const objects = glyph.outline.objects.map((obj) =>
      selectedObjectIds.includes(obj.id)
        ? skewObject(obj, anchor, horizontal ? delta : 0, horizontal ? 0 : delta)
        : obj
    );
    commitOutline(activeChar, { objects });
    setSelectionSkewState(angle, handle);
  };

  const flipSelection = (axis: "horizontal" | "vertical") => {
    if (selectedObjectIds.length === 0) return;
    const bounds = objectsBounds(glyph.outline, selectedObjectIds);
    if (!bounds) return;
    // Mirror around the selection's own center, so a multi-object selection
    // flips together as one group rather than each object flipping in place.
    const anchor = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const sx = axis === "horizontal" ? -1 : 1;
    const sy = axis === "vertical" ? -1 : 1;
    const objects = glyph.outline.objects.map((obj) =>
      selectedObjectIds.includes(obj.id) ? scaleObject(obj, anchor, sx, sy, true) : obj
    );
    commitOutline(activeChar, { objects });
  };

  return (
    <Section title="Transform">
      <div className="fm-btn-row">
        <button className="fm-action-btn" onClick={() => { copySelection(); pasteClipboard(); }} data-testid="duplicate-btn">
          <Copy size={14} /> Duplicate
        </button>
        <button className="fm-action-btn danger" onClick={deleteSelectedObjects} data-testid="delete-object-btn">
          <Trash2 size={14} /> Delete
        </button>
      </div>
      <div className="fm-field">
        <label>Flip</label>
        <div className="fm-btn-row">
          <button
            className="fm-action-btn"
            onClick={() => flipSelection("horizontal")}
            disabled={selectedObjectIds.length === 0}
            title="Flip Horizontal"
            data-testid="flip-horizontal-btn"
          >
            <FlipHorizontal size={14} /> Horizontal
          </button>
          <button
            className="fm-action-btn"
            onClick={() => flipSelection("vertical")}
            disabled={selectedObjectIds.length === 0}
            title="Flip Vertical"
            data-testid="flip-vertical-btn"
          >
            <FlipVertical size={14} /> Vertical
          </button>
        </div>
      </div>
      <div className="fm-field">
        <label htmlFor="transform-skew">Skew</label>
        <div className="fm-angle-control">
          <NumericInput
            id="transform-skew"
            value={Number(skewAngle.toFixed(1))}
            min={-89}
            max={89}
            step={1}
            onChange={applySkewAngle}
            aria-label="Skew angle"
            data-testid="transform-skew"
          />
          <span aria-hidden="true">°</span>
        </div>
      </div>
      <div className="fm-hint">
        Drag a skew handle or enter an angle. The numeric value follows the active skew direction.
      </div>
    </Section>
  );
}

function GlyphPanel({ char, glyph }: { char: string; glyph: Glyph }) {
  // Outline / object-count section intentionally removed from the sidebar
  // per request. `char`/`glyph` kept in the signature so callers and the
  // conditional render logic in RightPanel don't need to change.
  void char;
  void glyph;
  return null;
}

function GlyphMetricsSection({ char, glyph }: { char: string; glyph: Glyph }) {
  const updateGlyphMetrics = useAppStore((s) => s.updateGlyphMetrics);
  const scope = useAppStore((s) => s.glyphMetricScope);
  const setScope = useAppStore((s) => s.setGlyphMetricScope);
  const focus = useAppStore((s) => s.glyphMetricFocus);
  const setFocus = useAppStore((s) => s.setGlyphMetricFocus);
  const refs = useRef<Partial<Record<GlyphMetricKey, HTMLInputElement | null>>>({});

  useEffect(() => {
    if (!focus) return;
    const el = refs.current[focus];
    if (!el) return;
    el.focus();
    el.select();
    setFocus(null);
  }, [focus, setFocus]);

  const rows: { key: GlyphMetricKey; label: string; value: number; testid: string }[] = [
    { key: "advanceWidth", label: "Advance Width", value: glyph.advanceWidth, testid: "advance-width" },
    { key: "lsb", label: "Left Side Bearing", value: glyph.lsb, testid: "lsb" },
    { key: "rsb", label: "Right Side Bearing", value: glyph.rsb, testid: "rsb" },
  ];

  return (
    <Section title="Glyph Metrics">
      <div className="fm-field">
        <label>Apply changes to</label>
        <div className="fm-node-type-row fm-metric-scope" role="group" aria-label="Glyph metric scope">
          <button
            className={`fm-node-type-btn ${scope === "current" ? "active" : ""}`}
            onClick={() => setScope("current")}
            data-testid="metric-scope-current"
          >
            This Glyph
          </button>
          <button
            className={`fm-node-type-btn ${scope === "all" ? "active" : ""}`}
            onClick={() => setScope("all")}
            data-testid="metric-scope-all"
          >
            All Glyphs
          </button>
        </div>
      </div>

      {rows.map(({ key, label, value, testid }) => (
        <div className="fm-field" key={key}>
          <label htmlFor={testid}>{label}</label>
          <NumericInput
            id={testid}
            ref={(el) => { refs.current[key] = el; }}
            value={value}
            onChange={(next) => {
              if (Number.isFinite(next)) updateGlyphMetrics(char, { [key]: next });
            }}
            onFocus={() => setFocus(null)}
            data-testid={testid}
          />
        </div>
      ))}

      <div className="fm-hint">
        Drag the LSB / Advance / RSB handles on the canvas for live adjustment. The selected scope also applies to dragging.
      </div>
    </Section>
  );
}

function FontMetricsSection() {
  const metrics = useAppStore((s) => s.metrics);
  const setFontMetric = useAppStore((s) => s.setFontMetric);
  const metricFocus = useAppStore((s) => s.metricFocus);
  const setMetricFocus = useAppStore((s) => s.setMetricFocus);
  const refs = useRef<Partial<Record<keyof typeof metrics, HTMLInputElement | null>>>({});

  useEffect(() => {
    if (!metricFocus) return;
    const el = refs.current[metricFocus];
    if (!el) return;
    el.focus();
    el.select();
    setMetricFocus(null);
  }, [metricFocus, setMetricFocus]);

  const rows: { key: keyof typeof metrics; label: string; testid: string }[] = [
    { key: "ascender", label: "Ascender", testid: "font-metric-ascender" },
    { key: "capHeight", label: "Cap Height", testid: "font-metric-capHeight" },
    { key: "xHeight", label: "X-Height", testid: "font-metric-xHeight" },
    { key: "baseline", label: "Baseline", testid: "font-metric-baseline" },
    { key: "descender", label: "Descender", testid: "font-metric-descender" },
  ];

  return (
    <Section title="Font Metrics" defaultOpen={true}>
      <div className="fm-font-metrics-grid">
        {rows.map(({ key, label, testid }) => (
          <div className="fm-field fm-metric-field" key={key}>
            <label htmlFor={testid}>{label}</label>
            <NumericInput
              id={testid}
              ref={(el) => { refs.current[key] = el; }}
              value={metrics[key]}
              onChange={(next) => {
                if (Number.isFinite(next)) setFontMetric(key, next);
              }}
              onFocus={() => setMetricFocus(null)}
              data-testid={testid}
            />
          </div>
        ))}
      </div>
      <div className="fm-hint">Drag guides on the canvas for live adjustment · double-click a guide for precise input.</div>
    </Section>
  );
}

function NodePanel({ char, glyph, selectedNodes }: { char: string; glyph: Glyph; selectedNodes: NodeRef[] }) {
  const commitOutline = useAppStore((s) => s.commitOutline);
  const clearSelection = useAppStore((s) => s.clearSelection);

  if (selectedNodes.length === 0) {
    const outlined = hasOutline(glyph);
    return (
      <Section title="Node">
        <span className="fm-status-pill" data-testid="node-status-empty">
          <span className="fm-status-dot" />
          No node selected
        </span>
        <div className="fm-hint" style={{ marginTop: 8 }}>
          {outlined
            ? "Click a node on the canvas to see its position and type here."
            : "This glyph has no outline yet — draw with the Pen (P) or Brush (B) first."}
        </div>
      </Section>
    );
  }

  if (selectedNodes.length > 1) {
    const nodes = selectedNodes
      .map((ref) => findNode(glyph.outline, ref.contourId, ref.nodeId))
      .filter((node): node is PathNode => Boolean(node));
    const commonType = nodes.length > 0 && nodes.every((node) => node.type === nodes[0].type) ? nodes[0].type : null;

    return (
      <Section title="Nodes">
        <span className="fm-status-pill done"><span className="fm-status-dot" />{selectedNodes.length} nodes selected</span>
        <div className="fm-field" style={{ marginTop: 10 }}>
          <label>Set Selected Node Type</label>
          <div className="fm-node-type-row">
            {(Object.keys(NODE_TYPE_LABEL) as NodeType[]).map((type) => (
              <button
                key={type}
                className={`fm-node-type-btn ${commonType === type ? "active" : ""}`}
                onClick={() => commitOutline(char, retypeNodes(glyph.outline, selectedNodes, type))}
                data-testid={`nodes-type-${type}`}
              >
                {NODE_TYPE_LABEL[type]}
              </button>
            ))}
          </div>
        </div>
        <div className="fm-hint" style={{ marginTop: 8 }}>Drag any selected node to move the group. Shift-click to add/remove. Arrow keys nudge (Shift = ×10).</div>
        <button className="fm-action-btn danger" style={{ marginTop: 10 }}
          onClick={() => { commitOutline(char, deleteNodes(glyph.outline, selectedNodes)); clearSelection(); }} data-testid="delete-nodes-btn">
          <Trash2 size={14} /> Delete {selectedNodes.length} Nodes
        </button>
      </Section>
    );
  }

  const ref = selectedNodes[0];
  const node = findNode(glyph.outline, ref.contourId, ref.nodeId);
  if (!node) return null;

  return (
    <Section title="Node">
      <div className="fm-field">
        <label>Position</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input type="number" value={Math.round(node.point.x)} readOnly />
          <input type="number" value={Math.round(node.point.y)} readOnly />
        </div>
      </div>
      <div className="fm-field">
        <label>Node Type</label>
        <div className="fm-node-type-row">
          {(Object.keys(NODE_TYPE_LABEL) as NodeType[]).map((t) => (
            <button key={t} className={`fm-node-type-btn ${node.type === t ? "active" : ""}`}
              onClick={() => commitOutline(char, retypeNode(glyph.outline, ref.contourId, ref.nodeId, t))} data-testid={`node-type-${t}`}>
              {NODE_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      <button className="fm-action-btn danger" onClick={() => { commitOutline(char, deleteNodes(glyph.outline, [ref])); clearSelection(); }} data-testid="delete-node-btn">
        <Trash2 size={14} /> Delete Node
      </button>
      <div className="fm-hint" style={{ marginTop: 8 }}>
        Double-click a node to cycle its type · double-click a segment to insert a node · Cmd/Ctrl-drag a segment to curve it · Alt-drag a handle to break it.
      </div>
    </Section>
  );
}

function PenPanel() {
  const penMode = useAppStore((s) => s.penMode);
  const setPenMode = useAppStore((s) => s.setPenMode);
  const lineWidth = useAppStore((s) => s.lineWidth);
  const setLineWidth = useAppStore((s) => s.setLineWidth);
  const lineCap = useAppStore((s) => s.lineCap);
  const setLineCap = useAppStore((s) => s.setLineCap);
  const penAutoClose = useAppStore((s) => s.penAutoClose);
  const togglePenAutoClose = useAppStore((s) => s.togglePenAutoClose);
  return (
    <Section title="Pen">
      <div className="fm-field">
        <label>Mode</label>
        <div className="fm-node-type-row">
          <button className={`fm-node-type-btn ${penMode === "shape" ? "active" : ""}`} onClick={() => setPenMode("shape")}>Shape</button>
          <button className={`fm-node-type-btn ${penMode === "line" ? "active" : ""}`} onClick={() => setPenMode("line")}>Line</button>
        </div>
      </div>
      {penMode === "line" ? (
        <>
          <Slider label="Stroke Width" value={lineWidth} min={1} max={200} directInput onChange={setLineWidth} />
          <CapControl value={lineCap} onChange={setLineCap} />
          <div className="fm-hint">Line mode makes an editable open centerline — a true monoline. Width and cap stay editable until you Expand it.</div>
        </>
      ) : (
        <>
          <label className="fm-checkbox-row" style={{ marginTop: 6 }} data-testid="pen-auto-close-toggle">
            <input type="checkbox" checked={penAutoClose} onChange={togglePenAutoClose} />
            Auto Close Shape
          </label>
          <div className="fm-hint">
            {penAutoClose
              ? "On: previews as closed + filled while you draw. Click near the first node to finish it."
              : "Off: previews as an outline only until you click back onto the first node — then it closes and fills."}
          </div>
        </>
      )}
    </Section>
  );
}

function BrushPanel() {
  const brush = useAppStore((s) => s.brush);
  const setBrushType = useAppStore((s) => s.setBrushType);
  const setBrush = useAppStore((s) => s.setBrush);
  const brushCap = useAppStore((s) => s.brushCap);
  const setBrushCap = useAppStore((s) => s.setBrushCap);

  return (
    <>
      <Section title="Brush Preset">
        <div className="fm-brush-grid" data-testid="brush-grid">
          {BRUSH_ORDER.map((id) => {
            const Icon = BRUSH_ICON[id];
            const p = BRUSH_PRESETS[id];
            return (
              <button key={id} className={`fm-brush-card ${brush.type === id ? "active" : ""}`} onClick={() => setBrushType(id)}
                data-testid={`brush-${id}`}>
                <span className="fm-brush-icon"><Icon size={17} strokeWidth={1.8} /></span>
                <span className="fm-brush-name">{p.label}</span>
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Stroke Settings">
        <Slider label="Size" value={brush.size} min={1} max={200} directInput onChange={(v) => setBrush({ size: v, maxSize: Math.max(v, brush.maxSize) })} />
        {brush.type === "monoline" && <CapControl value={brushCap} onChange={setBrushCap} />}
        <Slider label="Stabilizer" value={brush.stabilizer ?? 0} min={0} max={1} step={0.05} onChange={(v) => setBrush({ stabilizer: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Min Size" value={brush.minSize} min={0} max={brush.maxSize} onChange={(v) => setBrush({ minSize: v })} />
        <Slider label="Max Size" value={brush.maxSize} min={brush.minSize} max={200} onChange={(v) => setBrush({ maxSize: v })} />
        <Slider label="Spacing" value={brush.spacing} min={1} max={20} onChange={(v) => setBrush({ spacing: v })} />
        <Slider label="Smoothing" value={brush.smoothing} min={0} max={1} step={0.05} onChange={(v) => setBrush({ smoothing: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Roundness" value={brush.roundness} min={0.1} max={1} step={0.05} onChange={(v) => setBrush({ roundness: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Angle" value={brush.angle} min={0} max={180} onChange={(v) => setBrush({ angle: v })} format={(v) => `${Math.round(v)}°`} />
        <Slider label="Taper Start" value={brush.taperStart} min={0} max={0.5} step={0.02} onChange={(v) => setBrush({ taperStart: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Taper End" value={brush.taperEnd} min={0} max={0.5} step={0.02} onChange={(v) => setBrush({ taperEnd: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <label className="fm-checkbox-row" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={brush.pressureEnabled} onChange={(e) => setBrush({ pressureEnabled: e.target.checked })} />
          Pointer pressure drives width
        </label>
      </Section>
    </>
  );
}

/** Reads an uploaded ghost reference image into a data URL and its natural
 * width/height ratio, so the custom ghost renders without stretching. */
function readGhostImageFile(file: File): Promise<{ src: string; aspect: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onload = () => resolve({ src, aspect: img.naturalWidth / img.naturalHeight || 1 });
      img.onerror = () => resolve({ src, aspect: 1 });
      img.src = src;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function GhostGlyphSection() {
  const ghost = useAppStore((s) => s.ghost);
  const setGhost = useAppStore((s) => s.setGhost);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  const handleImageFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type)) {
      setImageError("Choose a JPG or PNG image.");
      return;
    }
    try {
      const { src, aspect } = await readGhostImageFile(file);
      setGhost({ imageSrc: src, imageAspect: aspect, mode: "image" });
      setImageError(null);
    } catch {
      setImageError("Unable to read that image.");
    }
  };

  return (
    <Section title="Ghost Reference Canvas" defaultOpen={false}>
      <label className="fm-checkbox-row">
        <input type="checkbox" checked={ghost.enabled} onChange={(e) => setGhost({ enabled: e.target.checked })} data-testid="ghost-enabled" />
        Show ghost reference
      </label>
      {ghost.enabled && (
        <>
          <div className="fm-field">
            <label>Mode</label>
            <div className="fm-kern-mode-toggle fm-ghost-mode-toggle" role="group" aria-label="Ghost reference mode">
              <button
                type="button"
                className={ghost.mode === "sample" ? "active" : ""}
                onClick={() => setGhost({ mode: "sample" })}
                aria-pressed={ghost.mode === "sample"}
                data-testid="ghost-mode-sample"
              >
                Single Ghost
              </button>
              <button
                type="button"
                className={ghost.mode === "family" ? "active" : ""}
                onClick={() => setGhost({ mode: "family" })}
                aria-pressed={ghost.mode === "family"}
                data-testid="ghost-mode-family"
              >
                Family Ghost
              </button>
              <button
                type="button"
                className={ghost.mode === "image" ? "active" : ""}
                onClick={() => setGhost({ mode: "image" })}
                aria-pressed={ghost.mode === "image"}
                data-testid="ghost-mode-image"
              >
                Custom Image
              </button>
            </div>
          </div>
          <Slider label="Opacity" value={ghost.opacity} min={0.02} max={0.4} step={0.01} onChange={(v) => setGhost({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Scale" value={ghost.scale} min={0.5} max={1.5} step={0.02} onChange={(v) => setGhost({ scale: v })} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Offset X" value={ghost.offsetX} min={-200} max={200} onChange={(v) => setGhost({ offsetX: v })} />
          <Slider label="Offset Y" value={ghost.offsetY} min={-200} max={200} onChange={(v) => setGhost({ offsetY: v })} />

          {ghost.mode === "image" && (
            <div className="fm-field fm-ghost-image-field">
              <label>Custom Ghost Image</label>
              {ghost.imageSrc ? (
                <div className="fm-ghost-image-preview">
                  <img src={ghost.imageSrc} alt="Custom ghost reference" data-testid="ghost-image-preview" />
                  <div className="fm-ghost-image-actions">
                    <button
                      type="button"
                      className="fm-action-btn"
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="ghost-image-replace"
                    >
                      <ImagePlus size={13} /> Replace
                    </button>
                    <button
                      type="button"
                      className="fm-action-btn danger"
                      onClick={() => { setGhost({ imageSrc: null, imageAspect: undefined }); setImageError(null); }}
                      data-testid="ghost-image-remove"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="fm-action-btn"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="ghost-image-upload"
                >
                  <ImagePlus size={13} /> Upload Image
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={(e) => {
                  void handleImageFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
                data-testid="ghost-image-input"
              />
              {imageError && <div className="fm-hint fm-ghost-image-error">{imageError}</div>}
            </div>
          )}

          <div className="fm-hint">
            {ghost.mode === "sample"
              ? "One built-in sample reference, centered on the editable canvas."
              : ghost.mode === "family"
                ? "Two side references from matching saved family vectors. Undrawn styles stay empty."
                : "Upload a JPG or PNG to use as a reference behind the canvas. It's for tracing only and never becomes part of your glyph vectors."}
          </div>
        </>
      )}
    </Section>
  );
}

const CAP_LABELS: Record<StrokeCap, string> = { round: "Round Cap", butt: "Butt Cap", square: "Square Cap" };

function CapControl({ value, onChange }: { value: StrokeCap; onChange: (cap: StrokeCap) => void }) {
  return (
    <div className="fm-field">
      <label>Stroke Cap</label>
      <div className="fm-cap-control" role="group" aria-label="Stroke cap">
        {(["round", "butt", "square"] as StrokeCap[]).map((cap) => (
          <button
            key={cap}
            className={`fm-cap-btn ${value === cap ? "active" : ""}`}
            onClick={() => onChange(cap)}
            title={CAP_LABELS[cap]}
            aria-label={CAP_LABELS[cap]}
            data-testid={`cap-${cap}`}
          >
            <span className={`fm-cap-icon ${cap}`} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, testid }: { label: string; value: number; onChange: (v: number) => void; testid?: string }) {
  return (
    <div className="fm-field">
      <label>{label}</label>
      <NumericInput value={value} onChange={onChange} data-testid={testid} />
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format, directInput = false, labelAdornment }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  directInput?: boolean;
  /** Optional small control (e.g. a lock toggle) rendered right next to the
   * label, on the same side, so the existing label ↔ value space-between
   * layout is untouched. */
  labelAdornment?: ReactNode;
}) {
  const apply = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    onChange(Math.min(max, Math.max(min, raw)));
  };

  return (
    <div className="fm-field">
      <div className="fm-slider-row-label">
        <span className="fm-slider-label-group">
          <label>{label}</label>
          {labelAdornment}
        </span>
        {directInput ? (
          <NumericInput
            className="fm-slider-number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={apply}
            aria-label={`${label} value`}
          />
        ) : (
          <span>{format ? format(value) : Math.round(value)}</span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => apply(Number(e.target.value))} />
    </div>
  );
}
