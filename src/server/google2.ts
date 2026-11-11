// Second YouTube channel: its own Google project (own daily upload allowance). Separate from the first channel.
import type { D1Database, WorkerEnv } from "./db";
import { AppError } from "./errors";
import { randomToken, sha256Hex } from "./crypto";
import { decryptSecret, encryptSecret } from "./secretbox";
import { SCOPES, buildAuthUrl, pkce, redirectUriFor } from "./google";

export const STATE2 = "c2.";
export const STATE3 = "c3."; // third channel: same code, its own stored slot (uses GOOGLE_CLIENT_ID_3 when set, else the second channel's Google project)
const now = () => Math.floor(Date.now() / 1000);
type F = typeof fetch;
type Env2 = Pick<WorkerEnv, "GOOGLE_CLIENT_ID_2" | "GOOGLE_CLIENT_SECRET_2" | "GOOGLE_CLIENT_ID_3" | "GOOGLE_CLIENT_SECRET_3" | "TOKEN_ENC_KEY">;
export type Slot = 2 | 3;

/** Google client for a slot: the third channel may have its own project, otherwise it shares the second one's. */
function creds(env: Env2, slot: Slot): { id: string; secret: string } {
  const id = (slot === 3 ? env.GOOGLE_CLIENT_ID_3 : undefined) || env.GOOGLE_CLIENT_ID_2;
  const secret = (slot === 3 ? env.GOOGLE_CLIENT_SECRET_3 : undefined) || env.GOOGLE_CLIENT_SECRET_2;
  if (!id || !secret || !env.TOKEN_ENC_KEY)
    throw new AppError(`The ${slot === 3 ? "third" : "second"} channel is not set up yet (GOOGLE_CLIENT_ID_2 / GOOGLE_CLIENT_SECRET_2 missing).`);
  return { id, secret };
}
const ordinal = (slot: Slot) => (slot === 3 ? "third" : "second");

async function ensure(db: D1Database) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS extra_channels (slot INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, channel_title TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, connected_at TEXT)",
    )
    .run();
}

export async function channel2Connected(db: D1Database): Promise<boolean> {
  return channelConnected(db, 2);
}

export async function channelConnected(db: D1Database, slot: Slot): Promise<boolean> {
  try {
    await ensure(db);
    return !!(await db.prepare("SELECT 1 AS x FROM extra_channels WHERE slot = ?").bind(slot).first());
  } catch {
    return false;
  }
}

export async function startOAuth2(db: D1Database, env: Env2, userId: string, origin: string, slot: Slot = 2): Promise<string> {
  const c = creds(env, slot);
  const state = (slot === 3 ? STATE3 : STATE2) + randomToken(32);
  const { verifier, challenge } = await pkce();
  await db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now()).run();
  await db
    .prepare("INSERT INTO oauth_states (state_hash, user_id, code_verifier, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(state), userId, verifier, now() + 600)
    .run();
  return buildAuthUrl({ clientId: c.id, redirectUri: redirectUriFor(origin), state, challenge });
}

async function tokenRequest(body: Record<string, string>, f: F) {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json };
}

export async function completeOAuth2(
  db: D1Database,
  env: Env2,
  userId: string,
  origin: string,
  code: string,
  state: string,
  f: F = fetch,
): Promise<{ channelTitle: string }> {
  const slot: Slot = state.startsWith(STATE3) ? 3 : 2;
  const c = creds(env, slot);
  await ensure(db);
  const stateHash = await sha256Hex(state);
  const row = await db
    .prepare("SELECT user_id, code_verifier, expires_at FROM oauth_states WHERE state_hash = ?")
    .bind(stateHash)
    .first<{ user_id: string; code_verifier: string; expires_at: number }>();
  await db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
  if (!row || row.user_id !== userId || row.expires_at < now())
    throw new AppError("This sign-in link expired or is invalid. Please start the connection again.");
  const tok = await tokenRequest(
    {
      client_id: c.id,
      client_secret: c.secret,
      code,
      code_verifier: row.code_verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUriFor(origin),
    },
    f,
  );
  const refresh = tok.json["refresh_token"];
  const access = tok.json["access_token"];
  if (!tok.ok || typeof refresh !== "string" || typeof access !== "string")
    throw new AppError(`Google did not accept the sign-in for the ${ordinal(slot)} channel. Please try again.`);
  const granted = String(tok.json["scope"] ?? "");
  if (SCOPES.some((s) => !new Set(granted.split(/\s+/)).has(s)))
    throw new AppError("Some YouTube permissions were not granted. Connect again and allow all of them.");
  const res = await f("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { authorization: `Bearer ${access}` },
  });
  if (!res.ok) throw new AppError(`YouTube rejected the request (${res.status}).`);
  const ch = ((await res.json()) as { items?: { id: string; snippet: { title: string } }[] }).items?.[0];
  if (!ch) throw new AppError("That Google account has no YouTube channel.");
  await db
    .prepare(
      `INSERT INTO extra_channels (slot, channel_id, channel_title, refresh_token_enc, connected_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slot) DO UPDATE SET channel_id=excluded.channel_id, channel_title=excluded.channel_title, refresh_token_enc=excluded.refresh_token_enc, connected_at=datetime('now')`,
    )
    .bind(slot, ch.id, ch.snippet.title, await encryptSecret(refresh, env.TOKEN_ENC_KEY!))
    .run();
  return { channelTitle: ch.snippet.title };
}

export async function getAccessToken2(db: D1Database, env: Env2, f: F = fetch, slot: Slot = 2): Promise<{ accessToken: string; channelId: string }> {
  const c = creds(env, slot);
  await ensure(db);
  const acc = await db
    .prepare("SELECT channel_id, refresh_token_enc FROM extra_channels WHERE slot = ?")
    .bind(slot)
    .first<{ channel_id: string; refresh_token_enc: string }>();
  if (!acc) throw new AppError(`The ${ordinal(slot)} channel is not connected yet.`);
  const tok = await tokenRequest(
    {
      client_id: c.id,
      client_secret: c.secret,
      refresh_token: await decryptSecret(acc.refresh_token_enc, env.TOKEN_ENC_KEY!),
      grant_type: "refresh_token",
    },
    f,
  );
  if (!tok.ok || typeof tok.json["access_token"] !== "string")
    throw new AppError(`Google access for the ${ordinal(slot)} channel expired. Connect it again (a Google project in Testing mode expires after 7 days).`);
  return { accessToken: tok.json["access_token"], channelId: acc.channel_id };
}
