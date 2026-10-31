import { createServerFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  getRequest,
  getRequestHeader,
  setCookie,
} from "@tanstack/react-start/server";
import { z } from "zod";
import { getEnv, type D1Database } from "./db";
import { AppError } from "./errors";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  authenticate,
  countUsers,
  createFirstUser,
  createSession,
  destroySession,
  getSessionUser,
  type AuthUser,
} from "./auth";
import { safeEqualStrings } from "./crypto";
import * as repo from "./repo";
import { STAGE_KEYS, type SessionInfo, type Snapshot } from "@/lib/types";

// ---------- helpers ----------

/** Runs a handler; known AppErrors reach the user, anything else is logged and masked. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    console.error("server function failed:", e);
    throw new AppError("Something went wrong. Please try again.");
  }
}

async function requireDb(): Promise<{ db: D1Database; setupCode: string | undefined }> {
  const env = await getEnv();
  if (!env.DB) throw new AppError("The database is not available in this environment.");
  return { db: env.DB, setupCode: env.SETUP_CODE };
}

async function requireUser(): Promise<{ db: D1Database; user: AuthUser }> {
  const { db } = await requireDb();
  const user = await getSessionUser(db, getCookie(SESSION_COOKIE));
  if (!user) throw new AppError("Please sign in.");
  return { db, user };
}

function startSession(token: string) {
  const req = getRequest();
  const secure =
    new URL(req.url).protocol === "https:" || getRequestHeader("x-forwarded-proto") === "https";
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

const clientId = () => getRequestHeader("cf-connecting-ip") ?? "local";

// ---------- validators ----------

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, "Use at least 12 characters.").max(128);
const id = z.string().min(1).max(64);
const title = z.string().trim().min(1, "A title is required.").max(200);
const date = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "Use YYYY-MM-DD.");

// ---------- session / auth ----------

export const getSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionInfo> =>
    guard(async () => {
      const env = await getEnv();
      if (!env.DB) return { mode: "demo" };
      const user = await getSessionUser(env.DB, getCookie(SESSION_COOKIE));
      return {
        mode: "db",
        user: user ? { email: user.email } : null,
        setupOpen: !user && (await countUsers(env.DB)) === 0,
        setupConfigured: !!env.SETUP_CODE,
      };
    }),
);

export const setupAccount = createServerFn({ method: "POST" })
  .validator(z.object({ email, password, setupCode: z.string().min(1).max(200) }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, setupCode } = await requireDb();
      if (!setupCode) {
        throw new AppError("Account setup is disabled until a SETUP_CODE secret is configured.");
      }
      if (!safeEqualStrings(data.setupCode, setupCode)) throw new AppError("Invalid setup code.");
      const user = await createFirstUser(db, data.email, data.password);
      if (!user) throw new AppError("An account already exists. Please sign in.");
      startSession(await createSession(db, user.id));
      return { email: user.email };
    }),
  );

export const login = createServerFn({ method: "POST" })
  .validator(z.object({ email, password: z.string().min(1).max(128) }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db } = await requireDb();
      const user = await authenticate(db, data.email, data.password, clientId());
      startSession(await createSession(db, user.id));
      return { email: user.email };
    }),
  );

export const logout = createServerFn({ method: "POST" }).handler(async () =>
  guard(async () => {
    const { db } = await requireDb();
    await destroySession(db, getCookie(SESSION_COOKIE));
    deleteCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true as const };
  }),
);

// ---------- data ----------

export const loadData = createServerFn({ method: "GET" }).handler(async (): Promise<Snapshot> =>
  guard(async () => {
    const { db, user } = await requireUser();
    return repo.loadSnapshot(db, user.id);
  }),
);

export const addIdea = createServerFn({ method: "POST" })
  .validator(z.object({ title, topic: z.string().trim().min(1).max(60) }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      return repo.addIdea(db, user.id, data);
    }),
  );

export const setIdeaStatus = createServerFn({ method: "POST" })
  .validator(z.object({ id, status: z.enum(["new", "shortlisted", "rejected"]) }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      await repo.setIdeaStatus(db, user.id, data.id, data.status);
      return { ok: true as const };
    }),
  );

export const startScript = createServerFn({ method: "POST" })
  .validator(z.object({ ideaId: id }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      return repo.startScript(db, user.id, data.ideaId);
    }),
  );

export const updateScript = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id,
      title: title.optional(),
      hook: z.string().max(2_000).optional(),
      outline: z.string().max(20_000).optional(),
      body: z.string().max(200_000).optional(),
      cta: z.string().max(2_000).optional(),
    }),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      const { id: scriptId, ...patch } = data;
      await repo.updateScript(db, user.id, scriptId, patch);
      return { ok: true as const };
    }),
  );

export const createVideo = createServerFn({ method: "POST" })
  .validator(z.object({ title, scriptId: id.optional(), scheduled: date.optional() }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      return repo.createVideo(db, user.id, data);
    }),
  );

export const toggleStage = createServerFn({ method: "POST" })
  .validator(z.object({ id, stage: z.enum(STAGE_KEYS) }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      return repo.toggleStage(db, user.id, data.id, data.stage);
    }),
  );

export const setScheduled = createServerFn({ method: "POST" })
  .validator(z.object({ id, scheduled: date }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      await repo.setScheduled(db, user.id, data.id, data.scheduled);
      return { ok: true as const };
    }),
  );

export const submitVideo = createServerFn({ method: "POST" })
  .validator(z.object({ id }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      await repo.submitVideo(db, user.id, data.id);
      return { ok: true as const };
    }),
  );

export const decideVideo = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id,
      decision: z.enum(["approved", "changes"]),
      note: z.string().trim().max(2_000).default(""),
      confirmed: z.boolean().default(false),
    }),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      await repo.decideVideo(db, user.id, data.id, data.decision, data.note, data.confirmed);
      return { ok: true as const };
    }),
  );

export const returnVideo = createServerFn({ method: "POST" })
  .validator(z.object({ id }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      await repo.returnVideo(db, user.id, data.id);
      return { ok: true as const };
    }),
  );

export const saveSettings = createServerFn({ method: "POST" })
  .validator(
    z.object({
      audience: z.string().trim().min(1).max(200),
      format: z.string().trim().min(1).max(200),
      approvalRequired: z.boolean(),
      timezone: z.string().trim().min(1).max(64),
      budgetCap: z.number().min(0).max(1_000_000),
      currency: z.enum(["USD", "OMR", "EUR"]),
    }),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user } = await requireUser();
      await repo.saveSettings(db, user.id, data);
      return { ok: true as const };
    }),
  );

export const seedSampleData = createServerFn({ method: "POST" }).handler(async () =>
  guard(async () => {
    const { db, user } = await requireUser();
    await repo.seedSampleData(db, user.id);
    return repo.loadSnapshot(db, user.id);
  }),
);
