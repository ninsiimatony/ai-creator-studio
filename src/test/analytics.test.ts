// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import { encryptSecret } from "@/server/secretbox";
import { fetchAnalytics, fetchRetention } from "@/server/analytics";

let db: D1Database;
let dispose: () => Promise<void>;
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", TOKEN_ENC_KEY: KEY };
const NOW = new Date("2026-11-10T12:00:00Z");

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
}, 60_000);
afterAll(async () => dispose?.());

async function mkUser(email: string) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')")
    .bind(id, email)
    .run();
  await db
    .prepare(
      "INSERT INTO youtube_accounts (user_id, channel_id, channel_title, refresh_token_enc, scopes) VALUES (?, 'UCme', 'Me', ?, 's')",
    )
    .bind(id, await encryptSecret("r", KEY))
    .run();
  return id;
}

type R = { status?: number; headers?: string[]; rows?: (string | number)[][] };
function fake(daily: R, video: R, titles: Record<string, string> = {}) {
  const urls: string[] = [];
  const j = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const f: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return j({ access_token: "tok" });
    if (url.includes("youtubeanalytics.googleapis.com")) {
      const r = new URL(url).searchParams.get("dimensions") === "day" ? daily : video;
      if (r.status && r.status >= 400) return j({}, r.status);
      return j({ columnHeaders: (r.headers ?? []).map((name) => ({ name })), rows: r.rows ?? [] });
    }
    if (url.includes("/youtube/v3/videos?part=snippet"))
      return j({
        items: Object.entries(titles).map(([id, title]) => ({ id, snippet: { title } })),
      });
    return j({}, 500);
  };
  return { f, urls };
}
const DAILY_H = [
  "day",
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
];
const VIDEO_H = ["video", "views", "estimatedMinutesWatched"];

describe("channel analytics", () => {
  it("requests only known metrics for a day range ending yesterday, and never CTR", async () => {
    const u = await mkUser("req@x.co");
    const g = fake({ headers: DAILY_H, rows: [] }, { headers: VIDEO_H, rows: [] });
    await fetchAnalytics(db, env, u, 28, g.f, NOW);
    const daily = new URL(g.urls.find((x) => x.includes("dimensions=day"))!);
    expect(daily.searchParams.get("ids")).toBe("channel==MINE");
    expect(daily.searchParams.get("endDate")).toBe("2026-11-09");
    expect(daily.searchParams.get("startDate")).toBe("2026-10-13");
    expect(daily.searchParams.get("metrics")).toBe(
      "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained",
    );
    expect(g.urls.join(" ")).not.toMatch(/impression|ClickThrough/i);
  });

  it("sums totals and weights averages by views", async () => {
    const u = await mkUser("sum@x.co");
    const g = fake(
      {
        headers: DAILY_H,
        rows: [
          ["2026-11-08", 100, 400, 60, 50, 3],
          ["2026-11-09", 300, 900, 120, 30, 2],
        ],
      },
      {
        headers: VIDEO_H,
        rows: [
          ["vidA", 250, 800],
          ["vidB", 150, 500],
        ],
      },
      { vidA: "First video" },
    );
    const r = await fetchAnalytics(db, env, u, 7, g.f, NOW);
    expect(r.totals).toMatchObject({ views: 400, minutesWatched: 1300, subscribersGained: 5 });
    expect(r.totals.avgViewDurationSec).toBeCloseTo((60 * 100 + 120 * 300) / 400, 6);
    expect(r.totals.avgViewPercentage).toBeCloseTo((50 * 100 + 30 * 300) / 400, 6);
    expect(r.daily).toEqual([
      { date: "2026-11-08", views: 100, minutes: 400 },
      { date: "2026-11-09", views: 300, minutes: 900 },
    ]);
    expect(r.topVideos[0]).toEqual({
      videoId: "vidA",
      title: "First video",
      views: 250,
      minutes: 800,
    });
    expect(r.topVideos[1]!.title).toBe("vidB"); // falls back to the id when no title is found
  });

  it("returns zeros (not an error) for a channel with no data yet", async () => {
    const u = await mkUser("empty@x.co");
    const r = await fetchAnalytics(
      db,
      env,
      u,
      7,
      fake({ headers: DAILY_H }, { headers: VIDEO_H }).f,
      NOW,
    );
    expect(r.totals).toEqual({
      views: 0,
      minutesWatched: 0,
      avgViewDurationSec: 0,
      avgViewPercentage: 0,
      subscribersGained: 0,
    });
    expect(r.daily).toEqual([]);
    expect(r.topVideos).toEqual([]);
  });

  it("explains permission problems and other API errors", async () => {
    const u = await mkUser("err@x.co");
    await expect(fetchAnalytics(db, env, u, 7, fake({ status: 403 }, {}).f, NOW)).rejects.toThrow(
      /Reconnect YouTube/,
    );
    await expect(fetchAnalytics(db, env, u, 7, fake({ status: 500 }, {}).f, NOW)).rejects.toThrow(
      /\(500\)/,
    );
  });
});

describe("audience retention", () => {
  it("works only for the user's own uploaded videos", async () => {
    const u = await mkUser("ret@x.co");
    const other = await mkUser("ret2@x.co");
    const vid = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO videos (id, user_id, title, youtube_video_id, youtube_status) VALUES (?, ?, 't', 'ytVID12345', 'private')",
      )
      .bind(vid, u)
      .run();
    const notUp = crypto.randomUUID();
    await db
      .prepare("INSERT INTO videos (id, user_id, title) VALUES (?, ?, 't2')")
      .bind(notUp, u)
      .run();

    const g = fake(
      {},
      {
        headers: ["elapsedVideoTimeRatio", "audienceWatchRatio"],
        rows: [
          [0.01, 1],
          [0.5, 0.62],
          [1, 0.3],
        ],
      },
    );
    const pts = await fetchRetention(db, env, u, vid, g.f, NOW);
    expect(pts).toEqual([
      { ratio: 0.01, watch: 1 },
      { ratio: 0.5, watch: 0.62 },
      { ratio: 1, watch: 0.3 },
    ]);
    const q = new URL(g.urls.find((x) => x.includes("youtubeanalytics"))!).searchParams;
    expect(q.get("filters")).toBe("video==ytVID12345");
    expect(q.get("metrics")).toBe("audienceWatchRatio");

    await expect(fetchRetention(db, env, u, notUp, g.f, NOW)).rejects.toThrow(/not on YouTube/);
    await expect(fetchRetention(db, env, other, vid, g.f, NOW)).rejects.toThrow(/not on YouTube/);
  });
});
