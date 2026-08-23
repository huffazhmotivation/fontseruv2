import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "@/lib/supabaseClient";
import { useAppStore } from "@/glyph/store";

export type UserPlan = "free" | "pro";

interface Profile {
  id: string;
  plan: UserPlan;
}

interface AuthContextValue {
  /** Whether Supabase env vars are present at all. */
  isConfigured: boolean;
  /** True while the initial session is being restored from storage. */
  initializing: boolean;
  session: Session | null;
  user: User | null;
  /** Loaded from the `profiles` table; null until fetched (or unavailable). */
  profile: Profile | null;
  /** True while a profile fetch is in flight. */
  profileLoading: boolean;
  plan: UserPlan;
  isPro: boolean;
  /**
   * True from the moment a Supabase password-recovery link brings the user
   * back to the app (the `PASSWORD_RECOVERY` auth event) until they finish
   * setting a new password. While true, the login gate stays open (showing
   * the "set new password" form) even though `session`/`user` are already
   * populated — a recovery link does establish a real Supabase session, so
   * without this flag a recovery click would silently log the user in
   * without ever making them set a new password.
   */
  passwordRecovery: boolean;
  /** Creates a new account with email + password. */
  signUpWithPassword: (
    email: string,
    password: string
  ) => Promise<{ error: string | null; needsEmailConfirmation: boolean; alreadyRegistered: boolean }>;
  /** Signs an existing user in with email + password. */
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  /** Sends a Supabase password-reset email for the given address. */
  sendPasswordReset: (email: string) => Promise<{ error: string | null }>;
  /** Sets a new password while in the `passwordRecovery` state. */
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  /**
   * Checks PRO status for the given email via the `check_pro_email` RPC
   * (SECURITY DEFINER Postgres function) — never queries `profiles`
   * directly from the client, so no row data is ever exposed to the `anon`
   * role. Returns false for unknown emails, non-pro emails, or when
   * Supabase isn't configured.
   */
  checkProStatus: (email: string) => Promise<boolean>;
  signOut: () => Promise<void>;
}

/** Translates the handful of Supabase auth error messages we expect into
 *  Indonesian copy; unrecognized messages are passed through as-is so
 *  nothing is ever silently swallowed. */
function translateAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "Email atau password salah.";
  if (m.includes("email not confirmed")) return "Email belum diverifikasi. Silakan cek kotak masuk Anda.";
  if (m.includes("user already registered") || m.includes("already registered")) {
    return "Email ini sudah terdaftar. Silakan masuk (login) dengan password Anda.";
  }
  if (m.includes("password should be at least")) return "Password minimal 6 karakter.";
  if (m.includes("rate limit")) return "Terlalu banyak percobaan. Coba lagi sebentar lagi.";
  // Supabase Auth (GoTrue) throws this when the account was created
  // successfully but the server-side call to the configured SMTP relay to
  // deliver the confirmation email failed (bad/expired SMTP credentials,
  // sender rejected by the provider, provider rate limit, etc). This is a
  // Supabase Dashboard → Auth → SMTP configuration issue, not something the
  // client can retry its way out of, so surface it as such instead of a
  // generic error.
  if (m.includes("error sending confirmation email") || m.includes("error sending confirmation")) {
    return "Gagal mengirim email konfirmasi. Ini bukan masalah di aplikasi — cek konfigurasi Custom SMTP di Supabase Dashboard (Authentication → Settings → SMTP), termasuk kredensial dan limit pengiriman Gmail.";
  }
  return message;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [initializing, setInitializing] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  // Restore existing session on mount and subscribe to auth state changes
  // (password-recovery callback, token refresh, sign-out, etc).
  useEffect(() => {
    if (!supabase) {
      setInitializing(false);
      return;
    }

    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session ?? null);
      setInitializing(false);
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;
      setSession(nextSession);

      // Fired when the user lands back in the app via a password-reset
      // email link. Supabase already issues a real session at this point,
      // so we flag it separately and keep the login gate open (showing the
      // "set new password" form instead of the normal sign-in form) until
      // they actually set a new password — otherwise a reset link would
      // double as a silent login bypass.
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
      }
      if (event === "SIGNED_OUT") {
        setPasswordRecovery(false);
      }
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
  }, []);

  // Whenever the logged-in user changes, read (never write) their `plan`
  // from the `profiles` table. This never trusts any client-side/local value,
  // and — importantly — it never writes to the DB either: a `data: null`
  // result (no matching row visible to this query) is NOT proof that the
  // user has no profile. It can just as easily be a transient read (RLS
  // context / replicated read not caught up yet right after a fresh
  // sign-in), and treating that as "new user -> create as free" is exactly
  // what was silently downgrading real `pro` accounts to `free`. So this
  // effect only ever reads, and retries a couple of times before giving up,
  // instead of ever inserting/overwriting a row from the client.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!supabase || !userId) {
      setProfile(null);
      return;
    }

    let cancelled = false;
    setProfileLoading(true);

    const RETRY_DELAYS_MS = [0, 300, 700, 1200]; // a few attempts, no writes

    const fetchProfile = async () => {
      for (const delay of RETRY_DELAYS_MS) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (cancelled || !supabase) return;

        const { data, error } = await supabase
          .from("profiles")
          .select("id, plan")
          .eq("id", userId)
          .maybeSingle();

        if (cancelled) return;

        if (data) {
          const plan: UserPlan = data.plan === "pro" ? "pro" : "free";
          setProfile({ id: data.id, plan });
          setProfileLoading(false);
          return;
        }

        if (error) {
          // Real error (network/RLS/etc): log it and try again below rather
          // than silently deciding the user is `free`.
          // eslint-disable-next-line no-console
          console.warn("[FontSeru] profiles fetch failed, retrying:", error.message);
        }
        // else: no error and no row (yet) — could be eventual-consistency
        // right after sign-in, or a genuinely brand-new user whose row is
        // provisioned server-side (DB trigger). Either way, retry; never
        // insert/assume `free` from the client.
      }

      // Still nothing after retries: leave `profile` as `null`. The UI
      // falls back to showing "Free" for display purposes only — this is
      // never written back to the database, so an existing `pro` row is
      // never touched and will resolve correctly on the next fetch/reload.
      if (!cancelled) setProfileLoading(false);
    };

    fetchProfile();

    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const signUpWithPassword = useCallback(async (email: string, password: string) => {
    if (!supabase) {
      return {
        error: "Supabase belum dikonfigurasi. Lengkapi file .env terlebih dahulu.",
        needsEmailConfirmation: false,
        alreadyRegistered: false,
      };
    }
    const trimmed = email.trim();
    if (!trimmed || !password) {
      return { error: "Masukkan email dan password terlebih dahulu.", needsEmailConfirmation: false, alreadyRegistered: false };
    }

    const { data, error } = await supabase.auth.signUp({
      email: trimmed,
      password,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    if (error) {
      return { error: translateAuthError(error.message), needsEmailConfirmation: false, alreadyRegistered: false };
    }

    // Supabase's anti-enumeration behavior: signing up with an email that's
    // already registered (and confirmed) returns success with no error, a
    // user object that has an empty `identities` array, and no session —
    // instead of an explicit "already registered" error. Detect that case
    // so we can point the person to the sign-in form instead.
    const alreadyRegistered = Boolean(data.user) && Array.isArray(data.user?.identities) && data.user!.identities!.length === 0;
    if (alreadyRegistered) {
      return { error: null, needsEmailConfirmation: false, alreadyRegistered: true };
    }

    // If email confirmation is required in the Supabase project's auth
    // settings, `data.session` is null right after sign-up (the account
    // exists but can't log in yet). If confirmation is disabled,
    // `data.session` is already populated and onAuthStateChange above will
    // pick it up on its own — nothing else to do here either way.
    const needsEmailConfirmation = !data.session;
    return { error: null, needsEmailConfirmation, alreadyRegistered: false };
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    if (!supabase) {
      return { error: "Supabase belum dikonfigurasi. Lengkapi file .env terlebih dahulu." };
    }
    const trimmed = email.trim();
    if (!trimmed || !password) {
      return { error: "Masukkan email dan password terlebih dahulu." };
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email: trimmed, password });
    if (error) {
      return { error: translateAuthError(error.message) };
    }

    // Update `session` directly from this call's own response instead of
    // waiting for the separate `onAuthStateChange` listener to relay it.
    // Root cause of "profiles.plan = pro but still reads FREE after
    // logout -> login (same tab)": this used to discard `data` entirely and
    // rely solely on the async SIGNED_IN event to update `session`, which
    // drives the profile-fetch effect below via `[session?.user?.id]`. That
    // event still fires and is kept as the general-purpose path (magic
    // links, OAuth, token refresh, other tabs), but funneling straight
    // sign-in through it too made the profile fetch depend on a second,
    // indirect round trip through Supabase's internal listener queue right
    // after a sign-out/sign-in pair in the same tab — exactly where a stale
    // or delayed event could leave `session` (and therefore the fetched
    // `profile`) out of sync with the account that actually just signed in.
    // Setting it here removes that indirection: the moment this call
    // resolves successfully, `session` reflects the new user immediately,
    // the profile-fetch effect fires deterministically for the correct
    // user id, and the (harmless, idempotent) SIGNED_IN event that arrives
    // afterward just confirms the same id.
    if (data.session) {
      setSession(data.session);
    }

    return { error: null };
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    if (!supabase) {
      return { error: "Supabase belum dikonfigurasi. Lengkapi file .env terlebih dahulu." };
    }
    const trimmed = email.trim();
    if (!trimmed) {
      return { error: "Masukkan alamat email terlebih dahulu." };
    }

    const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
      redirectTo: window.location.origin,
    });
    return { error: error ? translateAuthError(error.message) : null };
  }, []);

  const updatePassword = useCallback(async (newPassword: string) => {
    if (!supabase) {
      return { error: "Supabase belum dikonfigurasi. Lengkapi file .env terlebih dahulu." };
    }
    if (!newPassword || newPassword.length < 6) {
      return { error: "Password minimal 6 karakter." };
    }

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      return { error: translateAuthError(error.message) };
    }
    setPasswordRecovery(false);
    return { error: null };
  }, []);

  const checkProStatus = useCallback(async (email: string) => {
    if (!supabase) return false;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return false;

    // Calls the `public.check_pro_email` RPC (SECURITY DEFINER) instead of
    // querying `profiles` directly. This runs correctly pre-login (as the
    // `anon` role) because the function itself — not the caller — has
    // permission to read `profiles`; the client never gets table access and
    // only ever receives a boolean back. See
    // supabase/sql/check_pro_email_rpc.sql for the function definition.
    const RETRY_DELAYS_MS = [0, 400]; // light retry for transient network errors only

    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!supabase) return false;

      const { data, error } = await supabase.rpc("check_pro_email", { email_input: trimmed });

      if (error) {
        // eslint-disable-next-line no-console
        console.warn("[FontSeru] check_pro_email RPC failed, retrying:", error.message);
        continue;
      }

      return data === true;
    }

    return false;
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    // Same reasoning as the direct `setSession()` in `signInWithPassword`
    // above: don't rely solely on the async SIGNED_OUT event to clear
    // state, so the old session/profile is guaranteed gone immediately
    // (and can't briefly linger into whatever comes next, e.g. a fast
    // re-login) rather than only being cleared whenever that event happens
    // to arrive.
    setSession(null);
    setProfile(null);
    setPasswordRecovery(false);
  }, []);

  // Whether the app is currently in a "must log in first" state: Supabase
  // is configured, the initial session restore has finished, and either
  // there's no session yet or the only session we have is a not-yet-used
  // password-recovery session (see `passwordRecovery` above).
  const locked = isSupabaseConfigured && !initializing && (!session || passwordRecovery);

  // Hard editor lock: while `locked`, intercept every keyboard event on the
  // window in the CAPTURE phase — i.e. before it can reach any of the
  // app's own `window.addEventListener("keydown", ...)` handlers (tool
  // shortcuts, undo/redo, copy/paste, node nudging, overlay Escape
  // handlers, etc), all of which are registered in the bubble phase and
  // therefore always run *after* this one while it's active. This is what
  // actually stops the editor from being usable via the keyboard while the
  // login gate is open — the gate's own backdrop already blocks mouse/touch
  // input just by being a full-viewport element on top, but keyboard
  // listeners on `window` aren't affected by DOM stacking at all, so they
  // needed this separate guard. Typing into the login form's own fields is
  // unaffected: only `stopPropagation` is used (never `preventDefault`), so
  // native text entry and the browser's default "submit on Enter" behavior
  // for the form's inputs keep working normally.
  useEffect(() => {
    if (!locked) return;

    const block = (event: KeyboardEvent) => {
      event.stopPropagation();
    };

    window.addEventListener("keydown", block, true);
    window.addEventListener("keyup", block, true);
    window.addEventListener("keypress", block, true);

    return () => {
      window.removeEventListener("keydown", block, true);
      window.removeEventListener("keyup", block, true);
      window.removeEventListener("keypress", block, true);
    };
  }, [locked]);

  // Push the current plan into the Zustand editor store, which is outside
  // React and can't read this context directly. This is a one-way mirror
  // for enforcement purposes only (see the comment on `plan`/`setPlan` in
  // src/glyph/store.ts) — `profiles.plan` (via `profile` above) remains the
  // only source of truth; this effect never reads the store back.
  useEffect(() => {
    const plan: UserPlan = profile?.plan ?? "free";
    useAppStore.getState().setPlan(plan);
  }, [profile]);

  const value = useMemo<AuthContextValue>(() => {
    const plan = profile?.plan ?? "free";
    return {
      isConfigured: isSupabaseConfigured,
      initializing,
      session,
      user: session?.user ?? null,
      profile,
      profileLoading,
      plan,
      isPro: plan === "pro",
      passwordRecovery,
      signUpWithPassword,
      signInWithPassword,
      sendPasswordReset,
      updatePassword,
      checkProStatus,
      signOut,
    };
  }, [
    initializing,
    session,
    profile,
    profileLoading,
    passwordRecovery,
    signUpWithPassword,
    signInWithPassword,
    sendPasswordReset,
    updatePassword,
    checkProStatus,
    signOut,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
