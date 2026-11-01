#!/usr/bin/env bash
# One-command, safe deploy from YOUR terminal to your Cloudflare account.
#
#   bash scripts/deploy-local.sh           # check everything, deploy, set up, verify the live site
#   bash scripts/deploy-local.sh --check   # run the safety checks only; deploy nothing
#
# It only ever touches: the Worker "youtube-automation-platform" and the D1 database "youtube-automation-db".
# It never edits DNS, routes, domains, other Workers or other databases, and creates no paid resources.
set -euo pipefail

WORKER="youtube-automation-platform"
DB_NAME="youtube-automation-db"
DB_ID="15ee6196-efbc-4356-906f-e32a8d9e0465"
BRANCH="feature/phase1-d1-backend"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

cd "$(dirname "$0")/.."
LOG="$(mktemp -d)"
say() { printf '\n== %s\n' "$*"; }
ok() { printf '   OK: %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"; }

need git "Install git."
need node "Install Node.js 20 or newer."
need npx "Install Node.js 20 or newer."
need curl "Install curl."
need bun "Install it with:  npm install -g bun"

say "1. Check this is the verified code"
cur="$(git rev-parse --abbrev-ref HEAD)"
[ "$cur" = "$BRANCH" ] || die "You are on '$cur'. Run:  git checkout $BRANCH"
[ -z "$(git status --porcelain)" ] || die "You have uncommitted changes. Commit or stash them first so what is deployed matches GitHub."
ok "on $BRANCH, working tree clean ($(git rev-parse --short HEAD))"

say "2. Install, type-check, test and build"
bun install --frozen-lockfile
npx tsc --noEmit
ok "TypeScript clean"
bun run test
ok "tests passed"
bun run build
ok "production build succeeded"

say "3. Log in to Cloudflare (a browser window opens; your password never goes through this script)"
if ! npx wrangler whoami 2>&1 | tee "$LOG/who.txt" | grep -qiE "associated with the email|You are logged in"; then
  if grep -qi "not authenticated" "$LOG/who.txt"; then
    npx wrangler login
  fi
fi
npx wrangler whoami 2>&1 | tee "$LOG/who2.txt" | grep -qiE "associated with the email|You are logged in" || die "Not logged in to Cloudflare."
ok "logged in"

say "4. Verify the dedicated D1 database"
npx wrangler d1 list --json > "$LOG/d1.json" 2>"$LOG/d1.err" || { cat "$LOG/d1.err" >&2; die "Could not list your D1 databases."; }
found="$(D1JSON="$LOG/d1.json" node -e '
  const fs = require("fs"); const [name, id] = process.argv.slice(1);
  const list = JSON.parse(fs.readFileSync(process.env.D1JSON, "utf8"));
  const hit = list.find((d) => d.name === name);
  console.log(!hit ? "missing" : (hit.uuid || hit.id) === id ? "match" : "mismatch:" + (hit.uuid || hit.id));
' "$DB_NAME" "$DB_ID")"
case "$found" in
  match) ok "$DB_NAME exists and its id matches wrangler.jsonc" ;;
  missing) die "No D1 database named '$DB_NAME' in THIS Cloudflare account. You may be logged in to a different account. Nothing was changed." ;;
  *) die "A database named '$DB_NAME' exists but its id differs ($found vs $DB_ID). Fix database_id in wrangler.jsonc. Nothing was changed." ;;
esac
tables="$(npx wrangler d1 execute "$DB_NAME" --remote --json --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','ideas','scripts','videos','approvals','settings','ai_usage','youtube_accounts','automation_runs')" 2>"$LOG/d1x.err" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].results[0].n)}catch{console.log("?")}})')"
[ "$tables" = "10" ] || die "The database does not have the expected tables (found '$tables' of 10). Apply migrations:  npx wrangler d1 migrations apply DB --remote"
ok "the schema is present (migrations applied)"

say "5. Make sure the Worker name is not used by another project"
dep="$(npx wrangler deployments list --name "$WORKER" 2>&1 || true)"
if printf '%s' "$dep" | grep -qiE "does not exist|not found|could not find|10007"; then
  ok "no Worker named '$WORKER' exists yet - this deploy will create it"
elif printf '%s' "$dep" | grep -qiE "Created:|Version\(s\)|deployment"; then
  echo "   A Worker named '$WORKER' ALREADY exists in this account."
  if [ "${CONFIRM_OVERWRITE:-}" = "YES" ]; then ans="YES"; else
    printf '   Is it from this project and OK to update? Type YES to continue, anything else to stop: '
    ans=""; read -r ans </dev/tty 2>/dev/null || true
  fi
  [ "$ans" = "YES" ] || die "Stopped. Nothing was changed."
else
  die "Could not tell whether '$WORKER' exists:
$dep
Nothing was changed."
fi

if [ "$CHECK_ONLY" = "1" ]; then
  say "Check complete: everything is ready. Run again without --check to deploy."
  exit 0
fi

say "6. Deploy (only the Worker '$WORKER'; no routes, DNS or domains are touched)"
npx wrangler deploy 2>&1 | tee "$LOG/deploy.txt"
URL="$(grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev' "$LOG/deploy.txt" | head -1 || true)"
if [ -z "$URL" ]; then
  printf 'Could not read the URL from the output. Paste your Worker URL (https://...workers.dev): '
  read -r URL </dev/tty || true
fi
[ -n "$URL" ] || die "No URL. The deploy may have worked; check the Cloudflare dashboard."
ok "deployed to $URL"

say "7. Create the one-time sign-up code (lets only YOU create the owner account)"
CODE="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
printf '%s' "$CODE" | npx wrangler secret put SETUP_CODE >/dev/null
ok "SETUP_CODE saved as a secret on the Worker"

say "8. Verify the live site"
fail=0
check() { # name, command that must succeed
  if eval "$2" >"$LOG/c.out" 2>&1; then ok "$1"; else printf '   FAIL: %s\n' "$1"; sed 's/^/        /' "$LOG/c.out" | head -5; fail=1; fi
}
for i in 1 2 3 4 5 6; do
  h="$(curl -fsS -m 20 "$URL/api/health" 2>/dev/null || true)"
  printf '%s' "$h" | grep -q '"database":"d1"' && break
  sleep 8
done
check "database is connected: $h" "printf '%s' '$h' | grep -q '\"database\":\"d1\"'"
check "home page loads (HTTP 200)" "test \"\$(curl -s -m 20 -o /dev/null -w '%{http_code}' '$URL/')\" = 200"
check "home page is the studio app" "curl -fsS -m 20 '$URL/' | grep -qi 'Tony AI YouTube Studio'"
check "security headers are present" "curl -sI -m 20 '$URL/' | grep -qi 'x-content-type-options: nosniff'"
check "private data is not exposed without signing in" "! curl -fsS -m 20 '$URL/api/health' | grep -qiE 'password|token|secret'"

echo
if [ "$fail" = "0" ]; then
  echo "=============================================================="
  echo "  LIVE AND VERIFIED:  $URL"
  echo "  1) Open it and create your account."
  echo "  2) Your one-time sign-up code (shown ONCE, save it now):"
  echo "       $CODE"
  echo "  3) After you have signed up, remove the code so nobody else can:"
  echo "       npx wrangler secret delete SETUP_CODE"
  echo "=============================================================="
else
  echo "Deployed to $URL, but some checks failed (see above). Send me this output."
  echo "Live logs:  npx wrangler tail $WORKER"
  exit 2
fi
