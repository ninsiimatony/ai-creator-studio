// Claude integration: metered, budget-capped, schema-validated generation.
// No result is ever fabricated: with no API key, or when the budget cap would be exceeded,
// the call fails with a clear message and nothing is generated.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
// The SDK's zodOutputFormat helper takes Zod v4 schemas; Zod 3.25 ships them under "zod/v4".
import { z as z4 } from "zod/v4";
import type { D1Database } from "./db";
import { AppError } from "./errors";

export const DEFAULT_WRITER_MODEL = "claude-sonnet-5-5";
export const DEFAULT_FAST_MODEL = "claude-haiku-5-5";

/** USD per million tokens (input, output). Source: Anthropic model pricing table. */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
};
// Unknown model => assume the most expensive known price, so the cap stays conservative.
const MAX_PRICE = { in: 4, out: 20 };

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? MAX_PRICE;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

export type AiKind = "ideas" | "script" | "metadata" | "thumbnails" | "storyboard";

// ---------- output schemas ----------
const TOPICS = ["AI technology", "AI tools", "Robotics", "Future"] as const;
export const ideasOut = z4.object({
  ideas: z4.array(z4.object({ title: z4.string(), topic: z4.enum(TOPICS), angle: z4.string() })),
});
export const scriptOut = z4.object({
  hook: z4.string(),
  outline: z4.string(),
  body: z4.string(),
  cta: z4.string(),
});
export const metadataOut = z4.object({
  titles: z4.array(z4.string()),
  description: z4.string(),
  tags: z4.array(z4.string()),
  seoNotes: z4.array(z4.string()),
});
export const thumbnailsOut = z4.object({
  concepts: z4.array(
    z4.object({
      headline: z4.string(),
      visual: z4.string(),
      colors: z4.string(),
      emotion: z4.string(),
    }),
  ),
});
export const storyboardOut = z4.object({
  scenes: z4.array(
    z4.object({
      narration: z4.string(),
      visual: z4.string(),
      keywords: z4.array(z4.string()),
      onScreenText: z4.string(),
      seconds: z4.number(),
    }),
  ),
});

// ---------- inputs ----------
export const ideasIn = z.object({
  topic: z.string().trim().max(120).optional(),
  count: z.number().int().min(1).max(8).default(5),
  avoid: z.array(z.string().max(200)).max(40).default([]),
});
export const scriptIn = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(2000).default(""),
  hook: z.string().max(2000).default(""),
  outline: z.string().max(20000).default(""),
  minutes: z.number().int().min(2).max(15).default(6),
});
export const metadataIn = z.object({
  title: z.string().trim().min(1).max(200),
  script: z.string().max(60000).default(""),
  description: z.string().max(5000).default(""),
  tags: z.array(z.string().max(60)).max(40).default([]),
});
export const thumbnailsIn = z.object({
  title: z.string().trim().min(1).max(200),
  hook: z.string().max(2000).default(""),
});
export const storyboardIn = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(20, "Write the narration first.").max(60000),
});

type Context = { audience: string; format: string };

const SYSTEM = (c: Context) =>
  `You help Tony run a YouTube channel about AI technology, AI tools, robotics and the future.
Audience: ${c.audience}. Format: ${c.format}.
Rules: be accurate and original. Never invent statistics, quotes, studies, sources, product features or news;
if you are not sure something is true, leave it out or phrase it as uncertain. You have no web access and
no knowledge of recent events, so do not claim to know current trends. Write for spoken narration where relevant.
Return only the requested structured data.`;

type Spec = {
  model: "writer" | "fast";
  effort: "low" | "medium";
  maxTokens: (i: never) => number;
  schema: z4.ZodType;
  prompt: (i: never, c: Context) => string;
};

const specs = {
  ideas: {
    model: "fast",
    effort: "low",
    maxTokens: () => 2500,
    schema: ideasOut,
    prompt: (i: z.infer<typeof ideasIn>) =>
      `Brainstorm ${i.count} original video ideas${i.topic ? ` about: ${i.topic}` : ""}.
For each: a compelling, honest title (max 90 characters, no clickbait lies), a topic (one of: ${TOPICS.join(", ")}),
and an angle (1-2 sentences on the story and why it will hold attention).
${i.avoid.length ? `Do not repeat these existing ideas:\n${i.avoid.map((t) => `- ${t}`).join("\n")}` : ""}
These are brainstorms, not trend data.`,
  },
  script: {
    model: "writer",
    effort: "medium",
    maxTokens: (i: z.infer<typeof scriptIn>) => Math.min(12000, i.minutes * 150 * 2 + 2000),
    schema: scriptOut,
    prompt: (i: z.infer<typeof scriptIn>) =>
      `Write a faceless documentary/explainer script titled "${i.title}" of about ${i.minutes} minutes (~${i.minutes * 150} words of narration).
Return: hook (1-2 sentences, the first 10 seconds), outline (numbered list of sections), body (the full spoken narration as plain
paragraphs, no scene directions, no timestamps, no headings), cta (a short call to action).
${i.notes ? `Notes from Tony: ${i.notes}` : ""}
${i.hook ? `Existing hook to build on: ${i.hook}` : ""}
${i.outline ? `Existing outline to follow:\n${i.outline}` : ""}`,
  },
  metadata: {
    model: "fast",
    effort: "low",
    maxTokens: () => 3000,
    schema: metadataOut,
    prompt: (i: z.infer<typeof metadataIn>) =>
      `Create YouTube metadata for the video "${i.title}".
Return: titles (5 distinct options, max 70 characters each, honest and searchable), description (max 4000 characters; the first two
lines must work as a hook before the "show more" fold; no invented timestamps or links), tags (up to 15, most relevant first), and
seoNotes (3-5 short, concrete suggestions).
${i.description || i.tags.length ? "Improve the existing metadata rather than starting over.\n" : ""}${i.description ? `Existing description:\n${i.description}\n` : ""}${i.tags.length ? `Existing tags: ${i.tags.join(", ")}\n` : ""}${i.script ? `Script excerpt:\n${i.script.slice(0, 6000)}` : ""}`,
  },
  thumbnails: {
    model: "fast",
    effort: "low",
    maxTokens: () => 1500,
    schema: thumbnailsOut,
    prompt: (i: z.infer<typeof thumbnailsIn>) =>
      `Propose 3 distinct thumbnail concepts for "${i.title}".${i.hook ? ` Hook: ${i.hook}` : ""}
Each: headline (max 4 words of on-image text), visual (what is shown, composition), colors, emotion. Concepts only; no images.`,
  },
  storyboard: {
    model: "writer",
    effort: "low",
    maxTokens: () => 8000,
    schema: storyboardOut,
    prompt: (i: z.infer<typeof storyboardIn>) =>
      `Turn this narration for "${i.title}" into a storyboard of at most 40 scenes for a faceless video made from stock footage,
motion graphics or generated imagery. Each scene: narration (the exact excerpt it covers), visual (what to show), keywords
(2-5 search terms for stock footage), onScreenText (short, or empty), seconds (estimated duration).
Narration:\n${i.body.slice(0, 24000)}`,
  },
} satisfies Record<AiKind, Spec>;

