// Connection watchdog: checks that both YouTube channels are still connected.
// All 3 Google apps are "In production" since 2026-11-12, so connections no longer expire after 7 days.
// This now only tells Tony the moment a connection really breaks, with a one-tap reconnect link.
import type { D1Database, WorkerEnv } from "./db";
import { getAccessToken } from "./google";
import { getAccessToken2 } from "./google2";
import { sendTelegram } from "./bot";

const STUDIO = "https://youtube-automation-platform.ninsiimatony.workers.dev";
const HOUR = 3600 * 1000;

async function note(db: D1Database, key: string, value?: string): Promise<string> {
  await db.prepare("CREATE TABLE IF NOT EXISTS app_notes (key TEXT PRIMARY KEY, value TEXT)").run();
  if (value === undefined) return (await db.prepare("SELECT value FROM app_notes WHERE key=?").bind(key).first<{ value: string }>())?.value ?? "";
  await db.prepare("INSERT INTO app_notes (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
  return value;
}

export async function runWatchdog(env: WorkerEnv): Promise<string> {
  const db = env.DB;
  if (!db || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return "watchdog off";
  const say = (t: string) => sendTelegram(env.TELEGRAM_BOT_TOKEN!, env.TELEGRAM_CHAT_ID!, t).catch(() => {});
  const now = Date.now();
  // Look at most once an hour.
  if (now - Number((await note(db, "wd_last_run")) || 0) < HOUR) return "watchdog skip";
  await note(db, "wd_last_run", String(now));

  const channels = [
    { n: 1, name: "Tony AI (main channel)", link: `${STUDIO}/api/auth/google1/start`, sql: "SELECT user_id AS uid, connected_at FROM youtube_accounts LIMIT 1" },
    { n: 2, name: "Little Hope Tales", link: `${STUDIO}/api/auth/google2/start`, sql: "SELECT '' AS uid, connected_at FROM extra_channels WHERE slot = 2" },
    { n: 3, name: "Channel 3 (wonders of nature and space)", link: `${STUDIO}/api/auth/google3/start`, sql: "SELECT '' AS uid, connected_at FROM extra_channels WHERE slot = 3" },
  ];
  const out: string[] = [];
  for (const c of channels) {
    const row = await db.prepare(c.sql).first<{ uid: string; connected_at: string }>().catch(() => null);
    if (!row) { if (c.n !== 3) out.push(`${c.n}: not connected`); continue; }
    let ok = true;
    try {
      if (c.n === 1) await getAccessToken(db, env as any, row.uid);
      else await getAccessToken2(db, env as any, fetch, c.n === 3 ? 3 : 2);
    } catch { ok = false; }
    const flag = `wd_alert_${c.n}`;
    if (!ok) {
      if (now - Number((await note(db, flag)) || 0) > 6 * HOUR) {
        await note(db, flag, String(now));
        await say(`🔴 ${c.name} is DISCONNECTED from YouTube. Videos cannot upload until you reconnect.\n\nTap this link, then tap Connect with Google and Allow:\n${c.link}`);
      }
      out.push(`${c.n}: DOWN`);
    } else {
      const ageDays = (now - new Date(row.connected_at.replace(" ", "T") + "Z").getTime()) / (24 * HOUR);
      // (The old "will disconnect after 7 days" warning was removed: the apps are in production now.)
      out.push(`${c.n}: ok (${ageDays.toFixed(1)}d)`);
    }
  }
  // Daily health report (about 09:00 Oman): what was made, what failed, how many story ideas are left.
  try {
    const today = new Date(now).toISOString().slice(0, 10);
    if (new Date(now).getUTCHours() >= 5 && (await note(db, "wd_report_day")) !== today) {
      await note(db, "wd_report_day", today);
      const since = new Date(now - 24 * HOUR).toISOString().slice(0, 10);
      const rows = ((await db.prepare("SELECT day, slot, status, attempts, note FROM video_slots WHERE day >= ? ORDER BY day, slot").bind(since).all()) as { results?: { day: string; slot: number; status: string; attempts: number; note: string | null }[] }).results ?? [];
      const mark = (s: string) => (s === "done" ? "✅" : s === "gave_up" ? "🔴" : "⏳");
      const lines = rows.map((r) => `${mark(r.status)} ${r.day} ${r.slot === 4 ? "Channel 3" : r.slot === 3 ? "Little Hope Tales" : "Tony Ninsiima"}: ${r.status}${r.attempts > 1 ? ` (${r.attempts} tries)` : ""}${r.status !== "done" && r.note ? " - " + r.note.slice(0, 80) : ""}`);
      const left = ((await db.prepare("SELECT channel, COUNT(*) AS n FROM extra_topics WHERE used=0 GROUP BY channel").all()) as { results?: { channel: number; n: number }[] }).results ?? [];
      const ideas = left.map((l) => `channel ${l.channel}: ${l.n}`).join(", ") || "none (using the built-in list)";
      await say(`📋 Daily health report\nConnections: ${out.join(", ")}\nLast videos:\n${lines.join("\n") || "none yet"}\nStory ideas left: ${ideas}`);
    }
  } catch (e) {
    console.log("health report:", String(e).slice(0, 100));
  }
  return "watchdog " + out.join(", ");
}
