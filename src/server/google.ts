// Google OAuth (authorization code + PKCE) and the YouTube Data API.
// The user signs in on Google's own pages; this app never sees a Google password.
import type { D1Database, WorkerEnv } from "./db";
import { AppError } from "./errors";
import { randomToken, sha256Hex } from "./crypto";
import { decryptSecret, encryptSecret } from "./secretbox";

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
const STATE_TTL_SECONDS = 10 * 60;
const now = () => Math.floor(Date.now() / 1000);

type F = typeof fetch;
export type GoogleEnv = Pick<
  WorkerEnv,
  "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "TOKEN_ENC_KEY"
>;

export function googleConfigured(env: GoogleEnv): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENC_KEY);
}
function requireConfigured(env: GoogleEnv) {
  if (!googleConfigured(env)) {
    throw new AppError(
      "YouTube is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENC_KEY secrets first.",
    );
  }
}

export const redirectUriFor = (origin: string) => `${origin}/api/auth/google/callback`;

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

/** Begins a connection: stores a single-use state + PKCE verifier and returns Google's consent URL. */
export async function startOAuth(
  db: D1Database,
  env: GoogleEnv,
  userId: string,
  origin: string,
): Promise<string> {
  requireConfigured(env);
  const state = randomToken(32);
  const { verifier, challenge } = await pkce();
  await db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now()).run();
  await db
    .prepare(
      "INSERT INTO oauth_states (state_hash, user_id, code_verifier, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(await sha256Hex(state), userId, verifier, now() + STATE_TTL_SECONDS)
    .run();
  return buildAuthUrl({
    clientId: env.GOOGLE_CLIENT_ID!,
    redirectUri: redirectUriFor(origin),
    state,
    challenge,
  });
}

