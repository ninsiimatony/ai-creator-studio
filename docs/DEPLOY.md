# Deploying to Cloudflare (isolated project)

Everything below uses resources dedicated to this project:

| Resource    | Name / id                                                        | Status                                       |
| ----------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Worker      | `youtube-automation-platform`                                    | **not deployed yet**                         |
| D1 database | `youtube-automation-db` (`15ee6196-efbc-4356-906f-e32a8d9e0465`) | created, migrations 0001–0002 applied, empty |
| R2 bucket   | —                                                                | not used (nothing is stored as files)        |

The Worker's URL will be `https://youtube-automation-platform.<your-workers-subdomain>.workers.dev`.
(It is a Worker, not a Pages project, so it is served from `workers.dev`, not `pages.dev`.)
No custom domain or DNS record is touched.

## Deploy (two options)

### A. From your computer (about 5 minutes)

```bash
git clone https://github.com/ninsiimatony/ai-creator-studio && cd ai-creator-studio
git checkout feature/phase1-d1-backend
bun install
bun run test && npx tsc --noEmit      # optional sanity check
bun run build
npx wrangler login                    # opens Cloudflare in your browser
npx wrangler deploy                   # creates the Worker and prints its URL
```

### B. Cloudflare dashboard (no terminal)

Workers & Pages → Create → Import a repository → `ai-creator-studio`, branch `feature/phase1-d1-backend`.
Build command `bun install && bun run build`, deploy command `npx wrangler deploy`.

## Secrets (set after the first deploy)

```bash
npx wrangler secret put SETUP_CODE            # required: lets YOU create the owner account
# optional integrations — each feature stays "Not connected" until its secret exists:
npx wrangler secret put ANTHROPIC_API_KEY     # AI (also set a daily AI budget in Settings; 0 = off)
npx wrangler secret put GOOGLE_CLIENT_ID      # YouTube
npx wrangler secret put GOOGLE_CLIENT_SECRET  # YouTube
npx wrangler secret put TOKEN_ENC_KEY         # YouTube; value from: openssl rand -base64 32
npx wrangler secret put ELEVENLABS_API_KEY    # voiceover
npx wrangler secret put ELEVENLABS_VOICE_ID   # voiceover default voice (optional)
```

Optional plain variables: `AI_MODEL_WRITER` (default `claude-sonnet-5-5`), `AI_MODEL_FAST` (default `claude-haiku-5-5`).

## First run

1. Open the URL and create the owner account with your `SETUP_CODE`.
2. Remove the setup secret so nobody else can ever register: `npx wrangler secret delete SETUP_CODE`.
3. In **Settings**, set a daily AI budget (USD) if you added an Anthropic key.
4. For YouTube: follow the checklist on the **YouTube channel** page. The redirect URI to register with
   Google is `https://<your-url>/api/auth/google/callback`.

## Verify the live site

```bash
curl https://<your-url>/api/health        # expect {"ok":true,"database":"d1"}
```

Then sign in, add an idea, refresh the page, and confirm it is still there.

## Costs

- Workers Free + D1 Free: $0. D1 queries fail rather than bill when free limits are reached.
- Rendering may exceed the Free plan's 10 ms CPU per request; if you see errors 1102, Workers Paid is $5/month.
- Claude, ElevenLabs and Google are billed by those providers, only if you add their keys. The app enforces
  an AI daily budget and a voiceover daily character cap.

## Updating the database later

Add a new numbered file in `migrations/`, then `npx wrangler d1 migrations apply DB --remote`.
Migrations 0001–0002 are already recorded in the remote database's `d1_migrations` table.
