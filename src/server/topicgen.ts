// Fresh story topics: reads what people talk about online (Reddit, if reachable), then the free AI turns it into
// ORIGINAL fictional relationship-drama topics. Falls back to AI-only ideas. Never copies real people or posts.
import { askAi } from "./autoscript";
import type { D1Database, WorkerEnv } from "./db";

async function ensure(db: D1Database) {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS extra_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL UNIQUE, used INTEGER NOT NULL DEFAULT 0, created_at TEXT)")
    .run();
  await db.prepare("CREATE TABLE IF NOT EXISTS app_notes (key TEXT PRIMARY KEY, value TEXT)").run();
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
export async function pickTopic(db: D1Database, fallback: string): Promise<string> {
  try {
    await ensure(db);
    const row = await db.prepare("SELECT id, topic FROM extra_topics WHERE used=0 ORDER BY id LIMIT 1").first<{ id: number; topic: string }>();
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

/** Once a day: if fewer than 12 fresh topics are left, make 15 more. */
export async function refillTopics(env: WorkerEnv): Promise<string> {
  const db = env.DB;
  if (!db || !env.AI) return "not configured";
  await ensure(db);
  const today = new Date().toISOString().slice(0, 10);
  if ((await getNote(db, "topics_refill_day")) === today) return "already checked";
  const left = (await db.prepare("SELECT COUNT(*) AS n FROM extra_topics WHERE used=0").first<{ n: number }>())?.n ?? 0;
  await setNote(db, "topics_refill_day", today);
  if (left >= 12) return "enough topics";
  const titles = await redditTitles();
  const winning = await getNote(db, "winning_themes");
  const text = await askAi(
    env.AI,
    [
      {
        role: "system",
        content:
          "You invent story topics for a YouTube channel of emotional fictional relationship dramas (love, heartbreak, cheating, betrayal, " +
          "secrets, second chances). Write 15 ORIGINAL topics, one per line, each 12 to 25 words, a clear situation with a conflict and a twist " +
          "to come. Never copy a real post, never use real names or places of real people, no explicit content. Plain English. " +
          "Reply with only the 15 lines, no numbers.",
      },
      {
        role: "user",
        content:
          (titles.length ? `What people are talking about this week (for inspiration only):\n${titles.join("\n")}\n\n` : "") +
          (winning ? `Themes that did best on this channel (lean toward these): ${winning}\n` : ""),
      },
    ],
    1100,
  );
  let added = 0;
  for (const raw of text.split("\n")) {
    const t = raw.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim();
    if (t.length < 25 || t.length > 260) continue;
    const r = await db.prepare("INSERT OR IGNORE INTO extra_topics (topic, created_at) VALUES (?, ?)").bind(t, new Date().toISOString()).run();
    if ((r as { meta?: { changes?: number } }).meta?.changes) added++;
  }
  return `added ${added} topics (${titles.length ? "with" : "without"} internet ideas)`;
}