async function tokenRequest(body: Record<string, string>, f: F) {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

async function fetchMyChannel(accessToken: string, f: F) {
  const res = await f("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new AppError(`YouTube rejected the request (${res.status}).`);
  const json = (await res.json()) as { items?: { id: string; snippet: { title: string } }[] };
  const ch = json.items?.[0];
  if (!ch)
    throw new AppError("That Google account has no YouTube channel. Create one on YouTube first.");
  return { id: ch.id, title: ch.snippet.title };
}

/** Finishes a connection from Google's redirect. The state must belong to this user and be unused. */
export async function completeOAuth(
  db: D1Database,
  env: GoogleEnv,
  userId: string,
  origin: string,
  code: string,
  state: string,
  f: F = fetch,
): Promise<{ channelTitle: string }> {
  requireConfigured(env);
  const stateHash = await sha256Hex(state);
  const row = await db
    .prepare("SELECT user_id, code_verifier, expires_at FROM oauth_states WHERE state_hash = ?")
    .bind(stateHash)
    .first<{ user_id: string; code_verifier: string; expires_at: number }>();
  // Single use: delete before doing anything else.
  await db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
  if (!row || row.user_id !== userId || row.expires_at < now()) {
    throw new AppError(
      "This sign-in link expired or is invalid. Please start the connection again.",
    );
  }

  const tok = await tokenRequest(
    {
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      code,
      code_verifier: row.code_verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUriFor(origin),
    },
    f,
  );
  if (!tok.ok) {
    console.error("google token exchange failed", tok.status, tok.json["error"]);
    throw new AppError("Google did not accept the sign-in. Please try connecting again.");
  }
  const refresh = tok.json["refresh_token"];
  const access = tok.json["access_token"];
  if (typeof refresh !== "string" || typeof access !== "string") {
    throw new AppError(
      "Google did not grant offline access. Remove this app at myaccount.google.com/permissions and connect again.",
    );
  }
  const granted = String(tok.json["scope"] ?? "");
  const missing = SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) {
    throw new AppError(
      "Some requested YouTube permissions were not granted. Please connect again and allow all of them.",
    );
  }

  const channel = await fetchMyChannel(access, f);
  await db
    .prepare(
      `INSERT INTO youtube_accounts (user_id, channel_id, channel_title, refresh_token_enc, scopes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET channel_id = excluded.channel_id, channel_title = excluded.channel_title,
         refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes, connected_at = datetime('now')`,
    )
    .bind(
      userId,
      channel.id,
      channel.title,
      await encryptSecret(refresh, env.TOKEN_ENC_KEY),
      granted,
    )
    .run();
  return { channelTitle: channel.title };
}

/** A fresh short-lived access token for the user's channel (never stored). */
export async function getAccessToken(
  db: D1Database,
  env: GoogleEnv,
  userId: string,
  f: F = fetch,
): Promise<{ accessToken: string; channelId: string }> {
  requireConfigured(env);
  const acc = await db
    .prepare("SELECT channel_id, refresh_token_enc FROM youtube_accounts WHERE user_id = ?")
    .bind(userId)
    .first<{ channel_id: string; refresh_token_enc: string }>();
  if (!acc)
    throw new AppError(
      "YouTube is not connected. Connect your channel on the YouTube channel page.",
    );
  const refreshToken = await decryptSecret(acc.refresh_token_enc, env.TOKEN_ENC_KEY);
  const tok = await tokenRequest(
    {
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    f,
  );
  if (!tok.ok || typeof tok.json["access_token"] !== "string") {
    if (tok.json["error"] === "invalid_grant") {
      throw new AppError(
        "Google access expired or was revoked. Reconnect YouTube. (If your Google OAuth app is in 'Testing' mode, tokens expire after 7 days.)",
      );
    }
    console.error("google refresh failed", tok.status, tok.json["error"]);
    throw new AppError("Could not refresh Google access. Please try again.");
  }
  return { accessToken: tok.json["access_token"], channelId: acc.channel_id };
}

export async function disconnect(
  db: D1Database,
  env: GoogleEnv,
  userId: string,
  f: F = fetch,
): Promise<void> {
  const acc = await db
    .prepare("SELECT refresh_token_enc FROM youtube_accounts WHERE user_id = ?")
    .bind(userId)
    .first<{ refresh_token_enc: string }>();
  if (!acc) return;
  // Best effort: revoke at Google, then always forget it locally.
  try {
    const token = await decryptSecret(acc.refresh_token_enc, env.TOKEN_ENC_KEY);
    await f("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (e) {
    console.error("token revoke failed (continuing)", e);
  }
  await db.prepare("DELETE FROM youtube_accounts WHERE user_id = ?").bind(userId).run();
}

export type ChannelStats = {
  title: string;
  channelId: string;
  subscribers: number | null; // null when the channel hides its count
  views: number;
  videos: number;
  thumbnailUrl: string | null;
};

export async function fetchChannelStats(
  db: D1Database,
  env: GoogleEnv,
  userId: string,
  f: F = fetch,
): Promise<ChannelStats> {
  const { accessToken } = await getAccessToken(db, env, userId, f);
  const res = await f(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new AppError(`YouTube rejected the request (${res.status}).`);
  const json = (await res.json()) as {
    items?: {
      id: string;
      snippet: { title: string; thumbnails?: { default?: { url: string } } };
      statistics: {
        subscriberCount?: string;
        viewCount?: string;
        videoCount?: string;
        hiddenSubscriberCount?: boolean;
      };
    }[];
  };
  const ch = json.items?.[0];
  if (!ch) throw new AppError("No YouTube channel found for the connected account.");
  return {
    title: ch.snippet.title,
    channelId: ch.id,
    subscribers: ch.statistics.hiddenSubscriberCount
      ? null
      : Number(ch.statistics.subscriberCount ?? 0),
    views: Number(ch.statistics.viewCount ?? 0),
    videos: Number(ch.statistics.videoCount ?? 0),
    thumbnailUrl: ch.snippet.thumbnails?.default?.url ?? null,
  };
}
