// Free long-form script writing with Cloudflare Workers AI (Llama), for the one-prompt video maker.
// The browser asks for an outline first, then each section one by one, so no single request is long.
import { AppError } from "./errors";
import type { AiBinding, D1Database } from "./db";
import { recordUsage } from "./ai";

export const SCRIPT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORDS_PER_SECTION = 350;
export const MAX_SECTIONS = 45;

type Msg = { role: "system" | "user"; content: string };

async function ask(ai: AiBinding, messages: Msg[], maxTokens: number): Promise<string> {
  let res: unknown;
  try {
    res = await ai.run(SCRIPT_MODEL, { messages, max_tokens: maxTokens, temperature: 0.7 });
  } catch (e) {
    console.error("workers ai script failed", e);
    throw new AppError(
      "The free AI writer is busy or today's free allowance is used up. Try again later.",
    );
  }
  const text = (res as { response?: unknown } | null)?.response;
  if (typeof text !== "string" || !text.trim())
    throw new AppError("The free AI writer returned nothing. Please try again.");
  return text.trim();
}

const SYSTEM =
  "You write narration for faceless YouTube documentary videos. Plain spoken English, short clear sentences, " +
  "vivid and accurate, no stage directions, no markdown, no emojis, no headings, never mention scenes or the camera.";

export function sectionCount(minutes: number): number {
  const words = Math.max(1, minutes) * 150;
  return Math.min(MAX_SECTIONS, Math.max(2, Math.ceil(words / WORDS_PER_SECTION)));
}

/** Parse "1. Heading" style lines into a clean list. */
export function parseOutline(text: string, want: number): { title: string; sections: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let title = "";
  const sections: string[] = [];
  for (const l of lines) {
    const t = l.match(/^title\s*[:\-]\s*(.+)$/i);
    if (t) {
      title = t[1]!.replace(/["*]/g, "").trim();
      continue;
    }
    const m = l.match(/^(?:\d+[.)]|[-*•])\s*(.+)$/);
    if (m) sections.push(m[1]!.replace(/\*+/g, "").trim());
  }
  return { title, sections: sections.slice(0, want) };
}

export async function writeOutline(p: {
  db: D1Database;
  userId: string;
  ai: AiBinding | undefined;
  topic: string;
  minutes: number;
}): Promise<{ title: string; sections: string[] }> {
  if (!p.ai) throw new AppError("The free AI writer is not available on this deployment.");
  const want = sectionCount(p.minutes);
  const text = await ask(
    p.ai,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `Plan a ${p.minutes}-minute YouTube video about: ${p.topic}\n\n` +
          `Reply with exactly this format and nothing else:\n` +
          `Title: <a catchy YouTube title>\n` +
          `1. <section heading>\n2. <section heading>\n... up to ${want}.\n\n` +
          `Write exactly ${want} sections that flow as one story: a strong hook first, a satisfying ending last.`,
      },
    ],
    Math.min(2000, 80 + want * 40),
  );
  const out = parseOutline(text, want);
  if (out.sections.length < 2) throw new AppError("The AI plan came back empty. Please try again.");
  await recordUsage(p.db, p.userId, "script", SCRIPT_MODEL, p.topic.length, text.length, 0);
  return { title: out.title || p.topic, sections: out.sections };
}

/** Split the AI reply into narration and the "VISUALS:" search terms line. */
export function parseSection(text: string): { narration: string; visuals: string[] } {
  const idx = text.search(/^\s*visuals?\s*:/im);
  const body = idx >= 0 ? text.slice(0, idx) : text;
  const vis = idx >= 0 ? text.slice(idx).replace(/^\s*visuals?\s*:/i, "") : "";
  const narration = body
    .replace(/^#+.*$/gm, "")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const visuals = vis
    .split(/[;,\n]/)
    .map((s) => s.replace(/[^a-zA-Z0-9 ]/g, "").trim())
    .filter((s) => s.length > 2)
    .slice(0, 12);
  return { narration, visuals };
}

export async function writeSection(p: {
  db: D1Database;
  userId: string;
  ai: AiBinding | undefined;
  topic: string;
  title: string;
  sections: string[];
  index: number;
  style: "real" | "cartoon";
}): Promise<{ narration: string; visuals: string[] }> {
  if (!p.ai) throw new AppError("The free AI writer is not available on this deployment.");
  const heading = p.sections[p.index] ?? p.topic;
  const first = p.index === 0;
  const last = p.index === p.sections.length - 1;
  const text = await ask(
    p.ai,
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `Video title: ${p.title}\nTopic: ${p.topic}\n` +
          `Full plan: ${p.sections.map((s, i) => `${i + 1}. ${s}`).join(" | ")}\n\n` +
          `Write ONLY section ${p.index + 1}: "${heading}". About ${WORDS_PER_SECTION} words of narration.` +
          (first ? " Open with a gripping hook in the first two sentences." : " Continue smoothly from the previous section; do not greet or re-introduce the video.") +
          (last ? " End with a memorable conclusion and ask viewers to subscribe." : " Do not conclude the video.") +
          `\n\nThen on a new last line write: VISUALS: followed by 8 short ${p.style === "cartoon" ? "animation or cartoon" : "stock video"} search terms (2-3 words each, concrete things that can be filmed, separated by semicolons).`,
      },
    ],
    900,
  );
  const out = parseSection(text);
  if (out.narration.length < 80) throw new AppError("The AI section came back too short. Please try again.");
  await recordUsage(p.db, p.userId, "script", SCRIPT_MODEL, heading.length, out.narration.length, 0);
  return out;
}
