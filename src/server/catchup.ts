// Reliable "3 videos a day" scheduler. Cloudflare cron calls runCatchup every 15 minutes.
// For each of today's 3 slots (07:17, 13:17, 19:17 Oman = 03:17, 09:17, 15:17 UTC) it makes sure a video was
// made. If a slot was skipped, failed, or GitHub/network was down, it starts it again on the next tick.
import topics from "../../scripts/video-bot/topics.json";
import topics2 from "../../scripts/video-bot/topics2.json";
import { channel2Connected } from "./google2";
import { dispatchVideoJob, sendTelegram } from "./bot";
import { pickTopic } from "./topicgen";
import type { D1Database, WorkerEnv } from "./db";

const REPO = "ninsiimatony/ai-creator-studio";
const REF = "main";
const SLOT_MINUTES_UTC = [3 * 60 + 17, 9 * 60 + 17, 15 * 60 + 17, 23 * 60 + 17]; // slot 3 = second channel: starts 03:17 Oman (6:17 PM New York), live about 7:20 PM New York
const MAX_ATTEMPTS = 4;
const LOST_AFTER_MS = 12 * 60 * 1000; // dispatched but GitHub never showed a run
const STUCK_AFTER_MS = 100 * 60 * 1000; // run still going far too long

type Row = { day: string; slot: number; topic: string; status: string; attempts: number; dispatched_at: string | null };
type Run = { display_title: string; status: string; conclusion: string | null; created_at: string };

async function ensureTable(db: D1Database) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS video_slots (day TEXT NOT NULL, slot INTEGER NOT NULL, topic TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, dispatched_at TEXT, PRIMARY KEY (day, slot))",
    )
    .run();
  await db.prepare("ALTER TABLE video_slots ADD COLUMN note TEXT").run().catch(() => {});
}

function dayOfYear(d: Date) {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}

async function fetchRuns(token: string): Promise<Run[] | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/video-bot.yml/runs?event=workflow_dispatch&per_page=40`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "tony-ai-youtube-studio",
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { workflow_runs?: Run[] };
    return json.workflow_runs ?? [];
  } catch {
    return null; // network problem: try again next tick
  }
}

export async function runCatchup(env: WorkerEnv): Promise<string> {
  const db = env.DB;
  if (!db || !env.GITHUB_TOKEN) return "not configured";
  await ensureTable(db);
  const notify = async (text: string) => {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text).catch(() => {});
  };

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const list = topics as string[];
  const runs = await fetchRuns(env.GITHUB_TOKEN);

  const slotCount = (await channel2Connected(db)) ? 4 : 3;
  for (let slot = 0; slot < slotCount; slot++) {
    if (minuteOfDay < SLOT_MINUTES_UTC[slot]) continue; // slot not due yet
    const isCh2 = slot === 3;
    const label = isCh2 ? "the second channel" : `video ${slot + 1} of 3`;
    let topic = isCh2
      ? (topics2 as string[])[dayOfYear(now) % (topics2 as string[]).length]
      : list[(dayOfYear(now) * 3 + slot) % list.length];
    const existing = await db.prepare("SELECT 1 AS x FROM video_slots WHERE day = ? AND slot = ?").bind(day, slot).first();
    if (!existing) topic = await pickTopic(db, topic, isCh2 ? 2 : 1); // fresh topic first, built-in list as backup
    await db
      .prepare("INSERT OR IGNORE INTO video_slots (day, slot, topic) VALUES (?, ?, ?)")
      .bind(day, slot, topic)
      .run();
    const row = await db
      .prepare("SELECT day, slot, topic, status, attempts, dispatched_at FROM video_slots WHERE day = ? AND slot = ?")
      .bind(day, slot)
      .first<Row>();
    if (!row || row.status === "done" || row.status === "gave_up") continue;

    if (row.status === "dispatched" && row.dispatched_at) {
      if (!runs) return "github unreachable, will retry"; // cannot tell; wait for next tick
      const since = new Date(row.dispatched_at).getTime() - 120000;
      const mine = runs
        .filter((r) => r.display_title === row.topic && new Date(r.created_at).getTime() >= since)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      const age = now.getTime() - new Date(row.dispatched_at).getTime();
      if (mine?.status === "completed" && mine.conclusion === "success") {
        await db.prepare("UPDATE video_slots SET status='done' WHERE day=? AND slot=?").bind(day, slot).run();
        continue;
      }
      if (mine && mine.status !== "completed" && age < STUCK_AFTER_MS) return `slot ${slot} running`;
      if (!mine && age < LOST_AFTER_MS) return `slot ${slot} starting`;
      // Wait longer after each failure (20, 40, 60 min) so a daily limit or outage has time to clear.
      if (mine?.status === "completed" && age < row.attempts * 20 * 60 * 1000) return `slot ${slot} waiting to retry`;
      // failed, cancelled, lost or stuck -> fall through and start it again
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await db.prepare("UPDATE video_slots SET status='gave_up' WHERE day=? AND slot=?").bind(day, slot).run();
      await notify(`⚠️ ${isCh2 ? "The second channel video" : `Video ${slot + 1} of today`} failed ${MAX_ATTEMPTS} times. Send me a topic here to make it by hand.`);
      continue;
    }

    try {
      await dispatchVideoJob({
        token: env.GITHUB_TOKEN,
        repo: REPO,
        ref: REF,
        req: { topic: row.topic, minutes: isCh2 ? 13 : 20, style: isCh2 ? "cartoon" : "real", tone: "emotional", channel: isCh2 ? 2 : undefined },
      });
      await db
        .prepare("UPDATE video_slots SET status='dispatched', attempts=attempts+1, dispatched_at=? WHERE day=? AND slot=?")
        .bind(now.toISOString(), day, slot)
        .run();
      await notify(
        `🎬 Starting ${label}${row.attempts > 0 ? ` (retry ${row.attempts})` : ""}: ${row.topic}`,
      );
      return `dispatched slot ${slot}`;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await db.prepare("UPDATE video_slots SET attempts=attempts+1, note=? WHERE day=? AND slot=?").bind(why.slice(0, 300), day, slot).run();
      if (row.attempts === 2) await notify(`⚠️ Video ${slot + 1} could not start: ${why}`);
      console.error("catch-up dispatch failed", e);
      return `dispatch failed slot ${slot}, will retry`;
    }
  }
  return "all caught up";
}
