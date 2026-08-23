import { useEffect } from "react";
import { X, FlaskConical } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { SpecimenPanel } from "./SpecimenPanel";

export function TestLabOverlay() {
  const open = useAppStore((s) => s.testLabOpen);
  const close = useAppStore((s) => s.closeTestLab);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="fm-lab-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} data-testid="test-lab-overlay">
      <div className="fm-lab-modal">
        <div className="fm-lab-head">
          <div className="fm-lab-title">
            <FlaskConical size={14} />
            <span>Test Lab</span>
          </div>
          <div className="fm-spacer" />
          <button className="fm-theme-toggle" onClick={close} title="Close (Esc)" data-testid="lab-close-btn">
            <X size={16} />
          </button>
        </div>
        <div className="fm-lab-body"><SpecimenPanel /></div>
      </div>
    </div>
  );
}
