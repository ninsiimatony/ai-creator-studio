// Publishing to YouTube. Every rule here is enforced server-side:
//  - only videos Tony has APPROVED can be sent;
//  - uploads are private unless he explicitly asks otherwise;
//  - anything that makes a video public (now or scheduled) needs the typed phrase PUBLISH.
import type { D1Database } from "./db";
import { AppError } from "./errors";
import { getAccessToken, type GoogleEnv } from "./google";
import { getVideo } from "./repo";
import type { YoutubeStatus } from "@/lib/types";

type F = typeof fetch;
export type Privacy = "private" | "unlisted" | "public";
export const PUBLISH_PHRASE = "PUBLISH";
const MAX_FILE_BYTES = 256 * 1024 ** 3;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

const clean = (s: string) => s.replace(/[<>]/g, "").trim();

/** YouTube limits tags to ~500 characters in total. */
export function prepareTags(tags: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const t of tags.map(clean).filter(Boolean)) {
    if (total + t.length + 1 > 500) break;
    out.push(t);
    total += t.length + 1;
  }
  return out;
}

function requireApproved(status: string) {
  if (status !== "approved") {
    throw new AppError(
      "Only videos you have approved in the Approvals queue can be sent to YouTube.",
    );
  }
}
function requirePhrase(confirm: string | undefined) {
  if (confirm !== PUBLISH_PHRASE) {
    throw new AppError(
      `Making a video public needs your explicit confirmation: type ${PUBLISH_PHRASE}.`,
    );
  }
}

async function googleError(res: Response): Promise<AppError> {
  const j = (await res.json().catch(() => ({}))) as {
    error?: { errors?: { reason?: string }[]; message?: string };
  };
  const reason = j.error?.errors?.[0]?.reason;
  console.error("youtube api error", res.status, reason);
  if (reason === "quotaExceeded")
    return new AppError("YouTube's daily API quota is used up. Try again tomorrow.");
  if (reason === "uploadLimitExceeded")
    return new AppError("YouTube's upload limit for this channel was reached.");
  if (res.status === 401) return new AppError("Google access expired. Reconnect YouTube.");
  if (res.status === 403)
    return new AppError(
      "YouTube refused this request (permissions or quota). Check the connection.",
    );
  return new AppError(`YouTube returned an error (${res.status}). Please try again.`);
}

