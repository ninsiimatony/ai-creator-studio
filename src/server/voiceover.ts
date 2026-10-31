// Voiceover via ElevenLabs text-to-speech. Audio is streamed to the browser, not stored.
// Usage is logged (characters) and capped per day so a click can't burn through credits unnoticed.
import type { D1Database } from "./db";
import { AppError } from "./errors";
import { recordUsage } from "./ai";

export const MAX_CHARS_PER_PART = 4500;
export const DAILY_CHAR_CAP = 40_000;
export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

/** Splits narration into parts of at most `max` characters, preferring paragraph then sentence breaks. */
export function chunkNarration(text: string, max = MAX_CHARS_PER_PART): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const parts: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = "";
  };
  const units = clean
    .split(/\n{2,}/)
    .flatMap((para) =>
      para.length <= max ? [para] : (para.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [para]),
    );
  for (const u of units) {
    // A single sentence longer than the limit is hard-split as a last resort.
    const pieces = u.length > max ? (u.match(new RegExp(`.{1,${max}}`, "gs")) ?? [u]) : [u];
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > max) push();
      cur += (cur ? "\n\n" : "") + piece;
    }
  }
  push();
  return parts;
}

export async function voiceCharsToday(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(input_tokens), 0) AS n FROM ai_usage WHERE user_id = ? AND kind = 'voiceover' AND date(created_at) = date('now')",
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function synthesizePart(p: {
  db: D1Database;
  userId: string;
  apiKey: string | undefined;
  voiceId: string | undefined;
  modelId?: string | undefined;
  text: string;
  fetch?: typeof fetch;
}): Promise<{ audio: ArrayBuffer; chars: number }> {
  if (!p.apiKey)
    throw new AppError("Voiceover is not connected. Add the ELEVENLABS_API_KEY secret.");
  if (!p.voiceId)
    throw new AppError("Choose a voice: enter an ElevenLabs voice ID or set ELEVENLABS_VOICE_ID.");
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(p.voiceId)) throw new AppError("That voice ID looks invalid.");
  const chars = p.text.length;
  if (chars === 0) throw new AppError("There is no narration to voice.");
  if (chars > MAX_CHARS_PER_PART) throw new AppError("That part is too long for one request.");
  const used = await voiceCharsToday(p.db, p.userId);
  if (used + chars > DAILY_CHAR_CAP) {
    throw new AppError(
      `Daily voiceover limit reached (${used.toLocaleString()} of ${DAILY_CHAR_CAP.toLocaleString()} characters). Try again tomorrow (UTC).`,
    );
  }
  const f = p.fetch ?? fetch;
  const res = await f(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(p.voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": p.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: p.text, model_id: p.modelId || DEFAULT_MODEL_ID }),
    },
  );
  if (!res.ok) {
    console.error("elevenlabs error", res.status);
    if (res.status === 401)
      throw new AppError("The ElevenLabs API key was rejected. Check ELEVENLABS_API_KEY.");
    if (res.status === 404 || res.status === 422)
      throw new AppError("ElevenLabs could not use that voice or text. Check the voice ID.");
    if (res.status === 429)
      throw new AppError("ElevenLabs is rate limited or out of credits. Try again later.");
    throw new AppError(`The voiceover request failed (${res.status}). Please try again.`);
  }
  const audio = await res.arrayBuffer();
  if (audio.byteLength === 0) throw new AppError("ElevenLabs returned no audio.");
  await recordUsage(p.db, p.userId, "voiceover", "elevenlabs", chars, 0, 0);
  return { audio, chars };
}
