// Free long-form script writing with Cloudflare Workers AI (Llama), for the one-prompt video maker.
// The browser asks for an outline first, then each section one by one, so no single request is long.
import { AppError } from "./errors";
import type { AiBinding, D1Database } from "./db";
import { recordUsage } from "./ai";
import { TITLE_SIMILAR, bannedRules, embed, nearest, recentVecs, saveVec, trigramJaccard } from "./variety";

export const SCRIPT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORDS_PER_SECTION = 350;
export const MAX_SECTIONS = 45;

type Msg = { role: "system" | "user"; content: string };

type AskOpts = { temperature?: number; top_p?: number; presence_penalty?: number; frequency_penalty?: number; repetition_penalty?: number };

async function ask(ai: AiBinding, messages: Msg[], maxTokens: number, opts: AskOpts = {}): Promise<string> {
  let res: unknown;
  try {
    // A fresh random seed every call, so the same prompt never gives the same story twice.
    res = await ai.run(SCRIPT_MODEL, {
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      ...opts,
      seed: 1 + Math.floor(Math.random() * 999_999_999),
    });
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

export { ask as askAi };

const SYSTEM =
  "You write narration for faceless YouTube documentary videos. Plain spoken English, short clear sentences, " +
  "vivid and accurate, no stage directions, no markdown, no emojis, no headings, never mention scenes or the camera.";

const SYSTEM_EMOTIONAL =
  "You write narration for faceless YouTube videos that tell gripping, dramatic human stories about love, heartbreak, betrayal, cheating, family and fresh love (fiction). " +
  "Tell it like a gripping story told to a friend: plain spoken English, short sentences, strong emotion, real dialogue (use phrases like she said, he whispered), named characters, small vivid details, secrets, tension and at least one big twist or shock. " +
  "Every section must move the story forward and end on a hook that makes people need to hear what happens next. Never be slow, vague or preachy. " +
  "Use concrete local details of the story's setting (food, streets, customs, jobs) so each story feels like its own world. Every character wants something understandable; no cartoon villains. " +
  "Follow the ending the plan asks for (it is not always justice or a happy ending), with real emotion and a cohesive story, never shock for its own sake. " +
  bannedRules() + " " +
  "No explicit sexual content, no graphic violence, no medical or self-harm detail, no stage directions, no markdown, no emojis, no headings, never mention scenes or the camera.";

const SYSTEM_SCARY =
  "You write narration for a faceless YouTube channel of original scary cartoon stories for teens and adults, starring a small pale gray-green goblin keeper with huge yellow eyes who guards cursed doors, keys, cellars and haunted houses. " +
  "Tell it like a spooky campfire story: plain spoken English, short sentences, creeping dread, named characters, real dialogue (she whispered, it giggled), small creepy details, rising tension, and a big twist or shock. " +
  "Every section must move the story forward and end on a cliffhanger line. Never be slow, vague or preachy. Each section has one shiver moment and one moment of relief or humor. " +
  "Each episode is a new, different adventure in a new place; the goblin (his name is Grub) is the only character who returns. Follow the twist and ending the plan asks for. " +
  bannedRules() + " " +
  "Fully original: never copy or imitate any existing story, show or creator. No gore, no graphic violence, no sexual content, no self-harm, no real people, no stage directions, no markdown, no emojis, no headings, never mention scenes or the camera.";

export type Tone = "emotional" | "scary" | undefined;
const systemFor = (tone: Tone) => (tone === "emotional" ? SYSTEM_EMOTIONAL : tone === "scary" ? SYSTEM_SCARY : SYSTEM);

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
  tone?: Tone;
}): Promise<{ title: string; sections: string[] }> {
  if (!p.ai) throw new AppError("The free AI writer is not available on this deployment.");
  const want = sectionCount(p.minutes);
  // Channel memory: scary stories are channel 2, the rest channel 1.
  const channel = p.tone === "scary" ? 2 : 1;
  let avoid = "";
  let out = { title: "", sections: [] as string[] };
  let titleVec: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ask(
    p.ai,
    [
      { role: "system", content: systemFor(p.tone) },
      {
        role: "user",
        content:
          `Plan a ${p.minutes}-minute YouTube video ${p.tone === "emotional" ? "that tells one emotional, human story" : p.tone === "scary" ? "that tells one original scary cartoon story" : "about"}: ${p.topic}\n\n` +
          `Reply with exactly this format and nothing else:\n` +
          (p.tone === "scary"
            ? `Title: <a creepy, curiosity-driven title under 60 characters, Title Case, built from THIS story's own place and scary thing (not doors, keys or cellars unless the story is about them). Do not start with "The Goblin" or "Do Not">\n`
            : p.tone === "emotional"
            ? `Title: <a creative, emotional title under 60 characters, Title Case, about love, a relationship or heartbreak and the people in it, that makes people need to know what happens. Build it from THIS story's own people, place and secret. No clickbait words (Shocking, You Won't Believe, Abandoned, Mocked, Ignored) and never claim it is a true story>\n`
            : `Title: <a catchy YouTube title>\n`) +
          `1. <section heading>\n2. <section heading>\n... up to ${want}.\n\n` +
          `Write exactly ${want} sections that flow as one story: a strong hook first, a satisfying ending last. Each heading names a concrete event, and the story moves through different places.` + avoid,
      },
    ],
    Math.min(2000, 80 + want * 40),
      { temperature: 0.85, top_p: 0.92 },
    );
    out = parseOutline(text, want);
    if (out.sections.length < 2) continue;
    // Similarity gate on the title: never publish a title that looks like an earlier one.
    const vecs = await embed(p.ai, [out.title || p.topic]);
    titleVec = vecs?.[0] ?? null;
    if (!titleVec) break;
    const pool = await recentVecs(p.db, channel, "title", 300).catch(() => []);
    const near = nearest(titleVec, pool);
    const words = pool.some((x) => trigramJaccard(x.text, out.title) >= 0.4);
    if (near.score < TITLE_SIMILAR && !words) break;
    avoid = `\n\nThe title must NOT look like this earlier video: "${near.text || out.title}". Use different words and a different angle.`;
  }
  if (out.sections.length < 2) throw new AppError("The AI plan came back empty. Please try again.");
  if (titleVec) await saveVec(p.db, channel, "title", out.title || p.topic, titleVec).catch(() => {});
  await recordUsage(p.db, p.userId, "script", SCRIPT_MODEL, p.topic.length, 0, 0);
  return { title: out.title || p.topic, sections: out.sections };
}

