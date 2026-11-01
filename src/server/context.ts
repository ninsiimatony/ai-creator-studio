// Shared request plumbing for server functions: error masking, DB access, session check.
import { getCookie } from "@tanstack/react-start/server";
import { getEnv, type D1Database, type WorkerEnv } from "./db";
import { AppError } from "./errors";
import { SESSION_COOKIE, getSessionUser, type AuthUser } from "./auth";
import { safeEqualStrings } from "./crypto";

/** Runs a handler; known AppErrors reach the user, anything else is logged and masked. */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error("server function failed:", e);
    throw new AppError("Something went wrong. Please try again.");
  }
}

export async function requireDb(): Promise<{ db: D1Database; env: WorkerEnv }> {
  const env = await getEnv();
  if (!env.DB) throw new AppError("The database is not available in this environment.");
  return { db: env.DB, env };
}

export async function requireUser(): Promise<{ db: D1Database; user: AuthUser; env: WorkerEnv }> {
  const { db, env } = await requireDb();
  const user = await getSessionUser(db, getCookie(SESSION_COOKIE));
  if (!user) throw new AppError("Please sign in.");
  return { db, user, env };
}

/** True when the request carries the automation secret (used by the GitHub video job, never by browsers). */
export function hasBotBearer(request: Request): boolean {
  return !!request.headers.get("authorization")?.startsWith("Bearer ");
}

/** The owner session, or the GitHub job acting as the owner when it presents the AUTOMATION_SECRET. */
export async function requireUserOrBot(
  request: Request,
): Promise<{ db: D1Database; user: AuthUser; env: WorkerEnv }> {
  if (!hasBotBearer(request)) return requireUser();
  const { db, env } = await requireDb();
  const given = request.headers.get("authorization")!.slice(7);
  if (!env.AUTOMATION_SECRET || !safeEqualStrings(given, env.AUTOMATION_SECRET))
    throw new AppError("Please sign in.");
  const owner = await db
    .prepare("SELECT id, email FROM users ORDER BY created_at LIMIT 1")
    .first<AuthUser>();
  if (!owner) throw new AppError("No studio account exists yet.");
  return { db, user: owner, env };
}
