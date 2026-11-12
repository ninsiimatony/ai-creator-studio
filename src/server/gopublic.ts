// One-tap publishing: lists PRIVATE videos of a channel and makes a chosen one public.
import type { D1Database, WorkerEnv } from "./db";
import { AppError } from "./errors";
import { getAccessToken } from "./google";
import { getAccessToken2 } from "./google2";

type F = typeof fetch;
const API = "https://www.googleapis.com/youtube/v3";

async function token(db: D1Database, env: WorkerEnv, userId: string, channel: number, f: F) {
  return channel === 3 ? getAccessToken2(db, env, f, 3) : channel === 2 ? getAccessToken2(db, env, f) : getAccessToken(db, env, userId, f);
}

async function yt(f: F, url: string, accessToken: string, init: RequestInit = {}) {
  const res = await f(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" } });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    if (res.status === 403 && /insufficient|scope/i.test(JSON.stringify(json)))
      throw new AppError("This channel needs the new permission. Reconnect it (the Reconnect button above) and allow everything.");
    throw new AppError(`YouTube said no (${res.status}). ${String(json?.["error"]?.message ?? "").slice(0, 120)}`);
  }
  return json;
}

export type PrivateVideo = { id: string; title: string; thumb: string; minutes: number; when: string };

function minutesOf(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso) ?? [];
  return Math.round(((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) / 60) * 10) / 10;
}

export async function listPrivate(db: D1Database, env: WorkerEnv, userId: string, channel: number, f: F = fetch) {
  const { accessToken } = await token(db, env, userId, channel, f);
  const ch = await yt(f, `${API}/channels?part=contentDetails,snippet&mine=true`, accessToken);
  const uploads = ch["items"]?.[0]?.contentDetails?.relatedPlaylists?.uploads as string | undefined;
  const title = String(ch["items"]?.[0]?.snippet?.title ?? "");
  if (!uploads) return { channelTitle: title, videos: [] as PrivateVideo[] };
  const pl = await yt(f, `${API}/playlistItems?part=contentDetails&maxResults=30&playlistId=${uploads}`, accessToken);
  const ids = ((pl["items"] ?? []) as any[]).map((i) => i.contentDetails?.videoId).filter(Boolean) as string[];
  if (!ids.length) return { channelTitle: title, videos: [] as PrivateVideo[] };
  const vs = await yt(f, `${API}/videos?part=snippet,status,contentDetails&id=${ids.join(",")}`, accessToken);
  const videos: PrivateVideo[] = ((vs["items"] ?? []) as any[])
    .filter((v) => v.status?.privacyStatus === "private" && v.status?.uploadStatus !== "rejected" && v.status?.uploadStatus !== "failed")
    .map((v) => ({
      id: v.id,
      title: String(v.snippet?.title ?? ""),
      thumb: String(v.snippet?.thumbnails?.medium?.url ?? v.snippet?.thumbnails?.default?.url ?? ""),
      minutes: minutesOf(String(v.contentDetails?.duration ?? "")),
      when: String(v.snippet?.publishedAt ?? ""),
    }));
  return { channelTitle: title, videos };
}

export async function makePublic(db: D1Database, env: WorkerEnv, userId: string, channel: number, videoId: string, f: F = fetch) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new AppError("Bad video id.");
  const { accessToken } = await token(db, env, userId, channel, f);
  const cur = await yt(f, `${API}/videos?part=status&id=${videoId}`, accessToken);
  const st = cur["items"]?.[0]?.status;
  if (!st) throw new AppError("That video is not on this channel.");
  await yt(f, `${API}/videos?part=status`, accessToken, {
    method: "PUT",
    body: JSON.stringify({
      id: videoId,
      status: {
        privacyStatus: "public",
        selfDeclaredMadeForKids: st.selfDeclaredMadeForKids ?? false,
        embeddable: st.embeddable ?? true,
        license: st.license ?? "youtube",
        publicStatsViewable: st.publicStatsViewable ?? true,
        containsSyntheticMedia: st.containsSyntheticMedia ?? false,
      },
    }),
  });
}
