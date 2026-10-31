// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import {
  SCOPES,
  buildAuthUrl,
  completeOAuth,
  disconnect,
  fetchChannelStats,
  getAccessToken,
  pkce,
  startOAuth,
} from "@/server/google";
import { decryptSecret, encryptSecret } from "@/server/secretbox";
import { sha256Hex } from "@/server/crypto";

let db: D1Database;
let dispose: () => Promise<void>;
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", TOKEN_ENC_KEY: KEY };
const ORIGIN = "https://studio.example.dev";
const ALL_SCOPES = SCOPES.join(" ");

async function mkUser(email: string) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')")
    .bind(id, email)
    .run();
  return id;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeGoogle(h: Partial<Record<"token" | "channels" | "revoke", Handler>>) {
  const calls: { url: string; body: string }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: String(init?.body ?? "") });
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return h.token ? h.token(url, init) : json({ error: "invalid_request" }, 400);
    if (url.startsWith("https://www.googleapis.com/youtube/v3/channels"))
      return h.channels ? h.channels(url, init) : json({ items: [] });
    if (url.startsWith("https://oauth2.googleapis.com/revoke"))
      return h.revoke ? h.revoke(url, init) : json({});
    return json({ error: "unexpected " + url }, 500);
  };
  return { f, calls };
}
const okToken = () =>
  new Response(
    JSON.stringify({
      access_token: "ya29.access",
      refresh_token: "1//refresh-secret",
      scope: ALL_SCOPES,
      expires_in: 3600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const okChannel = () =>
  new Response(JSON.stringify({ items: [{ id: "UC123", snippet: { title: "Tony AI" } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Starts a flow and returns the raw state Google would echo back. */
async function begin(userId: string) {
  const url = new URL(await startOAuth(db, env, userId, ORIGIN));
  return { state: url.searchParams.get("state")!, url };
}

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
}, 60_000);
afterAll(async () => dispose?.());

describe("secretbox", () => {
  it("round-trips, uses a fresh IV, and rejects tampering or the wrong key", async () => {
    const a = await encryptSecret("refresh-token", KEY);
    const b = await encryptSecret("refresh-token", KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-token");
    expect(await decryptSecret(a, KEY)).toBe("refresh-token");
    const tampered = a.slice(0, -3) + (a.endsWith("AAA") ? "BBB" : "AAA");
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
    const other = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await expect(decryptSecret(a, other)).rejects.toThrow(/decrypt/);
    await expect(encryptSecret("x", undefined)).rejects.toThrow(/TOKEN_ENC_KEY/);
    await expect(encryptSecret("x", btoa("short"))).rejects.toThrow(/32 random bytes/);
  });
});

describe("authorization URL", () => {
  it("uses PKCE S256, offline access, all scopes, and a matching challenge", async () => {
    const { verifier, challenge } = await pkce();
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    expect(challenge).toBe(
      btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    );
    const u = new URL(
      buildAuthUrl({ clientId: "cid", redirectUri: ORIGIN + "/cb", state: "s", challenge }),
    );
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("scope")).toBe(ALL_SCOPES);
    expect(u.searchParams.get("client_secret")).toBeNull(); // the secret never goes to the browser
  });

  it("refuses to start without Google credentials", async () => {
    const u = await mkUser("nocreds@x.co");
    await expect(startOAuth(db, {}, u, ORIGIN)).rejects.toThrow(/not configured/);
  });

  it("stores only a hash of the state", async () => {
    const u = await mkUser("hash@x.co");
    const { state } = await begin(u);
    const rows = await db
      .prepare("SELECT state_hash FROM oauth_states")
      .all<{ state_hash: string }>();
    expect(rows.results.some((r) => r.state_hash === state)).toBe(false);
    const hashed = await sha256Hex(state);
    expect(rows.results.some((r) => r.state_hash === hashed)).toBe(true);
  });
});

describe("completing the connection", () => {
  it("stores the channel and an ENCRYPTED refresh token, and sends the PKCE verifier", async () => {
    const u = await mkUser("ok@x.co");
    const { state } = await begin(u);
    const g = fakeGoogle({ token: okToken, channels: okChannel });
    const r = await completeOAuth(db, env, u, ORIGIN, "auth-code", state, g.f);
    expect(r.channelTitle).toBe("Tony AI");

    const row = await db
      .prepare("SELECT * FROM youtube_accounts WHERE user_id = ?")
      .bind(u)
      .first<Record<string, string>>();
    expect(row).toMatchObject({ channel_id: "UC123", channel_title: "Tony AI" });
    expect(row!["refresh_token_enc"]).not.toContain("refresh-secret");
    expect(await decryptSecret(row!["refresh_token_enc"]!, KEY)).toBe("1//refresh-secret");

    const body = new URLSearchParams(g.calls[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")!.length).toBeGreaterThan(40);
    expect(body.get("redirect_uri")).toBe(ORIGIN + "/api/auth/google/callback");
  });

  it("makes the state single-use", async () => {
    const u = await mkUser("single@x.co");
    const { state } = await begin(u);
    const g = fakeGoogle({ token: okToken, channels: okChannel });
    await completeOAuth(db, env, u, ORIGIN, "c", state, g.f);
    await expect(completeOAuth(db, env, u, ORIGIN, "c", state, g.f)).rejects.toThrow(
      /expired or is invalid/,
    );
  });

  it("rejects an unknown, expired, or other user's state, without calling Google", async () => {
    const owner = await mkUser("owner@x.co");
    const attacker = await mkUser("attacker@x.co");
    const g = fakeGoogle({ token: okToken, channels: okChannel });
    await expect(completeOAuth(db, env, owner, ORIGIN, "c", "forged-state", g.f)).rejects.toThrow(
      /invalid/,
    );

    const { state } = await begin(owner);
    await expect(completeOAuth(db, env, attacker, ORIGIN, "c", state, g.f)).rejects.toThrow(
      /invalid/,
    );
    expect(g.calls).toHaveLength(0);

    const { state: s2 } = await begin(owner);
    await db
      .prepare("UPDATE oauth_states SET expires_at = 1 WHERE state_hash = ?")
      .bind(await sha256Hex(s2))
      .run();
    await expect(completeOAuth(db, env, owner, ORIGIN, "c", s2, g.f)).rejects.toThrow(/expired/);
    expect(g.calls).toHaveLength(0);
  });

  it("fails clearly on denied exchange, missing offline access, missing scopes, or no channel", async () => {
    const u = await mkUser("fail@x.co");
    const run = async (g: ReturnType<typeof fakeGoogle>) => {
      const { state } = await begin(u);
      return completeOAuth(db, env, u, ORIGIN, "c", state, g.f);
    };
    await expect(run(fakeGoogle({}))).rejects.toThrow(/did not accept/);
    await expect(
      run(
        fakeGoogle({
          token: () =>
            new Response(JSON.stringify({ access_token: "a", scope: ALL_SCOPES }), { status: 200 }),
        }),
      ),
    ).rejects.toThrow(/offline access/);
    await expect(
      run(
        fakeGoogle({
          token: () =>
            new Response(
              JSON.stringify({ access_token: "a", refresh_token: "r", scope: SCOPES[0] }),
              { status: 200 },
            ),
        }),
      ),
    ).rejects.toThrow(/permissions were not granted/);
    await expect(
      run(
        fakeGoogle({
          token: okToken,
          channels: () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
        }),
      ),
    ).rejects.toThrow(/no YouTube channel/);
    const none = await db
      .prepare("SELECT COUNT(*) AS n FROM youtube_accounts WHERE user_id = ?")
      .bind(u)
      .first<{ n: number }>();
    expect(none!.n).toBe(0);
  });
});

describe("using the connection", () => {
  async function connected(email: string) {
    const u = await mkUser(email);
    const { state } = await begin(u);
    await completeOAuth(
      db,
      env,
      u,
      ORIGIN,
      "c",
      state,
      fakeGoogle({ token: okToken, channels: okChannel }).f,
    );
    return u;
  }

  it("refreshes a short-lived access token from the stored (decrypted) refresh token", async () => {
    const u = await connected("use@x.co");
    const g = fakeGoogle({
      token: () => new Response(JSON.stringify({ access_token: "fresh-access" }), { status: 200 }),
    });
    const r = await getAccessToken(db, env, u, g.f);
    expect(r).toEqual({ accessToken: "fresh-access", channelId: "UC123" });
    const body = new URLSearchParams(g.calls[0]!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("1//refresh-secret");
  });

  it("explains revoked/expired access, and errors when not connected", async () => {
    const u = await connected("revoked@x.co");
    const g = fakeGoogle({
      token: () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });
    await expect(getAccessToken(db, env, u, g.f)).rejects.toThrow(/expired or was revoked/);
    const never = await mkUser("never@x.co");
    await expect(getAccessToken(db, env, never, g.f)).rejects.toThrow(/not connected/);
  });

  it("reads channel stats, handling hidden subscriber counts", async () => {
    const u = await connected("stats@x.co");
    const g = fakeGoogle({
      token: () => new Response(JSON.stringify({ access_token: "a" }), { status: 200 }),
      channels: () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "UC123",
                snippet: { title: "Tony AI" },
                statistics: { viewCount: "1500", videoCount: "7", hiddenSubscriberCount: true },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    expect(await fetchChannelStats(db, env, u, g.f)).toMatchObject({
      title: "Tony AI",
      subscribers: null,
      views: 1500,
      videos: 7,
    });
  });

  it("disconnect revokes at Google and deletes the stored token", async () => {
    const u = await connected("bye@x.co");
    const g = fakeGoogle({});
    await disconnect(db, env, u, g.f);
    const revoke = g.calls.find((c) => c.url.includes("/revoke"));
    expect(new URLSearchParams(revoke!.body).get("token")).toBe("1//refresh-secret");
    const row = await db
      .prepare("SELECT 1 FROM youtube_accounts WHERE user_id = ?")
      .bind(u)
      .first();
    expect(row).toBeNull();
    await disconnect(db, env, u, g.f); // idempotent
  });

  it("keeps each user's connection isolated", async () => {
    const a = await connected("iso-a@x.co");
    const b = await mkUser("iso-b@x.co");
    await expect(getAccessToken(db, env, b, fakeGoogle({}).f)).rejects.toThrow(/not connected/);
    expect(a).not.toBe(b);
  });
});
