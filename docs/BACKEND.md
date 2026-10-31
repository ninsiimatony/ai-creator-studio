# Backend (Phase 1): Cloudflare Workers + D1

Tony AI YouTube Studio runs as a single Cloudflare Worker (TanStack Start SSR + server
functions) with a Cloudflare D1 (SQLite) database. No paid service is required for local
development, and nothing here deploys anything by itself.

Integrations (all optional, each shows "Not connected" until its secret exists): Claude (ideas, scripts,
SEO, thumbnails, storyboards), Google OAuth + YouTube Data/Analytics APIs, ElevenLabs voiceover.

## How it fits together

```
Browser ──► Worker (SSR + server functions in src/lib/api.functions.ts)
                 └─► D1 binding "DB"  (src/server/*, migrations/*.sql)
```

- `src/lib/api.functions.ts` — the only API surface. Every function validates input with zod and
  (except sign-in/setup) requires a session. Unexpected errors are logged and masked.
- `src/server/` — server-only code (database, auth, crypto, repository). TanStack's import
  protection fails the build if client code imports it.
- `migrations/` — versioned D1 schema. Apply with `wrangler d1 migrations apply`.
- **Demo mode:** when no D1 binding exists (plain `vite dev`, the Lovable preview, unit tests) the
  app falls back to in-memory sample data and shows a "Demo mode" banner. This keeps the Lovable
  preview working. Nothing is saved in demo mode.

## Run it locally (free, no Cloudflare account needed)

```bash
bun install
SETUP_CODE='choose-a-long-random-string' bun run cf:preview   # builds, migrates local D1, serves
# open the printed http://127.0.0.1:8787 and create the owner account with that setup code
```

Local data lives in `.wrangler/state` (git-ignored). Delete that folder to start fresh.
`bun run dev` still works and runs in demo mode (no database).

```bash
bun run test    # unit + D1 integration tests (real local D1)
bun run lint
npx tsc --noEmit
```

## Authentication and security

- **Email + password.** Passwords are hashed with PBKDF2-SHA256 (100,000 iterations, the Workers
  maximum) and a per-user salt. Minimum 12 characters.
- **Single owner.** Sign-up exists only until the first account is created, and it additionally
  requires the `SETUP_CODE` secret, so a stranger who finds the URL first cannot claim the studio.
  If `SETUP_CODE` is not configured, setup is disabled.
- **Sessions.** A random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over
  HTTPS). Only a SHA-256 hash of the token is stored. Sessions last 30 days and can be revoked
  by signing out.
- **Brute force.** 5 failed sign-ins per email + client within 15 minutes locks that pair out.
  Unknown accounts and wrong passwords return the same message.
- **CSRF.** TanStack Start's CSRF middleware protects server functions (see `src/start.ts`).
- **Tenant isolation.** Every table carries `user_id` and every query filters on it.
- **Headers.** `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and `Cache-Control: no-store`
  on server-function responses. `X-Frame-Options` is deliberately not set because the Lovable
  editor previews the app in an iframe. A Content-Security-Policy is future hardening.
- **Publishing.** There is no publish endpoint and the schema has no "published" state. A video
  can only reach `approved` through an explicit, confirmed approval that is recorded in the
  append-only `approvals` table. Phase 3 (YouTube) must keep requiring that record.
- **Secrets.** No secret is in the repo or the client bundle. Set production secrets with
  `wrangler secret put <NAME>`; use `.dev.vars` (git-ignored) only for local runs.

## Schema (migrations/0001_init.sql)

`users`, `sessions`, `login_attempts`, `ideas`, `scripts`, `videos`, `approvals`, `settings`.

## Deploying

See [DEPLOY.md](DEPLOY.md) for the dedicated Worker, D1 database, secrets and verification steps.

## Working with Lovable

Lovable syncs the default branch. Develop on a feature branch, never rewrite or force-push
published history, and keep `src/routes/__root.tsx` rendering through `SessionGate` so the demo-mode
fallback keeps the Lovable preview working.