/** One stock-footage search phrase per scene sentence, so the picture matches what the narration says. */
export async function writeSceneTerms(p: {
  db: D1Database;
  userId: string;
  ai: AiBinding | undefined;
  scenes: string[];
  style: "real" | "cartoon";
}): Promise<{ terms: string[] }> {
  if (!p.ai) throw new AppError("The free AI writer is not available on this deployment.");
  const list = p.scenes.map((s, i) => `${i + 1}. ${s.slice(0, 400)}`).join("\n");
  const text = await ask(
    p.ai,
    [
      {
        role: "system",
        content:
          "You are a film editor choosing stock footage. For each numbered scene of a narrated story, write ONE search phrase " +
          "of 2 to 4 words for a ${KIND} clip that shows what the narration describes: the people, what they are doing, and where. " +
          "Use only things a camera can film, and vary them: close-ups of hands and objects, wide shots of the place, people doing the action, calm metaphor shots " +
          "(for example: hands holding phone, market street evening, old man walking alone, ring box close up, rain window night, empty chair). Never use abstract words like betrayal, trust or love, " +
          "never repeat a phrase, and avoid the overused 'woman crying' and 'couple arguing'. " +
          "Reply with exactly one line per scene in the form '1: phrase' and nothing else.".replace(
            "${KIND}",
            p.style === "cartoon" ? "cartoon or animation" : "real stock video",
          ),
      },
      { role: "user", content: list },
    ],
    60 + p.scenes.length * 25,
  );
  const terms: string[] = p.scenes.map(() => "");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[:.)\-]\s*(.+)$/);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    const t = m[2]!.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
    if (i >= 0 && i < terms.length && t.length >= 3) terms[i] = t;
  }
  await recordUsage(p.db, p.userId, "script", SCRIPT_MODEL, list.length, text.length, 0);
  return { terms };
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
  tone?: Tone;
}): Promise<{ narration: string; visuals: string[] }> {
  if (!p.ai) throw new AppError("The free AI writer is not available on this deployment.");
  const heading = p.sections[p.index] ?? p.topic;
  const first = p.index === 0;
  const last = p.index === p.sections.length - 1;
  const text = await ask(
    p.ai,
    [
      { role: "system", content: systemFor(p.tone) },
      {
        role: "user",
        content:
          `Video title: ${p.title}\nTopic: ${p.topic}\n` +
          `Full plan: ${p.sections.map((s, i) => `${i + 1}. ${s}`).join(" | ")}\n\n` +
          `Write ONLY section ${p.index + 1}: "${heading}". About ${WORDS_PER_SECTION} words of narration.` +
          (first ? " The very first sentence must drop the listener into the most shocking or emotional moment of the story (the hook), then go back and explain how it happened. No greeting, no slow introduction, no scene-setting before the hook." : " Continue smoothly from the previous section; do not greet or re-introduce the video.") +
          (last
            ? p.tone === "scary"
              ? " End with a chilling twist, then ask the viewers one spooky question they can answer in the comments (for example: Would you have opened the door? What would you have done?), and finally ask them to subscribe for a new scary story every day."
              : p.tone === "emotional"
              ? " End with a touching conclusion, then ask the viewers one gentle personal question they can answer in the comments (for example: Would you have forgiven him? What would you have done in her place? Have you ever been betrayed by someone you loved?), and finally ask them to subscribe for a new story every day."
              : " End with a memorable conclusion and ask viewers to subscribe."
            : " Do not conclude the video.") +
          `\n\nThen on a new last line write: VISUALS: followed by 8 short ${p.style === "cartoon" ? "animation or cartoon" : "stock video"} search terms (2-3 words each, concrete things that can be filmed, separated by semicolons).` +
          (p.tone === "scary"
            ? " For visuals use eerie things from THIS section's own place and events that can be pictured (objects, rooms, weather, the guests' actions), each one different."
            : p.tone === "emotional"
            ? " For visuals write a shot list from THIS section's own setting and actions: mix close-ups of hands and objects, wide shots of the place (its streets, rooms, landscape, local food), people doing the action, and calm metaphor shots (empty chair, closing door, city traffic, rain). Avoid generic 'woman crying' or 'couple arguing'; every term must be different."
            : ""),
      },
    ],
    900,
    { temperature: 0.8, top_p: 0.9, frequency_penalty: 0.3 },
  );
  const out = parseSection(text);
  if (out.narration.length < 80) throw new AppError("The AI section came back too short. Please try again.");
  await recordUsage(p.db, p.userId, "script", SCRIPT_MODEL, heading.length, out.narration.length, 0);
  return out;
}

