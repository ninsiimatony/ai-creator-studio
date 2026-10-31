// Free AI media via Cloudflare Workers AI: images (FLUX-1-schnell) and speech (MeloTTS).
// Both are within Cloudflare's free daily allowance (10,000 neurons/day). We add our own daily caps so a
// click-happy session cannot exhaust it, and every call is logged in ai_usage.
import { AppError } from "./errors";
import type { AiBinding, D1Database } from "./db";
import { recordUsage } from "./ai";

export const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const TTS_MODEL = "@cf/myshell-ai/melotts";
/** ~43 neurons per image => 60 images is ~2,600 of the 10,000 free daily neurons. */
export const DAILY_IMAGE_CAP = 60;
export const DAILY_TTS_CHAR_CAP = 40_000;
export const MAX_TTS_CHARS = 2000;
export const MAX_IMAGE_PROMPT = 600;

async function usedToday(
  db: D1Database,
  userId: string,
  kind: string,
  column: "COUNT(*)" | "SUM(input_tokens)",
) {
  const row = await db
    .prepare(
      `SELECT COALESCE(${column}, 0) AS n FROM ai_usage WHERE user_id = ? AND kind = ? AND date(created_at) = date('now')`,
    )
    .bind(userId, kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
export const imagesToday = (db: D1Database, userId: string) =>
  usedToday(db, userId, "image", "COUNT(*)");
export const ttsCharsToday = (db: D1Database, userId: string) =>
  usedToday(db, userId, "tts", "SUM(input_tokens)");

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isJpeg = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b: Uint8Array) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isMp3 = (b: Uint8Array) =>
  b.length > 4 &&
  ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||
    (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0));

function friendly(e: unknown, what: string): AppError {
  console.error(`workers ai ${what} failed`, e);
  return new AppError(
    `Workers AI could not make the ${what}. The free daily allowance may be used up, or the service is busy. Try again later.`,
  );
}

export async function generateImage(p: {
  db: D1Database;
  userId: string;
  ai: AiBinding | undefined;
  prompt: string;
}): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!p.ai)
    throw new AppError("AI images are not available: the Workers AI binding is not configured.");
  const prompt = p.prompt.replace(/\s+/g, " ").trim();
  if (!prompt) throw new AppError("Describe the image first.");
  if (prompt.length > MAX_IMAGE_PROMPT)
    throw new AppError(`Keep the image description under ${MAX_IMAGE_PROMPT} characters.`);
  const used = await imagesToday(p.db, p.userId);
  if (used >= DAILY_IMAGE_CAP) {
    throw new AppError(
      `Daily AI image limit reached (${used} of ${DAILY_IMAGE_CAP}). It resets at midnight UTC.`,
    );
  }
  let res: unknown;
  try {
    res = await p.ai.run(IMAGE_MODEL, { prompt, steps: 4 });
  } catch (e) {
    throw friendly(e, "image");
  }
  const b64 = (res as { image?: unknown } | null)?.image;
  if (typeof b64 !== "string" || !b64)
    throw new AppError("Workers AI returned no image. Please try again.");
  const bytes = b64ToBytes(b64);
  const mime = isJpeg(bytes) ? "image/jpeg" : isPng(bytes) ? "image/png" : null;
  if (!mime)
    throw new AppError("Workers AI returned something that is not an image. Please try again.");
  await recordUsage(p.db, p.userId, "image", "flux-1-schnell", prompt.length, 0, 0);
  return { bytes, mime };
}

/** Normalises the several shapes Workers AI audio can come back in (base64 field, bytes, stream). */
async function audioBytes(res: unknown): Promise<Uint8Array | null> {
  if (res instanceof Uint8Array) return res;
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (typeof res === "string") return res.length ? b64ToBytes(res) : null;
  if (res && typeof (res as { arrayBuffer?: unknown }).arrayBuffer === "function") {
    return new Uint8Array(await (res as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
  }
  if (res && typeof res === "object") {
    const r = res as { audio?: unknown; body?: unknown };
    if (typeof r.audio === "string") return r.audio.length ? b64ToBytes(r.audio) : null;
    if (r.audio instanceof Uint8Array || r.audio instanceof ArrayBuffer) return audioBytes(r.audio);
    if (r.body && typeof (r.body as { getReader?: unknown }).getReader === "function") {
      return new Uint8Array(await new Response(r.body as ReadableStream).arrayBuffer());
    }
  }
  if (res && typeof (res as { getReader?: unknown }).getReader === "function") {
    return new Uint8Array(await new Response(res as ReadableStream).arrayBuffer());
  }
  return null;
}

export async function synthesizeSpeech(p: {
  db: D1Database;
  userId: string;
  ai: AiBinding | undefined;
  text: string;
  lang?: string;
}): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!p.ai)
    throw new AppError(
      "Free voiceover is not available: the Workers AI binding is not configured.",
    );
  const text = p.text.replace(/\s+/g, " ").trim();
  if (!text) throw new AppError("There is no text to speak.");
  if (text.length > MAX_TTS_CHARS)
    throw new AppError(`Keep each spoken scene under ${MAX_TTS_CHARS} characters.`);
  const lang = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(p.lang ?? "") ? (p.lang as string) : "en";
  const used = await ttsCharsToday(p.db, p.userId);
  if (used + text.length > DAILY_TTS_CHAR_CAP) {
    throw new AppError(
      `Daily free-voice limit reached (${used.toLocaleString()} of ${DAILY_TTS_CHAR_CAP.toLocaleString()} characters). It resets at midnight UTC.`,
    );
  }
  let res: unknown;
  try {
    res = await p.ai.run(TTS_MODEL, { prompt: text, lang });
  } catch (e) {
    throw friendly(e, "voiceover");
  }
  const bytes = await audioBytes(res).catch(() => null);
  if (!bytes || !isMp3(bytes))
    throw new AppError("Workers AI returned no usable audio. Please try again.");
  await recordUsage(p.db, p.userId, "tts", "melotts", text.length, 0, 0);
  return { bytes, mime: "audio/mpeg" };
}
