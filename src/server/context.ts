// Shared request plumbing for server functions: error masking, DB access, session check.
import { getCookie } from "@tanstack/react-start/server";
import { getEnv, type D1Database, type WorkerEnv } from "./db";
import { AppError } from "./errors";
import { SESSION_COOKIE, getSessionUser, type AuthUser } from "./auth";

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
