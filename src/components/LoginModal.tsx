import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, Lock, Mail, Sparkles } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { FontSeruLogo } from "@/components/FontSeruLogo";
import { getProWhatsAppUrl } from "@/lib/whatsapp";

type Mode = "signin" | "signup" | "forgot";
type Status = "idle" | "busy" | "error" | "success";

/**
 * The mandatory login gate. Shown whenever there is no authenticated
 * session yet (or a password-recovery session that hasn't set a new
 * password yet — see `passwordRecovery` in AuthProvider). Mounted once at
 * the top level (see App.tsx).
 *
 * This popup is intentionally NOT closable:
 * - no "X" button
 * - clicking the backdrop does nothing
 * - Escape does nothing (no handler wired to close it)
 * - the editor behind it is additionally locked against keyboard input
 *   while this is open (see the capture-phase listener in AuthProvider)
 *
 * It disappears only when `useAuth()` reports a real, non-recovery session.
 */
export function LoginModal() {
  const {
    isConfigured,
    initializing,
    user,
    passwordRecovery,
    signUpWithPassword,
    signInWithPassword,
    sendPasswordReset,
    updatePassword,
  } = useAuth();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  // Password visibility toggles. One pair of booleans is enough even though
  // several forms below have their own "password" / "confirm password"
  // fields (signin+signup share one, recovery has its own) — only one form
  // is ever rendered at a time, so there's never a collision.
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Reset the form's local state whenever the mode changes, so leftover
  // errors/passwords from one view don't bleed into another.
  useEffect(() => {
    setPassword("");
    setConfirmPassword("");
    setStatus("idle");
    setMessage(null);
    setShowPassword(false);
    setShowConfirmPassword(false);
  }, [mode]);

  // Clear stale form state after a sign-out, so the gate reappears with a
  // clean "Masuk" form rather than whatever was last typed.
  useEffect(() => {
    if (!user) {
      setMode("signin");
      setEmail("");
      setPassword("");
      setConfirmPassword("");
      setStatus("idle");
      setMessage(null);
      setShowPassword(false);
      setShowConfirmPassword(false);
    }
  }, [user]);

  // Nothing to gate: still restoring session, Supabase isn't configured
  // (the app must keep working without it — see src/lib/supabaseClient.ts
  // — so we never hard-lock the UI in that case), or there's a real,
  // non-recovery session already.
  if (initializing || !isConfigured) return null;
  if (!passwordRecovery && user) return null;

  const busy = status === "busy";

  const handleSignIn = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("busy");
    setMessage(null);
    const { error } = await signInWithPassword(email, password);
    if (error) {
      setStatus("error");
      setMessage(error);
      return;
    }
    // Success: onAuthStateChange picks up the new session and this
    // component unmounts itself on the next render.
  };

  const handleSignUp = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setStatus("error");
      setMessage("Konfirmasi password tidak sama.");
      return;
    }
    setStatus("busy");
    setMessage(null);
    const { error, needsEmailConfirmation, alreadyRegistered } = await signUpWithPassword(email, password);
    if (error) {
      setStatus("error");
      setMessage(error);
      return;
    }
    if (alreadyRegistered) {
      setStatus("error");
      setMessage("Email ini sudah terdaftar. Silakan masuk dengan password Anda.");
      setMode("signin");
      return;
    }
    if (needsEmailConfirmation) {
      setStatus("success");
      setMessage(
        "Akun berhasil dibuat. Cek email Anda dan klik link verifikasi, lalu masuk dengan email + password Anda."
      );
      return;
    }
    // No confirmation required: onAuthStateChange already has a session
    // and this component will unmount itself on the next render.
  };

  const handleForgot = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("busy");
    setMessage(null);
    const { error } = await sendPasswordReset(email);
    if (error) {
      setStatus("error");
      setMessage(error);
      return;
    }
    setStatus("success");
    setMessage("Link reset password telah dikirim. Cek email Anda untuk melanjutkan.");
  };

  const handleRecovery = async (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmPassword) {
      setStatus("error");
      setMessage("Konfirmasi password tidak sama.");
      return;
    }
    setStatus("busy");
    setMessage(null);
    const { error } = await updatePassword(password);
    if (error) {
      setStatus("error");
      setMessage(error);
      return;
    }
    // Success: passwordRecovery flips to false inside updatePassword() and
    // this component unmounts itself on the next render.
  };

  const whatsappUrl = getProWhatsAppUrl();
  const handleWhatsApp = () => {
    if (whatsappUrl) window.open(whatsappUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="fm-auth-backdrop fm-auth-gate-backdrop">
      <div className="fm-auth-dialog fm-auth-gate-dialog" role="dialog" aria-modal="true" aria-label="Masuk ke FontSeru">
        <header className="fm-auth-gate-header">
          <FontSeruLogo />
        </header>

        <div className="fm-auth-form fm-auth-gate-form">
          {passwordRecovery ? (
            <>
              <div className="fm-auth-gate-intro">
                <h2>Buat password baru</h2>
                <p className="fm-auth-note">Masukkan password baru untuk akun Anda.</p>
              </div>
              <form onSubmit={handleRecovery}>
                <label className="fm-export-field fm-auth-gate-email">
                  <span>Password baru</span>
                  <div className="fm-auth-password-field">
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      autoFocus
                      minLength={6}
                      placeholder="Minimal 6 karakter"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (status === "error") setStatus("idle");
                      }}
                      data-testid="auth-recovery-password-input"
                    />
                    <button
                      type="button"
                      className="fm-auth-password-toggle"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}
                      aria-pressed={showPassword}
                      data-testid="auth-recovery-password-toggle"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>
                <label className="fm-export-field fm-auth-gate-email">
                  <span>Konfirmasi password</span>
                  <div className="fm-auth-password-field">
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      required
                      minLength={6}
                      placeholder="Ulangi password baru"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        if (status === "error") setStatus("idle");
                      }}
                      data-testid="auth-recovery-confirm-input"
                    />
                    <button
                      type="button"
                      className="fm-auth-password-toggle"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      aria-label={showConfirmPassword ? "Sembunyikan password" : "Tampilkan password"}
                      aria-pressed={showConfirmPassword}
                      data-testid="auth-recovery-confirm-toggle"
                    >
                      {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>

                {status === "error" && message && <p className="fm-auth-note fm-auth-note-error">{message}</p>}

                <button
                  type="submit"
                  className="fm-auth-submit-btn fm-auth-btn-pro"
                  disabled={busy}
                  data-testid="auth-recovery-submit-btn"
                >
                  <Lock size={15} /> {busy ? "Menyimpan…" : "Simpan password baru"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="fm-auth-gate-intro">
                <h2>{mode === "forgot" ? "Reset password" : "Masuk untuk melanjutkan"}</h2>
                <p className="fm-auth-note">
                  {mode === "signin" && "Masuk dengan email dan password Anda."}
                  {mode === "signup" && "Buat akun baru dengan email dan password."}
                  {mode === "forgot" && "Masukkan email Anda, kami kirim link untuk membuat password baru."}
                </p>
              </div>

              {mode !== "forgot" && (
                <div className="fm-auth-gate-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "signin"}
                    className={`fm-auth-gate-tab${mode === "signin" ? " fm-auth-gate-tab-active" : ""}`}
                    onClick={() => setMode("signin")}
                    data-testid="auth-tab-signin"
                  >
                    Masuk
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "signup"}
                    className={`fm-auth-gate-tab${mode === "signup" ? " fm-auth-gate-tab-active" : ""}`}
                    onClick={() => setMode("signup")}
                    data-testid="auth-tab-signup"
                  >
                    Daftar
                  </button>
                </div>
              )}

              {status === "success" ? (
                <p className="fm-auth-note" data-testid="auth-success-note">
                  {message}
                </p>
              ) : (
                <form onSubmit={mode === "signin" ? handleSignIn : mode === "signup" ? handleSignUp : handleForgot}>
                  <label className="fm-export-field fm-auth-gate-email">
                    <span>Email</span>
                    <input
                      type="email"
                      required
                      autoFocus
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (status === "error") setStatus("idle");
                      }}
                      data-testid="auth-email-input"
                    />
                  </label>

                  {mode !== "forgot" && (
                    <label className="fm-export-field fm-auth-gate-email">
                      <span>Password</span>
                      <div className="fm-auth-password-field">
                        <input
                          type={showPassword ? "text" : "password"}
                          required
                          minLength={6}
                          placeholder={mode === "signup" ? "Minimal 6 karakter" : "Password"}
                          value={password}
                          onChange={(e) => {
                            setPassword(e.target.value);
                            if (status === "error") setStatus("idle");
                          }}
                          data-testid="auth-password-input"
                        />
                        <button
                          type="button"
                          className="fm-auth-password-toggle"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}
                          aria-pressed={showPassword}
                          data-testid="auth-password-toggle"
                        >
                          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </label>
                  )}

                  {mode === "signup" && (
                    <label className="fm-export-field fm-auth-gate-email">
                      <span>Konfirmasi password</span>
                      <div className="fm-auth-password-field">
                        <input
                          type={showConfirmPassword ? "text" : "password"}
                          required
                          minLength={6}
                          placeholder="Ulangi password"
                          value={confirmPassword}
                          onChange={(e) => {
                            setConfirmPassword(e.target.value);
                            if (status === "error") setStatus("idle");
                          }}
                          data-testid="auth-confirm-password-input"
                        />
                        <button
                          type="button"
                          className="fm-auth-password-toggle"
                          onClick={() => setShowConfirmPassword((v) => !v)}
                          aria-label={showConfirmPassword ? "Sembunyikan password" : "Tampilkan password"}
                          aria-pressed={showConfirmPassword}
                          data-testid="auth-confirm-password-toggle"
                        >
                          {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </label>
                  )}

                  {status === "error" && message && <p className="fm-auth-note fm-auth-note-error">{message}</p>}

                  {mode === "signin" && (
                    <button
                      type="button"
                      className="fm-auth-link-btn"
                      onClick={() => setMode("forgot")}
                      data-testid="auth-forgot-link"
                    >
                      Lupa password?
                    </button>
                  )}

                  <button
                    type="submit"
                    className="fm-auth-submit-btn fm-auth-btn-pro"
                    disabled={busy}
                    data-testid="auth-submit-btn"
                  >
                    {mode === "forgot" ? <KeyRound size={15} /> : <Mail size={15} />}{" "}
                    {busy
                      ? "Memproses…"
                      : mode === "signin"
                        ? "Masuk"
                        : mode === "signup"
                          ? "Daftar"
                          : "Kirim link reset"}
                  </button>

                  {mode === "forgot" && (
                    <button
                      type="button"
                      className="fm-auth-link-btn"
                      onClick={() => setMode("signin")}
                      data-testid="auth-back-to-signin-link"
                    >
                      Kembali ke halaman masuk
                    </button>
                  )}
                </form>
              )}

              <button type="button" className="fm-auth-gate-wa" onClick={handleWhatsApp} data-testid="auth-pro-whatsapp-cta">
                <Sparkles size={13} /> Berminat menggunakan fitur PRO?
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
