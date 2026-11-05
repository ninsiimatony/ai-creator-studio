// Weekly growth report from REAL YouTube Analytics numbers, with short coaching tips. Sent to Telegram.
import { askAi } from "./autoscript";
import { sendTelegram } from "./bot";
import type { WorkerEnv } from "./db";
import { getAccessToken } from "./google";
import { setNote } from "./topicgen";

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

type Table = { columnHeaders?: { name: string }[]; rows?: (string | number)[][] };

async function report(token: string, params: Record<string, string>): Promise<Table> {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`YouTube Analytics said ${res.status}`);
  return (await res.json()) as Table;
}

async function totals(token: string, start: Date, end: Date) {
  const t = await report(token, {
    startDate: day(start),
    endDate: day(end),
    metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,likes,comments",
  });
  const r = (t.rows?.[0] ?? [0, 0, 0, 0, 0, 0]).map(Number);
  return { views: r[0], minutes: r[1], avgSeconds: r[2], subs: r[3], likes: r[4], comments: r[5] };
}

const change = (now: number, before: number) =>
  before === 0 ? (now === 0 ? "same" : "new") : `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%`;

export async function runWeeklyReport(env: WorkerEnv, force = false): Promise<string> {
  const db = env.DB;
  if (!db || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return "not configured";
  await db.prepare("CREATE TABLE IF NOT EXISTS weekly_reports (week TEXT PRIMARY KEY, sent_at TEXT)").run();
  const now = new Date();
  const week = day(addDays(now, -((now.getUTCDay() + 6) % 7))); // Monday of this week
  if (!force) {
    if (now.getUTCDay() !== 0 || now.getUTCHours() < 5) return "not report time";
    if (await db.prepare("SELECT week FROM weekly_reports WHERE week=?").bind(week).first()) return "already sent";
  }
  const send = (t: string) => sendTelegram(env.TELEGRAM_BOT_TOKEN!, env.TELEGRAM_CHAT_ID!, t);
  try {
    const owner = await db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").first<{ id: string }>();
    if (!owner) return "no account";
    const { accessToken } = await getAccessToken(db, env, owner.id, fetch);
    const end = addDays(now, -1);
    const start = addDays(end, -6);
    const cur = await totals(accessToken, start, end);
    const prev = await totals(accessToken, addDays(start, -7), addDays(start, -1));
    const top = await report(accessToken, {
      startDate: day(start),
      endDate: day(end),
      dimensions: "video",
      metrics: "views,averageViewPercentage,subscribersGained",
      sort: "-views",
      maxResults: "5",
    });
    const ids = (top.rows ?? []).map((r) => String(r[0]));
    const titles: Record<string, string> = {};
    if (ids.length) {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.join(",")}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (res.ok) {
        const j = (await res.json()) as { items?: { id: string; snippet: { title: string } }[] };
        for (const it of j.items ?? []) titles[it.id] = it.snippet.title;
      }
    }
    const topLines = (top.rows ?? []).map(
      (r, i) => `${i + 1}. ${(titles[String(r[0])] ?? "video").slice(0, 60)} - ${r[1]} views, watched ${Math.round(Number(r[2]))}%, +${r[3]} subs`,
    );
    const facts =
      `Last 7 days (${day(start)} to ${day(end)}): ${cur.views} views (${change(cur.views, prev.views)} vs week before), ` +
      `${Math.round(cur.minutes)} watch minutes (${change(cur.minutes, prev.minutes)}), average view ${Math.round(cur.avgSeconds)} seconds, ` +
      `${cur.subs} new subscribers (${change(cur.subs, prev.subs)}), ${cur.likes} likes, ${cur.comments} comments.\nTop videos:\n${topLines.join("\n") || "none yet"}`;
    let tips = "";
    try {
      tips = await askAi(
        env.AI!,
        [
          {
            role: "system",
            content:
              "You are a YouTube growth coach for a faceless emotional-story channel. Use ONLY the numbers given; never invent numbers. " +
              "Give exactly 3 short tips (one line each, simple words, start with '- ') based on what the numbers show " +
              "(for example which video worked best and why to copy it, or low watch percentage meaning a stronger first 30 seconds is needed). " +
              "If views are very small, say honestly that the channel is still new and what to keep doing.",
          },
          { role: "user", content: facts },
        ],
        220,
      );
    } catch {
      tips = "";
    }
    let themeLine = "";
    if ((top.rows ?? []).length && cur.views > 0) {
      try {
        const th = await askAi(
          env.AI!,
          [
            {
              role: "system",
              content:
                "Below are the best videos of an emotional-story channel with their views. In ONE line of at most 25 words, name the story themes " +
                "that did best (example: cheating husband, secret child, family betrayal). Reply with only that line.",
            },
            { role: "user", content: topLines.join("\n") },
          ],
          80,
        );
        const line = th.split("\n")[0].slice(0, 220);
        await setNote(db, "winning_themes", line);
        themeLine = `\n\n🎯 Best themes (next stories will lean toward these): ${line}`;
      } catch {
        /* skip */
      }
    }
    await send(`📈 Weekly report\n\n${facts}\n\n${tips ? `💡 Tips\n${tips}` : ""}${themeLine}`.slice(0, 3900));
    if (!force) await db.prepare("INSERT OR IGNORE INTO weekly_reports (week, sent_at) VALUES (?, ?)").bind(week, now.toISOString()).run();
    return "sent";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!force) await db.prepare("INSERT OR IGNORE INTO weekly_reports (week, sent_at) VALUES (?, ?)").bind(week, now.toISOString()).run();
    await send(`📈 Weekly report could not be made: ${msg.slice(0, 200)}\nIf it says access expired, reconnect YouTube at /channel.`).catch(() => {});
    return "failed";
  }
}
