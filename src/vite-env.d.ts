/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base Supabase project URL, e.g. "https://xxxxx.supabase.co". */
  readonly VITE_SUPABASE_URL?: string;
  /** Public/publishable ("anon") Supabase API key. Never the secret key. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** WhatsApp number (any format) used for the "interested in PRO" CTA. */
  readonly VITE_PRO_WHATSAPP_NUMBER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