/** Pre-upload YouTube policy check. Advice only: never blocks a video. */
export async function writePolicyCheck(p: {
  ai: AiBinding | undefined;
  title: string;
  description: string;
  script: string;
}): Promise<{ risk: "low" | "medium" | "high"; issues: string[] }> {
  if (!p.ai) throw new AppError("The free AI writer is not available on this deployment.");
  const text = await ask(
    p.ai,
    [
      {
        role: "system",
        content:
          "You check a YouTube video's text against YouTube policies before upload. Look for: advertiser-unfriendly content " +
          "(sexual content, graphic violence, hate, harassment, self-harm, dangerous acts), child-safety problems, " +
          "misleading or clickbait titles that the story does not deliver, real people named in defamatory ways, " +
          "copyright problems, and spam-like text. The video is a fictional emotional story or a spooky cartoon horror story for teens and adults, so normal drama and mild scares are fine (but extreme gore, real violence, sexual or hateful content is not). " +
          "Reply in exactly this format and nothing else: first line 'RISK: low' or 'RISK: medium' or 'RISK: high'. " +
          "Then up to 4 lines, each starting with '- ', each one short plain problem. If there is no problem write '- none'.",
      },
      {
        role: "user",
        content: `TITLE: ${p.title.slice(0, 200)}\n\nDESCRIPTION: ${p.description.slice(0, 800)}\n\nSCRIPT:\n${p.script.slice(0, 6000)}`,
      },
    ],
    260,
  );
  const m = /RISK:\s*(low|medium|high)/i.exec(text);
  const risk = (m?.[1] ? m[1].toLowerCase() : "low") as "low" | "medium" | "high";
  const issues = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && !/^-\s*none/i.test(l))
    .map((l) => l.slice(2).slice(0, 200))
    .slice(0, 4);
  return { risk, issues };
}
