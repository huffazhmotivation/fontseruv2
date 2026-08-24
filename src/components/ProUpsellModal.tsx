import { Crown, Sparkles, X } from "lucide-react";
import { useAppStore } from "@/glyph/store";
import { getProWhatsAppUrl } from "@/lib/whatsapp";

const FEATURE_COPY: Record<string, { title: string; body: string }> = {
  tracing: {
    title: "Trace Image adalah fitur PRO",
    body: "Upgrade ke PRO untuk melacak (trace) gambar menjadi outline vektor secara otomatis.",
  },
  family: {
    title: "Family Auto Generate adalah fitur PRO",
    body: "Upgrade ke PRO untuk membuat Bold & Italic otomatis dari font Regular kamu.",
  },
  brush: {
    title: "Brush Tool adalah fitur PRO",
    body: "Upgrade ke PRO untuk menggambar glyph langsung menggunakan kuas (brush).",
  },
  export: {
    title: "Batas export bulanan tercapai",
    body: "Akun FREE dibatasi 1x export per bulan. Upgrade ke PRO untuk export tanpa batas.",
  },
};

const DEFAULT_COPY = {
  title: "Fitur ini khusus PRO",
  body: "Upgrade ke PRO untuk membuka fitur ini beserta fitur PRO lainnya.",
};

/**
 * Shown whenever a FREE user taps a locked feature (Family / Generate
 * From Regular) or hits the monthly export limit. Tracing and Brush are
 * free/unlocked for all accounts and no longer trigger this modal, but
 * their copy entries below are kept (currently unused) in case a future
 * requirement re-locks them. Purely a UI upsell — never touches
 * plan/profile data itself.
 */
export function ProUpsellModal() {
  const proModalOpen = useAppStore((s) => s.proModalOpen);
  const proModalFeature = useAppStore((s) => s.proModalFeature);
  const closeProModal = useAppStore((s) => s.closeProModal);

  if (!proModalOpen) return null;

  const copy = (proModalFeature && FEATURE_COPY[proModalFeature]) || DEFAULT_COPY;
  const whatsappUrl = getProWhatsAppUrl();

  return (
    <div
      className="fm-auth-backdrop fm-pro-modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeProModal();
      }}
    >
      <div className="fm-auth-dialog fm-pro-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="pro-modal-title">
        <header>
          <div className="fm-pro-modal-heading">
            <span className="fm-pro-modal-icon" aria-hidden="true">
              <Crown size={16} />
            </span>
            <h2 id="pro-modal-title">{copy.title}</h2>
          </div>
          <button
            type="button"
            className="fm-iconbtn"
            onClick={closeProModal}
            aria-label="Tutup"
            data-testid="pro-modal-close"
          >
            <X size={17} />
          </button>
        </header>

        <div className="fm-auth-form">
          <p className="fm-auth-note">{copy.body}</p>

          <div className="fm-pro-modal-actions">
            {whatsappUrl ? (
              <a
                className="fm-auth-submit-btn fm-auth-btn-pro"
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="pro-modal-whatsapp-cta"
              >
                <Sparkles size={15} /> Join PRO
              </a>
            ) : (
              <button
                type="button"
                className="fm-auth-submit-btn fm-auth-btn-pro"
                onClick={closeProModal}
                data-testid="pro-modal-close-cta"
              >
                <Sparkles size={15} /> Oke, Mengerti
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