async function setState(
  db: D1Database,
  userId: string,
  videoId: string,
  state: { status: YoutubeStatus; youtubeVideoId?: string; publishAt?: string | null },
) {
  await db
    .prepare(
      `UPDATE videos SET youtube_status = ?, youtube_video_id = COALESCE(?, youtube_video_id),
         publish_at = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
    )
    .bind(state.status, state.youtubeVideoId ?? null, state.publishAt ?? null, videoId, userId)
    .run();
}

export async function startUpload(p: {
  db: D1Database;
  env: GoogleEnv;
  userId: string;
  videoId: string;
  privacy: Privacy;
  publishAt?: string | undefined;
  confirmPublic?: string | undefined;
  fileSize: number;
  mimeType: string;
  origin: string;
  fetch?: F;
}): Promise<{ uploadUrl: string }> {
  const v = await getVideo(p.db, p.userId, p.videoId);
  requireApproved(v.approval);
  if (v.youtubeStatus !== "none" && v.youtubeStatus !== "uploading") {
    throw new AppError("This video is already on YouTube.");
  }
  const title = clean(v.title).slice(0, 100);
  const description = clean(v.description).slice(0, 5000);
  if (!title) throw new AppError("Add a title before uploading.");
  if (!description) throw new AppError("Add a description before uploading.");
  if (!p.mimeType.startsWith("video/")) throw new AppError("Choose a video file.");
  if (!(p.fileSize > 0) || p.fileSize > MAX_FILE_BYTES)
    throw new AppError("That video file size is not valid.");

  // Public or scheduled-to-go-public are publishing acts: require the typed phrase.
  let privacy = p.privacy;
  let publishAtIso: string | null = null;
  if (p.publishAt) {
    const t = new Date(p.publishAt);
    if (Number.isNaN(t.getTime()) || t.getTime() < Date.now() + 10 * 60 * 1000) {
      throw new AppError("Choose a publish time at least 10 minutes in the future.");
    }
    requirePhrase(p.confirmPublic);
    privacy = "private"; // YouTube requires private + publishAt for scheduling
    publishAtIso = t.toISOString();
  } else if (privacy === "public") {
    requirePhrase(p.confirmPublic);
  }

  const { accessToken } = await getAccessToken(p.db, p.env, p.userId, p.fetch ?? fetch);
  const res = await (p.fetch ?? fetch)(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(p.fileSize),
        "x-upload-content-type": p.mimeType,
        // Lets the browser upload straight to the returned session URL (CORS).
        origin: p.origin,
      },
      body: JSON.stringify({
        snippet: { title, description, tags: prepareTags(v.tags), categoryId: "28" },
        status: {
          privacyStatus: privacy,
          ...(publishAtIso ? { publishAt: publishAtIso } : {}),
          selfDeclaredMadeForKids: false,
        },
      }),
    },
  );
  if (!res.ok) throw await googleError(res);
  const uploadUrl = res.headers.get("location");
  if (!uploadUrl || !uploadUrl.startsWith("https://"))
    throw new AppError("YouTube did not return an upload session.");
  await setState(p.db, p.userId, p.videoId, { status: "uploading", publishAt: publishAtIso });
  return { uploadUrl };
}

/** After the browser finishes uploading, verify the video really is on Tony's channel, then record it. */
export async function confirmUpload(p: {
  db: D1Database;
  env: GoogleEnv;
  userId: string;
  videoId: string;
  youtubeVideoId: string;
  fetch?: F;
}): Promise<{ status: YoutubeStatus; youtubeVideoId: string }> {
  const v = await getVideo(p.db, p.userId, p.videoId);
  requireApproved(v.approval);
  if (v.youtubeStatus !== "uploading")
    throw new AppError("No upload is in progress for this video.");
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(p.youtubeVideoId))
    throw new AppError("That YouTube video ID is not valid.");

  const f = p.fetch ?? fetch;
  const { accessToken, channelId } = await getAccessToken(p.db, p.env, p.userId, f);
  const res = await f(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${encodeURIComponent(p.youtubeVideoId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw await googleError(res);
  const j = (await res.json()) as {
    items?: {
      snippet: { channelId: string };
      status: { privacyStatus: Privacy; publishAt?: string };
    }[];
  };
  const item = j.items?.[0];
  if (!item)
    throw new AppError("YouTube does not show that video yet. Wait a moment and try again.");
  if (item.snippet.channelId !== channelId)
    throw new AppError("That video does not belong to your connected channel.");
  const status: YoutubeStatus =
    item.status.privacyStatus === "private" && item.status.publishAt
      ? "scheduled"
      : item.status.privacyStatus;
  await setState(p.db, p.userId, p.videoId, {
    status,
    youtubeVideoId: p.youtubeVideoId,
    publishAt: item.status.publishAt ?? null,
  });
  return { status, youtubeVideoId: p.youtubeVideoId };
}

/** Change visibility of an already-uploaded, approved video. Going public needs the typed phrase. */
export async function setVisibility(p: {
  db: D1Database;
  env: GoogleEnv;
  userId: string;
  videoId: string;
  privacy: Privacy;
  confirmPublic?: string | undefined;
  fetch?: F;
}): Promise<{ status: YoutubeStatus }> {
  const v = await getVideo(p.db, p.userId, p.videoId);
  requireApproved(v.approval);
  if (!v.youtubeVideoId || v.youtubeStatus === "none" || v.youtubeStatus === "uploading") {
    throw new AppError("Upload the video to YouTube first.");
  }
  if (p.privacy === "public") requirePhrase(p.confirmPublic);

  const f = p.fetch ?? fetch;
  const { accessToken } = await getAccessToken(p.db, p.env, p.userId, f);
  const get = await f(
    `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(v.youtubeVideoId)}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (!get.ok) throw await googleError(get);
  const cur = ((await get.json()) as { items?: { status: Record<string, unknown> }[] }).items?.[0];
  if (!cur) throw new AppError("That video was not found on YouTube.");
  const { publishAt: _drop, ...rest } = cur.status;
  void _drop;
  const put = await f("https://www.googleapis.com/youtube/v3/videos?part=status", {
    method: "PUT",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ id: v.youtubeVideoId, status: { ...rest, privacyStatus: p.privacy } }),
  });
  if (!put.ok) throw await googleError(put);
  await setState(p.db, p.userId, p.videoId, { status: p.privacy, publishAt: null });
  return { status: p.privacy };
}

export async function setThumbnail(p: {
  db: D1Database;
  env: GoogleEnv;
  userId: string;
  videoId: string;
  image: ArrayBuffer;
  mimeType: string;
  fetch?: F;
}): Promise<void> {
  const v = await getVideo(p.db, p.userId, p.videoId);
  requireApproved(v.approval);
  if (!v.youtubeVideoId || v.youtubeStatus === "none" || v.youtubeStatus === "uploading") {
    throw new AppError("Upload the video to YouTube first.");
  }
  if (!["image/png", "image/jpeg"].includes(p.mimeType))
    throw new AppError("Use a PNG or JPEG thumbnail.");
  if (p.image.byteLength === 0 || p.image.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new AppError("Thumbnails must be 2 MB or smaller.");
  }
  const f = p.fetch ?? fetch;
  const { accessToken } = await getAccessToken(p.db, p.env, p.userId, f);
  const res = await f(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(v.youtubeVideoId)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": p.mimeType },
      body: p.image,
    },
  );
  if (!res.ok) {
    if (res.status === 403) {
      throw new AppError(
        "YouTube refused the thumbnail. Custom thumbnails need a verified YouTube channel.",
      );
    }
    throw await googleError(res);
  }
}