export const inputSchemas = {
  ideas: ideasIn,
  script: scriptIn,
  metadata: metadataIn,
  thumbnails: thumbnailsIn,
  storyboard: storyboardIn,
} as const;

export type AiResult<T> = {
  data: T;
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
};

export type AiDeps = {
  db: D1Database;
  userId: string;
  apiKey: string | undefined;
  capUsd: number;
  context: Context;
  models?: { writer?: string | undefined; fast?: string | undefined };
  /** Injected in tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
};

export async function spentTodayUsd(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_usage WHERE user_id = ? AND date(created_at) = date('now')",
    )
    .bind(userId)
    .first<{ s: number }>();
  return row?.s ?? 0;
}

export async function recordUsage(
  db: D1Database,
  userId: string,
  kind: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ai_usage (user_id, kind, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(userId, kind, model, inputTokens, outputTokens, cost)
    .run();
}

export async function runAi(
  deps: AiDeps,
  kind: AiKind,
  rawInput: unknown,
): Promise<AiResult<unknown>> {
  if (!deps.apiKey) {
    throw new AppError("AI is not connected. Add the ANTHROPIC_API_KEY secret to enable it.");
  }
  if (!(deps.capUsd > 0)) {
    throw new AppError("AI is off until you set a daily AI budget (USD) in Settings.");
  }
  const spec = specs[kind] as unknown as Spec;
  const input = inputSchemas[kind].parse(rawInput);
  const model =
    (spec.model === "writer" ? deps.models?.writer : deps.models?.fast) ||
    (spec.model === "writer" ? DEFAULT_WRITER_MODEL : DEFAULT_FAST_MODEL);

  const prompt = spec.prompt(input as never, deps.context);
  const system = SYSTEM(deps.context);
  const maxTokens = spec.maxTokens(input as never);

  // Enforce the cap against the worst case of this call, not just what is already spent.
  const worstCase = costUsd(model, Math.ceil((prompt.length + system.length) / 3) + 200, maxTokens);
  const spent = await spentTodayUsd(deps.db, deps.userId);
  if (spent + worstCase > deps.capUsd) {
    throw new AppError(
      `Daily AI budget reached: $${spent.toFixed(3)} spent of $${deps.capUsd.toFixed(2)}, and this request could cost up to $${worstCase.toFixed(3)}. Raise the cap in Settings or try again tomorrow (UTC).`,
    );
  }

  const client = new Anthropic({
    apiKey: deps.apiKey,
    maxRetries: 1,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  let res;
  try {
    res = await client.messages.parse({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: zodOutputFormat(spec.schema), effort: spec.effort },
    } as never);
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      console.error("anthropic error", e.status, e.message);
      if (e.status === 401)
        throw new AppError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.");
      if (e.status === 429)
        throw new AppError("Claude is rate limited right now. Try again in a minute.");
      if (/credit balance/i.test(e.message)) {
        throw new AppError(
          "The Anthropic account has no credit left. Add credit in the Anthropic Console.",
        );
      }
      throw new AppError(`The AI request failed (${e.status ?? "network"}). Please try again.`);
    }
    throw e;
  }

  const inTok = res.usage.input_tokens;
  const outTok = res.usage.output_tokens;
  const cost = costUsd(model, inTok, outTok);
  // Bill what the API reports even if the output is unusable.
  await recordUsage(deps.db, deps.userId, kind, model, inTok, outTok, cost);

  if (res.stop_reason === "refusal") {
    throw new AppError("Claude declined this request. Try rephrasing the topic.");
  }
  if (res.stop_reason === "max_tokens") {
    throw new AppError("The response was cut off. Try a shorter length and run it again.");
  }
  const parsed = (res as { parsed_output?: unknown }).parsed_output;
  if (parsed == null)
    throw new AppError("The AI response could not be understood. Please try again.");

  return {
    data: parsed,
    usage: { model, inputTokens: inTok, outputTokens: outTok, costUsd: cost },
  };
}
