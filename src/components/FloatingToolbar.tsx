import { MousePointer2, Paintbrush, Spline, PenTool, Hand, ZoomIn, Image, Lock } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { useAuth } from "@/auth/AuthProvider";
import type { ToolConfig } from "@/types/tool";

// Floating toolbar order (left → right):
// Home → Select → Node → Pen → Brush → Trace Image → Zoom → Hand
// Eraser / Shape / Import remain implemented (used elsewhere / kept for
// future phases) but are intentionally not shown in this toolbar.
const GROUPS: ToolConfig[][] = [
  [{ id: "home", label: "Home", key: "", phase: 1 }],
  [
    { id: "select", label: "Select", key: "V", phase: 1 },
    { id: "node", label: "Node", key: "N", phase: 2 },
    { id: "pen", label: "Pen", key: "P", phase: 2 },
    { id: "brush", label: "Brush", key: "B", phase: 3 },
  ],
  [
    { id: "zoom", label: "Zoom", key: "Z", phase: 1 },
    { id: "hand", label: "Hand", key: "H", phase: 1 },
  ],
];

const ICONS = {
  select: MousePointer2,
  brush: Paintbrush,
  node: Spline,
  pen: PenTool,
  hand: Hand,
  zoom: ZoomIn,
  trace: Image,
} as const;

const CURRENT_PHASE = 3;

// Tools that require a PRO plan. Brush is intentionally NOT in this set:
// per the current requirements, Brush is free/unlocked for all accounts.
const PRO_LOCKED_TOOLS = new Set<string>([]);

export function FloatingToolbar() {
  const tool = useAppStore((s) => s.tool);
  const setTool = useAppStore((s) => s.setTool);
  const openTrace = useAppStore((s) => s.openTrace);
  const openProModal = useAppStore((s) => s.openProModal);
  const { isPro } = useAuth();

  return (
    <div className="fm-floating-toolbar" data-testid="floating-toolbar">
      {GROUPS.map((group, gi) => (
        <div className="fm-tool-group" key={gi}>
          {group.map((t) => {
            const Icon = t.id === "home" ? null : ICONS[t.id as keyof typeof ICONS];
            const enabled = t.phase <= CURRENT_PHASE;
            const locked = PRO_LOCKED_TOOLS.has(t.id) && !isPro;
            return (
              <button
                key={t.id}
                className={`fm-tool ${tool === t.id ? "active" : ""} ${locked ? "fm-tool-locked" : ""}`}
                disabled={!enabled}
                onClick={() => {
                  if (!enabled) return;
                  if (locked) { openProModal("brush"); return; }
                  setTool(t.id);
                }}
                data-testid={`tool-${t.id}`}
              >
                {t.id === "home" ? (
  <span
    className="fm-home-tool-icon"
    aria-hidden="true"
  />
) : Icon ? (
  <Icon size={18} strokeWidth={1.7} />
) : null}
                {locked && (
                  <span className="fm-tool-lock-badge" aria-hidden="true">
                    <Lock size={9} strokeWidth={2.4} />
                  </span>
                )}
                <span className="fm-tool-tip">{t.label}{t.key ? ` · ${t.key}` : ""}{!enabled ? " (soon)" : locked ? " (PRO)" : ""}</span>
              </button>
            );
          })}
          {gi === 1 && (
            <button
              key="trace"
              type="button"
              className="fm-tool"
              onClick={() => openTrace()}
              data-testid="tool-trace"
              aria-label="Trace Image"
            >
              <Image size={18} strokeWidth={1.7} />
              <span className="fm-tool-tip">Trace Image</span>
            </button>
          )}
          {gi < GROUPS.length - 1 && <div className="fm-toolbar-divider" />}
        </div>
      ))}
    </div>
  );
}
