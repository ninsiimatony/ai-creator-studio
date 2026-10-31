import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { guard, requireUser } from "@/server/context";
import type { D1Database, WorkerEnv } from "@/server/db";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_WRITER_MODEL,
  runAi,
  spentTodayUsd,
  type AiDeps,
  type AiKind,
} from "@/server/ai";
import * as repo from "@/server/repo";
import { DAILY_CHAR_CAP, chunkNarration, voiceCharsToday } from "@/server/voiceover";
import type { Idea, Scene } from "@/lib/types";

const id = z.string().min(1).max(64);

export type IntegrationStatus = {
  ai: {
    configured: boolean;
    capUsd: number;
    spentUsd: number;
    writerModel: string;
    fastModel: string;
  };
  youtube: {
    configured: boolean;
    connected: boolean;
    channelTitle?: string | undefined;
    channelId?: string | undefined;
  };
  voiceover: { configured: boolean };
};

async function aiDeps(db: D1Database, env: WorkerEnv, userId: string): Promise<AiDeps> {
  const settings = await repo.getSettingsFor(db, userId);
  return {
    db,
    userId,
    apiKey: env.ANTHROPIC_API_KEY,
    capUsd: settings.aiDailyCapUsd,
    context: { audience: settings.audience, format: settings.format },
    models: { writer: env.AI_MODEL_WRITER, fast: env.AI_MODEL_FAST },
  };
}

async function generate<T>(
  db: D1Database,
  env: WorkerEnv,
  userId: string,
  kind: AiKind,
  input: unknown,
) {
  const out = await runAi(await aiDeps(db, env, userId), kind, input);
  return { data: out.data as T, usage: out.usage };
}

/** Which integrations are configured, and today's AI spend. Never exposes any secret. */
export const getIntegrations = createServerFn({ method: "GET" }).handler(
  async (): Promise<IntegrationStatus> =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      const settings = await repo.getSettingsFor(db, user.id);
      const yt = await db
        .prepare("SELECT channel_id, channel_title FROM youtube_accounts WHERE user_id = ?")
        .bind(user.id)
        .first<{ channel_id: string; channel_title: string }>();
      return {
        ai: {
          configured: !!env.ANTHROPIC_API_KEY,
          capUsd: settings.aiDailyCapUsd,
          spentUsd: await spentTodayUsd(db, user.id),
          writerModel: env.AI_MODEL_WRITER || DEFAULT_WRITER_MODEL,
          fastModel: env.AI_MODEL_FAST || DEFAULT_FAST_MODEL,
        },
        youtube: {
          configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENC_KEY),
          connected: !!yt,
          channelTitle: yt?.channel_title,
          channelId: yt?.channel_id,
        },
        voiceover: { configured: !!env.ELEVENLABS_API_KEY },
      };
    }),
);

/** Brainstorm ideas with Claude and save them to the queue (score stays 0: there is no trend data). */
export const aiIdeas = createServerFn({ method: "POST" })
  .validator(
    z.object({
      topic: z.string().trim().max(120).optional(),
      count: z.number().int().min(1).max(8),
    }),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      const snap = await repo.loadSnapshot(db, user.id);
      const out = await generate<{ ideas: { title: string; topic: string; angle: string }[] }>(
        db,
        env,
        user.id,
        "ideas",
        {
          topic: data.topic,
          count: data.count,
          avoid: snap.ideas.slice(0, 40).map((i) => i.title),
        },
      );
      const ideas: Idea[] = await repo.addIdeasBulk(db, user.id, out.data.ideas);
      return { ideas, usage: out.usage };
    }),
  );

export type ScriptDraft = { hook: string; outline: string; body: string; cta: string };

/** Drafts a script. Nothing is saved: the user reviews it and applies it explicitly. */
export const aiScriptDraft = createServerFn({ method: "POST" })
  .validator(
    z.object({
      scriptId: id,
      minutes: z.number().int().min(2).max(15),
      notes: z.string().max(2000).default(""),
    }),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      const s = await repo.getScript(db, user.id, data.scriptId);
      return generate<ScriptDraft>(db, env, user.id, "script", {
        title: s.title,
        notes: data.notes,
        hook: s.hook,
        outline: s.outline,
        minutes: data.minutes,
      });
    }),
  );

export type MetadataSuggestion = {
  titles: string[];
  description: string;
  tags: string[];
  seoNotes: string[];
};

export const aiMetadata = createServerFn({ method: "POST" })
  .validator(z.object({ videoId: id }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      const { video, scriptBody } = await repo.getVideoWithScript(db, user.id, data.videoId);
      return generate<MetadataSuggestion>(db, env, user.id, "metadata", {
        title: video.title,
        script: scriptBody,
        description: video.description,
        tags: video.tags,
      });
    }),
  );

export type ThumbnailConcepts = {
  concepts: { headline: string; visual: string; colors: string; emotion: string }[];
};

export const aiThumbnails = createServerFn({ method: "POST" })
  .validator(z.object({ videoId: id }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      const { video, scriptHook } = await repo.getVideoWithScript(db, user.id, data.videoId);
      return generate<ThumbnailConcepts>(db, env, user.id, "thumbnails", {
        title: video.title,
        hook: scriptHook,
      });
    }),
  );

export const aiStoryboard = createServerFn({ method: "POST" })
  .validator(z.object({ scriptId: id }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      const s = await repo.getScript(db, user.id, data.scriptId);
      if (!s.body.trim()) throw new AppError("Write or generate the narration first.");
      const out = await generate<{ scenes: Scene[] }>(db, env, user.id, "storyboard", {
        title: s.title,
        body: s.body,
      });
      await repo.setStoryboard(db, user.id, s.id, out.data.scenes);
      return { scenes: out.data.scenes, usage: out.usage };
    }),
  );

export type VoiceoverPlan = { chars: number; parts: number; usedToday: number; dailyCap: number };

/** How a script's narration would be split for voiceover, and today's character usage. */
export const getVoiceoverPlan = createServerFn({ method: "POST" })
  .validator(z.object({ scriptId: id }))
  .handler(async ({ data }): Promise<VoiceoverPlan> =>
    guard(async () => {
      const { db, user } = await requireUser();
      const s = await repo.getScript(db, user.id, data.scriptId);
      return {
        chars: s.body.trim().length,
        parts: chunkNarration(s.body).length,
        usedToday: await voiceCharsToday(db, user.id),
        dailyCap: DAILY_CHAR_CAP,
      };
    }),
  );
