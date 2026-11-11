// Fresh story topics: reads what people talk about online (Reddit, if reachable), then the free AI turns it into
// ORIGINAL fictional relationship-drama topics. Falls back to AI-only ideas. Never copies real people or posts.
import { askAi } from "./autoscript";
import { BANNED_NAMES, TOPIC_SIMILAR, bannedRules, dequantize, dnaLine, embed, nearest, recentVecs, sampleDna, saveDna, saveVec, type Dna } from "./variety";
import type { D1Database, WorkerEnv } from "./db";

async function ensure(db: D1Database) {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS extra_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL UNIQUE, used INTEGER NOT NULL DEFAULT 0, created_at TEXT)")
    .run();
  await db.prepare("CREATE TABLE IF NOT EXISTS app_notes (key TEXT PRIMARY KEY, value TEXT)").run();
  try {
    await db.prepare("ALTER TABLE extra_topics ADD COLUMN channel INTEGER NOT NULL DEFAULT 1").run();
  } catch {
    /* column already exists */
  }
}

export async function getNote(db: D1Database, key: string): Promise<string> {
  await ensure(db);
  return (await db.prepare("SELECT value FROM app_notes WHERE key=?").bind(key).first<{ value: string }>())?.value ?? "";
}
export async function setNote(db: D1Database, key: string, value: string) {
  await ensure(db);
  await db.prepare("INSERT INTO app_notes (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}

/** Next unused fresh topic, or the fallback from the built-in list. */
export async function pickTopic(db: D1Database, fallback: string, channel = 1): Promise<string> {
  try {
    await ensure(db);
    const row = await db.prepare("SELECT id, topic FROM extra_topics WHERE used=0 AND channel=? ORDER BY id LIMIT 1").bind(channel).first<{ id: number; topic: string }>();
    if (!row) return fallback;
    await db.prepare("UPDATE extra_topics SET used=1 WHERE id=?").bind(row.id).run();
    return row.topic;
  } catch {
    return fallback;
  }
}

async function redditTitles(): Promise<string[]> {
  const out: string[] = [];
  for (const sub of ["relationship_advice", "survivinginfidelity", "TrueOffMyChest"]) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/top.json?t=week&limit=8`, {
        headers: { "user-agent": "tony-ai-youtube-studio/1.0" },
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { data?: { children?: { data?: { title?: string } }[] } };
      for (const c of j.data?.children ?? []) if (c.data?.title) out.push(c.data.title.slice(0, 160));
    } catch {
      /* try the next one */
    }
  }
  return out.slice(0, 18);
}

/** Seed the memory with stories already made, once, so the gate also knows the past. */
async function backfillHistory(db: D1Database, ai: NonNullable<WorkerEnv["AI"]>, channel: number) {
  const key = `vec_backfill_${channel}`;
  if (await getNote(db, key)) return;
  await setNote(db, key, new Date().toISOString());
  let old: string[] = [];
  try {
    const a = ((await db.prepare("SELECT topic FROM video_slots WHERE " + (channel === 2 ? "slot = 3" : "slot < 3") + " ORDER BY day DESC LIMIT 90").all()) as { results?: { topic: string }[] }).results ?? [];
    const b = ((await db.prepare("SELECT topic FROM extra_topics WHERE channel=? ORDER BY id DESC LIMIT 60").bind(channel).all()) as { results?: { topic: string }[] }).results ?? [];
    old = [...new Set([...a, ...b].map((r) => r.topic))].slice(0, 120);
  } catch {
    old = [];
  }
  for (let i = 0; i < old.length; i += 40) {
    const part = old.slice(i, i + 40);
    const vecs = await embed(ai, part);
    if (!vecs) return;
    for (let k = 0; k < part.length; k++) await saveVec(db, channel, "topic", part[k]!, vecs[k]!);
  }
}

/**
 * Make `count` new, clearly different story topics for a channel:
 * roll a story DNA in code for each, let the AI write 2 ideas per DNA and say how "typical" each is,
 * keep the less typical one, then throw away anything too close to an earlier story.
 */
async function makeTopics(env: WorkerEnv, channel: number, count: number): Promise<string> {
  const db = env.DB!;
  const ai = env.AI!;
  await backfillHistory(db, ai, channel);
  const dnas: Dna[] = [];
  for (let i = 0; i < count; i++) dnas.push(await sampleDna(db, channel, dnas));
  let recent: string[] = [];
  try {
    recent = ((await db.prepare("SELECT text FROM story_vecs WHERE channel=? AND kind='topic' ORDER BY id DESC LIMIT 15").bind(channel).all()) as { results?: { text: string }[] }).results?.map((r) => r.text.slice(0, 140)) ?? [];
  } catch {
    recent = [];
  }
  const winning = channel === 1 ? await getNote(db, "winning_themes") : channel === 3 ? await getNote(db, "winning_themes_3") : "";
  const titles = channel === 1 ? await redditTitles() : [];
  const system =
    channel === 3
      ? "You invent episode ideas for a YouTube documentary channel about the wonders of nature, wildlife, the oceans, space, planet Earth and the old world. " +
        "Every idea is a TRUE, specific topic that can be explained in about 10 minutes and shown with free stock footage, NASA footage or old public-domain films. " +
        "Pick one specific animal, place, object or phenomenon (not a whole category), and do not promise facts you are not sure are real. No made-up statistics, no conspiracy theories, no real private people. "
      : channel === 2
      ? "You invent episode ideas for an ORIGINAL spooky cartoon story channel starring Grub, a small pale gray-green goblin keeper with huge yellow eyes. " +
        "Stories are scary but safe: fear comes from mystery, darkness, sounds and misunderstandings, and is beaten with courage, kindness or cleverness. " +
        "No gore, no death of children or pets, no weapons, no kidnapping, no real people, never copy an existing story. "
      : "You invent ORIGINAL fictional story premises for a YouTube channel of emotional human drama (love, family, secrets, second chances). " +
        "Every character wants something understandable; no cartoon villains, no revenge for its own sake, no explicit content, no real people, never copy a film, book or real post, never claim the story is true. "
  const text = await askAi(
    ai,
    [
      {
        role: "system",
        content:
          system +
          "You get numbered story DNA lines. For EACH DNA write 2 different premises that use every part of that DNA, and give each a probability (0 to 1) of how typical or predictable it is for this kind of story. " +
          (channel === 3
            ? "Each premise is one sentence of 14 to 30 words: the specific subject and the one question or surprising fact the episode will explain. Do not use any names that are not real. "
            : "Each premise is one sentence of 18 to 35 words: who, where, the conflict, and a hint of the twist (do not give the twist away). Use the names given. ") +
          bannedRules() +
          " Reply with exactly 2 lines per DNA in the form 'N | probability | premise' and nothing else.",
      },
      {
        role: "user",
        content:
          dnas.map((d, i) => `${i + 1}. ${dnaLine(channel, d)}`).join("\n") +
          (recent.length ? `\n\nStories already made (do NOT resemble these):\n${recent.join("\n")}` : "") +
          (titles.length ? `\n\nWhat people talk about this week (loose inspiration only, never copy):\n${titles.slice(0, 8).join("\n")}` : "") +
          (winning ? `\n\nThemes that did well (use as light inspiration for at most 2 of the ideas): ${winning}` : ""),
      },
    ],
    Math.min(2400, 140 + count * 150),
    { temperature: 1.0, top_p: 0.95, presence_penalty: 0.5 },
  );
  // Keep the least typical idea per DNA.
  const best = new Map<number, { p: number; t: string }>();
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*(\d+)\s*[|.)]\s*([01](?:\.\d+)?)\s*\|\s*(.+)$/);
    if (!m) continue;
    const n = Number(m[1]) - 1;
    const p = Number(m[2]);
    const t = m[3]!.replace(/^["']|["']$/g, "").trim();
    if (n < 0 || n >= dnas.length || t.length < (channel === 3 ? 25 : 40) || t.length > 260) continue;
    if (BANNED_NAMES.some((b) => new RegExp(`\\b${b}\\b`).test(t))) continue;
    const cur = best.get(n);
    if (!cur || p < cur.p) best.set(n, { p, t });
  }
  const cands = [...best.entries()];
  if (!cands.length) return "no usable ideas came back";
  const vecs = await embed(ai, cands.map(([, c]) => c.t));
  const history = vecs ? await recentVecs(db, channel, "topic") : [];
  const accepted: { text: string; vec: Int8Array }[] = [];
  let added = 0, rejected = 0;
  for (let k = 0; k < cands.length; k++) {
    const [n, c] = cands[k]!;
    if (vecs) {
      const near = nearest(vecs[k]!, [...history, ...accepted]);
      if (near.score >= TOPIC_SIMILAR) {
        rejected++;
        continue;
      }
    }
    const r = await db.prepare("INSERT OR IGNORE INTO extra_topics (topic, created_at, channel) VALUES (?, ?, ?)").bind(c.t, new Date().toISOString(), channel).run();
    if (!(r as { meta?: { changes?: number } }).meta?.changes) continue;
    added++;
    await saveDna(db, channel, dnas[n]!);
    if (vecs) {
      await saveVec(db, channel, "topic", c.t, vecs[k]!);
      accepted.push({ text: c.t, vec: dequantize(vecs[k]!) });
    }
  }
  return `added ${added} channel-${channel} topics (${rejected} thrown away as too similar)`;
}

/** Once a day: if fewer than 10 fresh topics are left, make 8 more. */
export async function refillTopics(env: WorkerEnv): Promise<string> {
  const db = env.DB;
  if (!db || !env.AI) return "not configured";
  await ensure(db);
  const today = new Date().toISOString().slice(0, 10);
  if ((await getNote(db, "topics_refill_day")) === today) return "already checked";
  const left = (await db.prepare("SELECT COUNT(*) AS n FROM extra_topics WHERE used=0 AND channel=1").first<{ n: number }>())?.n ?? 0;
  await setNote(db, "topics_refill_day", today);
  if (left >= 10) return "enough topics";
  return makeTopics(env, 1, 8);
}

/** Second channel (goblin stories): own topic pool, same variety rules. */
export async function refillTopics2(env: WorkerEnv): Promise<string> {
  const db = env.DB;
  if (!db || !env.AI) return "not configured";
  await ensure(db);
  const today = new Date().toISOString().slice(0, 10);
  if ((await getNote(db, "topics2_refill_day")) === today) return "already checked";
  const left = (await db.prepare("SELECT COUNT(*) AS n FROM extra_topics WHERE used=0 AND channel=2").first<{ n: number }>())?.n ?? 0;
  await setNote(db, "topics2_refill_day", today);
  if (left >= 5) return "enough topics";
  return makeTopics(env, 2, 6);
}

/** Third channel (wonder documentaries): own topic pool, same variety rules. */
export async function refillTopics3(env: WorkerEnv): Promise<string> {
  const db = env.DB;
  if (!db || !env.AI) return "not configured";
  await ensure(db);
  const today = new Date().toISOString().slice(0, 10);
  if ((await getNote(db, "topics3_refill_day")) === today) return "already checked";
  const left = (await db.prepare("SELECT COUNT(*) AS n FROM extra_topics WHERE used=0 AND channel=3").first<{ n: number }>())?.n ?? 0;
  await setNote(db, "topics3_refill_day", today);
  if (left >= 5) return "enough topics";
  return makeTopics(env, 3, 6);
}
