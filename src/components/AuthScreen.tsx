import { useState, type FormEvent } from "react";
import * as api from "@/lib/api.functions";

type Props = {
  setupOpen: boolean;
  setupConfigured: boolean;
  onDone: () => void;
};

const errText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";

/** Sign-in, or one-time owner setup when no account exists yet. */
export function AuthScreen({ setupOpen, setupConfigured, onDone }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (setupOpen) await api.setupAccount({ data: { email, password, setupCode } });
      else await api.login({ data: { email, password } });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary font-display text-base font-bold text-primary-foreground">
            T
          </div>
          <div className="leading-tight">
            <div className="font-display text-base font-semibold">Tony AI</div>
            <div className="text-xs text-muted-foreground">YouTube Studio</div>
          </div>
        </div>

        <form className="panel space-y-4 p-6" onSubmit={submit} aria-labelledby="auth-title">
          <div>
            <h1 id="auth-title" className="text-xl font-semibold">
              {setupOpen ? "Create the owner account" : "Sign in"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {setupOpen
                ? "First-time setup. This account will own the studio and no other sign-ups are allowed."
                : "Sign in to your studio."}
            </p>
          </div>

          {setupOpen && !setupConfigured && (
            <p
              role="alert"
              className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
            >
              Setup is locked. Set a <code className="font-mono">SETUP_CODE</code> secret on the
              server first (see the README), then reload this page.
            </p>
          )}

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Email</span>
            <input
              className="field"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <div className="text-sm">
            <label htmlFor="auth-password" className="mb-1 block font-medium">
              Password
            </label>
            <input
              id="auth-password"
              className="field"
              type="password"
              autoComplete={setupOpen ? "new-password" : "current-password"}
              required
              minLength={setupOpen ? 12 : 1}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={setupOpen ? "pw-hint" : undefined}
            />
            {setupOpen && (
              <span id="pw-hint" className="mt-1 block text-xs text-muted-foreground">
                At least 12 characters. A long passphrase is best.
              </span>
            )}
          </div>
          {setupOpen && (
            <div className="text-sm">
              <label htmlFor="auth-setup-code" className="mb-1 block font-medium">
                Setup code
              </label>
              <input
                id="auth-setup-code"
                className="field"
                type="password"
                autoComplete="off"
                required
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                aria-describedby="code-hint"
              />
              <span id="code-hint" className="mt-1 block text-xs text-muted-foreground">
                The SETUP_CODE secret configured on the server.
              </span>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            className="btn btn-primary w-full"
            type="submit"
            disabled={busy || (setupOpen && !setupConfigured)}
          >
            {busy ? "Please wait…" : setupOpen ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Your password is never stored in readable form and is never sent anywhere except this
          server.
        </p>
      </div>
    </div>
  );
}
