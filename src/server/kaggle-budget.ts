// Weekly GPU-hour tracking for the optional Kaggle LTX-Video upgrade (scripts/video-bot/kaggle-ltx.mjs).
// Kaggle's free tier gives ~30 GPU hours/week per account; this keeps the automated video pipeline
// from quietly using up the whole budget and leaving nothing for manual testing in the Goblin Forge app.
import type { D1Database } from "./db";

export const WEEKLY_CAP_HOURS = 30;

async function ensureTable(db: D1Database) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS kaggle_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, channel INTEGER NOT NULL, hours REAL NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    )
    .run()
    .catch(() => {});
}

/** Sum of hours logged since the start of the current UTC week (Monday 00:00). */
export async function usedHoursThisWeek(db: D1Database): Promise<number> {
  await ensureTable(db);
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(hours), 0) AS h FROM kaggle_usage WHERE created_at >= datetime('now', 'weekday 1', '-7 days')",
    )
    .first<{ h: number }>();
  return row?.h ?? 0;
}

export async function recordKaggleUsage(
  db: D1Database,
  channel: number,
  hours: number,
  note: string,
) {
  await ensureTable(db);
  await db
    .prepare("INSERT INTO kaggle_usage (channel, hours, note) VALUES (?, ?, ?)")
    .bind(channel, Math.max(0, hours), note.slice(0, 300))
    .run();
}

export async function checkBudget(db: D1Database, needHours: number) {
  const used = await usedHoursThisWeek(db);
  const remainingHours = Math.max(0, WEEKLY_CAP_HOURS - used);
  return {
    allowed: needHours <= remainingHours,
    usedHours: used,
    remainingHours,
    capHours: WEEKLY_CAP_HOURS,
  };
}
