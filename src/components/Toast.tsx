import { useEffect } from "react";
import { Check, CircleAlert, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
}

export function Toast({
  toast,
  onClose,
}: {
  toast: ToastMessage | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!toast) return;
    const duration = toast.kind === "error" ? 5200 : 2800;
    const timer = window.setTimeout(onClose, duration);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const Icon = toast.kind === "success" ? Check : toast.kind === "error" ? CircleAlert : Info;
  return (
    <div className={`fm-toast fm-toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} aria-live="polite">
      <Icon size={16} strokeWidth={2.25} aria-hidden="true" />
      <span>{toast.message}</span>
      <button type="button" className="fm-toast-close" onClick={onClose} aria-label="Dismiss notification">
        <X size={14} />
      </button>
    </div>
  );
}
