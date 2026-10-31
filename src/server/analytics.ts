// Channel analytics from the YouTube Analytics API (v2). Only metrics known to exist are requested.
// Click-through rate is deliberately NOT requested: its availability through this API is unverified.
import type { D1Database } from "./db";
import { AppError } from "./errors";
import { getAccessToken, type GoogleEnv } from "./google";

type F = typeof fetch;

export type AnalyticsSummary = {
  days: number;
  startDate: string;
  endDate: string;
  totals: {
    views: number;
    minutesWatched: number;
    avgViewDurationSec: number;
    avgViewPercentage: number;
    subscribersGained: number;
  };
  daily: { date: string; views: number; minutes: number }[];
  topVideos: { videoId: string; title: string; views: number; minutes: number }[];
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function report(f: F, token: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ids: "channel==MINE", ...params });
  const res = await f(`https://youtubeanalytics.googleapis.com/v2/reports?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("youtube analytics error", res.status);
    if (res.status === 401 || res.status === 403) {
      throw new AppError(
        "YouTube Analytics access was refused. Reconnect YouTube and allow all permissions.",
      );
    }
    throw new AppError(`YouTube Analytics returned an error (${res.status}). Please try again.`);
  }
  const j = (await res.json()) as {
    columnHeaders?: { name: string }[];
    rows?: (string | number)[][];
  };
  const cols = (j.columnHeaders ?? []).map((c) => c.name);
  return (j.rows ?? []).map(
    (r) => Object.fromEntries(cols.map((c, i) => [c, r[i]!])) as Record<string, string | number>,
  );
}

export async function fetchAnalytics(
  db: D1Database,
  env: GoogleEnv,
  userId: string,
  days: 7 | 28 | 90,
  f: F = fetch,
  now = new Date(),
): Promise<AnalyticsSummary> {
  const { accessToken } = await getAccessToken(db, env, userId, f);
  // Analytics data lags by a day or two; end at yesterday (UTC).
  const end = new Date(now.getTime() - 24 * 3600 * 1000);
  const start = new Date(end.getTime() - (days - 1) * 24 * 3600 * 1000);
  const range = { startDate: iso(start), endDate: iso(end) };

  const dailyRows = await report(f, accessToken, {
    ...range,
    metrics:
      "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained",
    dimensions: "day",
    sort: "day",
  });
  const daily = dailyRows.map((r) => ({
    date: String(r["day"]),
    views: Number(r["views"]),
    minutes: Number(r["estimatedMinutesWatched"]),
  }));
  const views = dailyRows.reduce((a, r) => a + Number(r["views"]), 0);
  const weighted = (key: string) =>
    views === 0
      ? 0
      : dailyRows.reduce((a, r) => a + Number(r[key]) * Number(r["views"]), 0) / views;

  const topRows = await report(f, accessToken, {
    ...range,
    metrics: "views,estimatedMinutesWatched",
    dimensions: "video",
    sort: "-views",
    maxResults: "10",
  });
  const titles = new Map<string, string>();
  const ids = topRows.map((r) => String(r["video"]));
  if (ids.length) {
    const res = await f(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.map(encodeURIComponent).join(",")}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok) {
      const j = (await res.json()) as { items?: { id: string; snippet: { title: string } }[] };
      for (const it of j.items ?? []) titles.set(it.id, it.snippet.title);
    }
  }

  return {
    days,
    ...range,
    totals: {
      views,
      minutesWatched: dailyRows.reduce((a, r) => a + Number(r["estimatedMinutesWatched"]), 0),
      avgViewDurationSec: weighted("averageViewDuration"),
      avgViewPercentage: weighted("averageViewPercentage"),
      subscribersGained: dailyRows.reduce((a, r) => a + Number(r["subscribersGained"]), 0),
    },
    daily,
    topVideos: topRows.map((r) => ({
      videoId: String(r["video"]),
      title: titles.get(String(r["video"])) ?? String(r["video"]),
      views: Number(r["views"]),
      minutes: Number(r["estimatedMinutesWatched"]),
    })),
  };
}

export type RetentionPoint = { ratio: number; watch: number };

/** Audience retention curve for one of the user's own uploaded videos. */
export async function fetchRetention(
  db: D1Database,
  env: GoogleEnv,
  userId: string,
  videoId: string,
  f: F = fetch,
  now = new Date(),
): Promise<RetentionPoint[]> {
  const v = await db
    .prepare("SELECT youtube_video_id FROM videos WHERE id = ? AND user_id = ?")
    .bind(videoId, userId)
    .first<{ youtube_video_id: string | null }>();
  if (!v?.youtube_video_id) throw new AppError("That video is not on YouTube yet.");
  const { accessToken } = await getAccessToken(db, env, userId, f);
  const rows = await report(f, accessToken, {
    startDate: "2005-04-23", // YouTube's launch; covers the video's whole life
    endDate: iso(new Date(now.getTime() - 24 * 3600 * 1000)),
    metrics: "audienceWatchRatio",
    dimensions: "elapsedVideoTimeRatio",
    filters: `video==${v.youtube_video_id}`,
    sort: "elapsedVideoTimeRatio",
  });
  return rows.map((r) => ({
    ratio: Number(r["elapsedVideoTimeRatio"]),
    watch: Number(r["audienceWatchRatio"]),
  }));
}
