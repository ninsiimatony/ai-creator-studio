// Reliable "3 videos a day" scheduler. Cloudflare cron calls runCatchup every 15 minutes.
// For each of today's 3 slots (15:17, 20:17, 02:17 Oman = 11:17, 16:17, 22:17 UTC) it makes sure a video was
// made. If a slot was skipped, failed, or GitHub/network was down, it starts it again on the next tick.
import topics from "../../scripts/video-bot/topics.json";
import topics2 from "../../scripts/video-bot/topics2.json";
import topics3 from "../../scripts/video-bot/topics3.json";
import topics4 from "../../scripts/video-bot/topics4.json";
import { channelConnected } from "./google2";
import { dispatchVideoJob, sendTelegram } from "./bot";
import { pickTopic } from "./topicgen";
import { runWatchdog } from "./watchdog";
import type { D1Database, WorkerEnv } from "./db";

const REPO = "ninsiimatony/ai-creator-studio";
const REF = "main";
/** A different length each day (about +-25%), so videos never look cut from one template.
 *  Main channel 8-12 min, 3-story scary compilations 22-28 min, documentaries 9-14 min. Same day + slot always gives the same length. */
export function videoMinutes(slot: number, day: string): number {
  const [lo, hi] = slot === 3 ? [22, 28] : slot === 4 ? [9, 14] : slot === 5 || slot === 6 ? [10, 14] : [8, 12]; // slot 5 = Channel 4 (Night Tales Uganda), at least 10 minutes
  let h = 2166136261;
  for (const c of `${day}#${slot}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return lo + (h % (hi - lo + 1));
}

/** Days (UTC, 0 = Sunday) when channel 2 posts: Monday, Wednesday, Saturday. */
export const CH2_DAYS = [1, 3, 6];
const SLOT_MINUTES_UTC = [11 * 60 + 17, 16 * 60 + 17, 22 * 60 + 17, 23 * 60 + 17, 19 * 60 + 17, 1 * 60 + 30, 7 * 60 + 30]; // slots 5 and 6 = fourth channel (Night Tales Uganda, Luganda horror): start 05:30 and 11:30 Oman, ready about 06:00 and 12:00 Oman; slot 4 = third channel (wildlife, space and old-world documentaries): starts 23:17 Oman, live about 3:30 PM New York; // main channel starts 15:17, 20:17, 02:17 Oman (live ~7 AM, 12 PM, 6 PM New York); slot 3 = second channel: starts 03:17 Oman (6:17 PM New York), live about 7:20 PM New York
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
  await runWatchdog(env).catch((e) => console.log("watchdog:", String(e).slice(0, 100)));
  // Pause switch: app_notes 'pause_dispatch_until' = ISO time. Used when the free daily Workers AI allowance is
  // used up (it resets at 00:00 UTC), so videos are not started just to fail. No new videos start before that time.
  // Two separate pauses: channels 1-3 share one Cloudflare account, channel 4 has its own. One must never stop the other.
  const pauseUntil = (await db.prepare("SELECT value FROM app_notes WHERE key='pause_dispatch_until'").first<{ value: string }>().catch(() => null))?.value;
  const pause4Until = (await db.prepare("SELECT value FROM app_notes WHERE key='pause_dispatch_until_ch4'").first<{ value: string }>().catch(() => null))?.value;
  const mainPaused = !!pauseUntil && Date.now() < Date.parse(pauseUntil);
  const ch4Paused = !!pause4Until && Date.now() < Date.parse(pause4Until);
  if (mainPaused && ch4Paused) return `paused until ${pauseUntil}`;
  const notify = async (text: string) => {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text).catch(() => {});
  };

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const list = topics as string[];
  const runs = await fetchRuns(env.GITHUB_TOKEN);

  // Slots 0-2 = main channel, 3 = second channel, 4 = third channel (the last two only once they are connected).
  // Main channel makes 1 video a day (slot 2 = 22:17 UTC, about 6 PM New York). Slots 0 and 1 are switched off:
  // YouTube gives no bonus for posting more, and several AI stories a day looks like mass production (Nov 2026 upgrade).
  const slots = [2];
  // Channel 2 makes longer 3-story videos (~25 min) on 3 days a week only: Monday, Wednesday and Saturday (UTC).
  if (CH2_DAYS.includes(now.getUTCDay()) && (await channelConnected(db, 2))) slots.push(3);
  if (await channelConnected(db, 3)) slots.push(4);
  // Channel 4 (Night Tales Uganda, Luganda horror): 2 videos a day, ready at 6 AM and 12 PM Oman. Videos stay private until CH4_AUTO_PUBLISH=1 (Tony approves first).
  if (await channelConnected(db, 4)) slots.push(5, 6);
  for (const slot of slots) {
    if (minuteOfDay < SLOT_MINUTES_UTC[slot]!) continue; // slot not due yet
    if ((slot === 5 || slot === 6) ? ch4Paused : mainPaused) continue; // that account's free allowance is used up: skip only these slots
    const isCh2 = slot === 3;
    const isCh3 = slot === 4;
    const isCh4 = slot === 5 || slot === 6;
    const chan = isCh4 ? 4 : isCh3 ? 3 : isCh2 ? 2 : 1;
    const label = isCh4 ? "the fourth channel (Night Tales Uganda)" : isCh3 ? "the third channel" : isCh2 ? "the second channel" : `video ${slot + 1} of 3`;
    let topic = isCh4
      ? (topics4 as string[])[(dayOfYear(now) * 2 + (slot - 5)) % (topics4 as string[]).length]!
      : isCh3
      ? (topics3 as string[])[dayOfYear(now) % (topics3 as string[]).length]!
      : isCh2
      ? (topics2 as string[])[dayOfYear(now) % (topics2 as string[]).length]!
      : list[(dayOfYear(now) * 3 + slot) % list.length]!;
    const existing = await db.prepare("SELECT 1 AS x FROM video_slots WHERE day = ? AND slot = ?").bind(day, slot).first();
    if (!existing) topic = await pickTopic(db, topic, chan); // fresh topic first, built-in list as backup
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
      await notify(`⚠️ ${isCh4 ? "The fourth channel video" : isCh3 ? "The third channel video" : isCh2 ? "The second channel video" : `Video ${slot + 1} of today`} failed ${MAX_ATTEMPTS} times. Send me a topic here to make it by hand.`);
      continue;
    }

    // Claim the slot first (only one overlapping timer tick can win), so a video can never be started twice.
    const claim = await db
      .prepare("UPDATE video_slots SET status='dispatching', attempts=attempts+1, dispatched_at=? WHERE day=? AND slot=? AND attempts=? AND status=?")
      .bind(now.toISOString(), day, slot, row.attempts, row.status)
      .run();
    if (!(claim as { meta?: { changes?: number } }).meta?.changes) return `slot ${slot} is being handled by another run`;
    try {
      await dispatchVideoJob({
        token: env.GITHUB_TOKEN,
        repo: REPO,
        ref: REF,
        req: {
          topic: row.topic,
          minutes: videoMinutes(slot, day),
          style: "real", // channel 2 is realistic night photos since 2026-11-12 (was "cartoon")
          tone: isCh3 ? "wonder" : isCh2 || isCh4 ? "scary" : "emotional",
          ...(isCh4 ? { channel: 4 } : isCh3 ? { channel: 3 } : isCh2 ? { channel: 2 } : {}),
        },
      });
      await db.prepare("UPDATE video_slots SET status='dispatched' WHERE day=? AND slot=?").bind(day, slot).run();
      await notify(
        `🎬 Starting ${label}${row.attempts > 0 ? ` (retry ${row.attempts})` : ""}: ${row.topic}`,
      );
      return `dispatched slot ${slot}`;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await db.prepare("UPDATE video_slots SET status='pending', note=? WHERE day=? AND slot=?").bind(why.slice(0, 300), day, slot).run();
      if (row.attempts === 2) await notify(`⚠️ Video ${slot + 1} could not start: ${why}`);
      console.error("catch-up dispatch failed", e);
      return `dispatch failed slot ${slot}, will retry`;
    }
  }
  return "all caught up";
}
