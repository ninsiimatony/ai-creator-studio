import type { D1Database } from "./db";
import { AppError } from "./errors";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "./crypto";

export const SESSION_COOKIE = "tsid";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;

const now = () => Math.floor(Date.now() / 1000);

export type AuthUser = { id: string; email: string };

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Atomically creates the first (owner) account. Returns null if any user already exists. */
export async function createFirstUser(
  db: D1Database,
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  const res = await db
    .prepare(
      "INSERT INTO users (id, email, password_hash) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)",
    )
    .bind(id, email, hash)
    .run();
  if (!res.meta.changes) return null;
  await db.prepare("INSERT INTO settings (user_id) VALUES (?)").bind(id).run();
  return { id, email };
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(tokenHash, userId, now() + SESSION_TTL_SECONDS)
    .run();
  // Opportunistic cleanup of expired sessions and stale attempts.
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run();
  await db
    .prepare("DELETE FROM login_attempts WHERE at < ?")
    .bind(now() - ATTEMPT_WINDOW_SECONDS)
    .run();
  return token;
}

export async function getSessionUser(
  db: D1Database,
  token: string | undefined,
): Promise<AuthUser | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return db
    .prepare(
      `SELECT u.id AS id, u.email AS email FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, now())
    .first<AuthUser>();
}

export async function destroySession(db: D1Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .run();
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies credentials with a constant amount of work whether or not the account exists,
 * rate-limiting repeated failures per (email, client) pair.
 */
export async function authenticate(
  db: D1Database,
  email: string,
  password: string,
  clientId: string,
): Promise<AuthUser> {
  const key = await sha256Hex(`${email}|${clientId}`);
  const since = now() - ATTEMPT_WINDOW_SECONDS;
  const attempts = await db
    .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?")
    .bind(key, since)
    .first<{ n: number }>();
  if ((attempts?.n ?? 0) >= MAX_FAILED_ATTEMPTS) {
    throw new AppError("Too many failed attempts. Please try again in 15 minutes.");
  }

  const user = await db
    .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
    .bind(email)
    .first<AuthUser & { password_hash: string }>();

  dummyHash ??= hashPassword("not-a-real-password");
  const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash));

  if (!user || !ok) {
    await db.prepare("INSERT INTO login_attempts (key, at) VALUES (?, ?)").bind(key, now()).run();
    throw new AppError("Invalid email or password.");
  }
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
  return { id: user.id, email: user.email };
}
