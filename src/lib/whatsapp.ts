/**
 * Helper for the "Berminat menggunakan fitur PRO?" CTA.
 *
 * The WhatsApp number is only ever read from `VITE_PRO_WHATSAPP_NUMBER`
 * (never hardcoded here) so it can be changed via environment config alone.
 */

const PRO_INQUIRY_MESSAGE = "Halo, saya berminat menggunakan fitur PRO FontSeru.";

/**
 * Builds a `wa.me` deep link pre-filled with the PRO inquiry message.
 * Returns null when the env var is missing/empty so callers can degrade
 * gracefully instead of opening a broken link.
 */
export function getProWhatsAppUrl(): string | null {
  const raw = import.meta.env.VITE_PRO_WHATSAPP_NUMBER as string | undefined;
  if (!raw) return null;

  // wa.me expects digits only (international format, no "+", spaces or dashes).
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;

  return `https://wa.me/${digits}?text=${encodeURIComponent(PRO_INQUIRY_MESSAGE)}`;
}
