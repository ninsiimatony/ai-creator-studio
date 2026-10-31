// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import * as repo from "@/server/repo";
import { encryptSecret } from "@/server/secretbox";
import {
  PUBLISH_PHRASE,
  confirmUpload,
  prepareTags,
  setThumbnail,
  setVisibility,
  startUpload,
} from "@/server/youtube";
import { STAGES } from "@/lib/types";

let db: D1Database;
let dispose: () => Promise<void>;
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", TOKEN_ENC_KEY: KEY };
const ORIGIN = "https://studio.example.dev";

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
}, 60_000);
afterAll(async () => dispose?.());

async function mkUser(email: string, connect = true) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')")
    .bind(id, email)
    .run();
  if (connect) {
    await db
      .prepare(
        "INSERT INTO youtube_accounts (user_id, channel_id, channel_title, refresh_token_enc, scopes) VALUES (?, 'UCme', 'Me', ?, 's')",
      )
      .bind(id, await encryptSecret("refresh", KEY))
      .run();
  }
  return id;
}

/** An approved video with full metadata. */
async function approvedVideo(
  uid: string,
  over: { title?: string; description?: string; tags?: string[]; approve?: boolean } = {},
) {
  const v = await repo.createVideo(db, uid, { title: over.title ?? "My video" });
  await repo.updateVideoMeta(db, uid, v.id, {
    description: over.description ?? "A description",
    tags: over.tags ?? ["ai", "robots"],
  });
  if (over.approve !== false) {
    for (const s of STAGES) await repo.toggleStage(db, uid, v.id, s.key);
    await repo.submitVideo(db, uid, v.id);
    await repo.decideVideo(db, uid, v.id, "approved", "ok", true);
  }
  return v.id;
}

type Call = { url: string; method: string; headers: Headers; body: string };
function fakeYt(
  opts: {
    videoChannel?: string;
    videoPrivacy?: string;
    publishAt?: string;
    initStatus?: number;
    thumbStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(o), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok" });
    if (url.includes("/upload/youtube/v3/videos?uploadType=resumable"))
      return opts.initStatus && opts.initStatus >= 400
        ? json({ error: { errors: [{ reason: "quotaExceeded" }] } }, opts.initStatus)
        : json({}, 200, { location: "https://upload.example.google/session/abc" });
    if (url.includes("/upload/youtube/v3/thumbnails/set"))
      return opts.thumbStatus ? json({}, opts.thumbStatus) : json({});
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos?part=snippet,status"))
      return json({
        items: [
          {
            snippet: { channelId: opts.videoChannel ?? "UCme" },
            status: {
              privacyStatus: opts.videoPrivacy ?? "private",
              ...(opts.publishAt ? { publishAt: opts.publishAt } : {}),
            },
          },
        ],
      });
    if (
      url.startsWith("https://www.googleapis.com/youtube/v3/videos?part=status") &&
      (init?.method ?? "GET") === "GET"
    )
      return json({
        items: [
          {
            status: {
              privacyStatus: "private",
              publishAt: "2030-01-01T00:00:00Z",
              embeddable: true,
            },
          },
        ],
      });
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos?part=status")) return json({});
    return json({ error: "unexpected " + url }, 500);
  };
  return { f, calls };
}
const upload = (
  g: ReturnType<typeof fakeYt>,
  uid: string,
  videoId: string,
  over: Record<string, unknown> = {},
) =>
  startUpload({
    db,
    env,
    userId: uid,
    videoId,
    privacy: "private",
    fileSize: 1000,
    mimeType: "video/mp4",
    origin: ORIGIN,
    fetch: g.f,
    ...over,
  });
const status = async (uid: string, id: string) => (await repo.getVideo(db, uid, id)).youtubeStatus;
const future = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString();

describe("what may be sent to YouTube", () => {
  it("refuses any video that is not approved, without contacting YouTube", async () => {
    const u = await mkUser("na@x.co");
    const id = await approvedVideo(u, { approve: false });
    const g = fakeYt();
    await expect(upload(g, u, id)).rejects.toThrow(/approved/);
    expect(g.calls).toHaveLength(0);
    // Pending (submitted but not decided) is also refused.
    const v2 = await repo.createVideo(db, u, { title: "Pending", scheduled: "" });
    await repo.updateVideoMeta(db, u, v2.id, { description: "d" });
    for (const s of STAGES) await repo.toggleStage(db, u, v2.id, s.key);
    await repo.submitVideo(db, u, v2.id);
    await expect(upload(g, u, v2.id)).rejects.toThrow(/approved/);
    expect(g.calls).toHaveLength(0);
  });

  it("requires a title, description and a real video file", async () => {
    const u = await mkUser("meta@x.co");
    const g = fakeYt();
    await expect(upload(g, u, await approvedVideo(u, { description: "" }))).rejects.toThrow(
      /description/,
    );
    const ok = await approvedVideo(u);
    await expect(upload(g, u, ok, { mimeType: "application/pdf" })).rejects.toThrow(/video file/);
    await expect(upload(g, u, ok, { fileSize: 0 })).rejects.toThrow(/size/);
    expect(g.calls).toHaveLength(0);
  });

  it("refuses another user's video and users without a connected channel", async () => {
    const owner = await mkUser("own@x.co");
    const other = await mkUser("oth@x.co");
    const noChannel = await mkUser("nochan@x.co", false);
    const id = await approvedVideo(owner);
    const g = fakeYt();
    await expect(upload(g, other, id)).rejects.toThrow(/not found/);
    const mine = await approvedVideo(noChannel);
    await expect(upload(g, noChannel, mine)).rejects.toThrow(/not connected/);
  });
});

describe("upload defaults and publishing confirmation", () => {
  it("uploads PRIVATE by default, with correct headers, metadata and sanitising", async () => {
    const u = await mkUser("priv@x.co");
    const id = await approvedVideo(u, { title: "Hello <b>World</b>", tags: ["ok", "<bad>", ""] });
    const g = fakeYt();
    const r = await upload(g, u, id);
    expect(r.uploadUrl).toBe("https://upload.example.google/session/abc");
    const init = g.calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(init.headers.get("authorization")).toBe("Bearer tok");
    expect(init.headers.get("x-upload-content-length")).toBe("1000");
    expect(init.headers.get("origin")).toBe(ORIGIN);
    const body = JSON.parse(init.body);
    expect(body.status).toMatchObject({ privacyStatus: "private", selfDeclaredMadeForKids: false });
    expect(body.status.publishAt).toBeUndefined();
    expect(body.snippet.title).toBe("Hello bWorld/b");
    expect(body.snippet.tags).toEqual(["ok", "bad"]);
    expect(await status(u, id)).toBe("uploading");
  });

  it("will not make a video public — now or by schedule — without typing PUBLISH", async () => {
    const u = await mkUser("pub@x.co");
    const id = await approvedVideo(u);
    const g = fakeYt();
    await expect(upload(g, u, id, { privacy: "public" })).rejects.toThrow(/PUBLISH/);
    await expect(upload(g, u, id, { privacy: "public", confirmPublic: "publish" })).rejects.toThrow(
      /PUBLISH/,
    );
    await expect(upload(g, u, id, { publishAt: future() })).rejects.toThrow(/PUBLISH/);
    expect(g.calls).toHaveLength(0);
    expect(await status(u, id)).toBe("none");

    await upload(g, u, id, { privacy: "public", confirmPublic: PUBLISH_PHRASE });
    const sent = JSON.parse(g.calls.find((c) => c.url.includes("uploadType=resumable"))!.body);
    expect(sent.status.privacyStatus).toBe("public");
  });

  it("scheduling uploads as private + publishAt, and rejects past or too-soon times", async () => {
    const u = await mkUser("sched@x.co");
    const id = await approvedVideo(u);
    const g = fakeYt();
    await expect(
      upload(g, u, id, {
        publishAt: new Date(Date.now() - 1000).toISOString(),
        confirmPublic: PUBLISH_PHRASE,
      }),
    ).rejects.toThrow(/future/);
    await expect(
      upload(g, u, id, { publishAt: "not a date", confirmPublic: PUBLISH_PHRASE }),
    ).rejects.toThrow(/future/);
    const when = future();
    await upload(g, u, id, { privacy: "public", publishAt: when, confirmPublic: PUBLISH_PHRASE });
    const sent = JSON.parse(g.calls.find((c) => c.url.includes("uploadType=resumable"))!.body);
    expect(sent.status).toMatchObject({ privacyStatus: "private", publishAt: when });
  });

  it("maps YouTube quota errors to a clear message and leaves the video untouched", async () => {
    const u = await mkUser("quota@x.co");
    const id = await approvedVideo(u);
    await expect(upload(fakeYt({ initStatus: 403 }), u, id)).rejects.toThrow(/quota/i);
    expect(await status(u, id)).toBe("none");
  });

  it("limits tag length to YouTube's total", () => {
    const tags = Array.from({ length: 100 }, (_, i) => `tag-number-${i}-xxxxxxxx`);
    const out = prepareTags(tags);
    expect(out.join(",").length).toBeLessThanOrEqual(500);
    expect(out.length).toBeLessThan(100);
  });
});

describe("confirming and changing visibility", () => {
  async function uploaded(email: string, g = fakeYt()) {
    const u = await mkUser(email);
    const id = await approvedVideo(u);
    await upload(g, u, id);
    return { u, id, g };
  }

  it("verifies the uploaded video is on the user's own channel before recording it", async () => {
    const { u, id } = await uploaded("conf@x.co");
    await expect(
      confirmUpload({
        db,
        env,
        userId: u,
        videoId: id,
        youtubeVideoId: "abcDEF12345",
        fetch: fakeYt({ videoChannel: "UCsomeoneElse" }).f,
      }),
    ).rejects.toThrow(/does not belong/);
    expect(await status(u, id)).toBe("uploading");
    const r = await confirmUpload({
      db,
      env,
      userId: u,
      videoId: id,
      youtubeVideoId: "abcDEF12345",
      fetch: fakeYt().f,
    });
    expect(r).toEqual({ status: "private", youtubeVideoId: "abcDEF12345" });
    expect((await repo.getVideo(db, u, id)).youtubeVideoId).toBe("abcDEF12345");
  });

  it("records scheduled videos, rejects bad ids, and requires an upload in progress", async () => {
    const { u, id } = await uploaded("conf2@x.co");
    await expect(
      confirmUpload({ db, env, userId: u, videoId: id, youtubeVideoId: "../x", fetch: fakeYt().f }),
    ).rejects.toThrow(/not valid/);
    const r = await confirmUpload({
      db,
      env,
      userId: u,
      videoId: id,
      youtubeVideoId: "abcDEF12345",
      fetch: fakeYt({ publishAt: "2030-01-01T00:00:00Z" }).f,
    });
    expect(r.status).toBe("scheduled");
    await expect(
      confirmUpload({
        db,
        env,
        userId: u,
        videoId: id,
        youtubeVideoId: "abcDEF12345",
        fetch: fakeYt().f,
      }),
    ).rejects.toThrow(/No upload is in progress/);
  });

  it("making an uploaded video public needs PUBLISH, and clears any schedule", async () => {
    const { u, id } = await uploaded("vis@x.co");
    await confirmUpload({
      db,
      env,
      userId: u,
      videoId: id,
      youtubeVideoId: "abcDEF12345",
      fetch: fakeYt().f,
    });
    const g = fakeYt();
    await expect(
      setVisibility({ db, env, userId: u, videoId: id, privacy: "public", fetch: g.f }),
    ).rejects.toThrow(/PUBLISH/);
    expect(g.calls.some((c) => c.method === "PUT")).toBe(false);
    await setVisibility({
      db,
      env,
      userId: u,
      videoId: id,
      privacy: "public",
      confirmPublic: PUBLISH_PHRASE,
      fetch: g.f,
    });
    const put = g.calls.find((c) => c.method === "PUT")!;
    const sent = JSON.parse(put.body);
    expect(sent).toMatchObject({
      id: "abcDEF12345",
      status: { privacyStatus: "public", embeddable: true },
    });
    expect(sent.status.publishAt).toBeUndefined();
    expect(await status(u, id)).toBe("public");
  });

  it("will not change visibility of a video that was never uploaded", async () => {
    const u = await mkUser("never@x.co");
    const id = await approvedVideo(u);
    await expect(
      setVisibility({ db, env, userId: u, videoId: id, privacy: "unlisted", fetch: fakeYt().f }),
    ).rejects.toThrow(/Upload the video/);
  });
});

describe("thumbnails", () => {
  it("accepts small PNG/JPEG for an uploaded, approved video only", async () => {
    const u = await mkUser("thumb@x.co");
    const id = await approvedVideo(u);
    const g = fakeYt();
    await expect(
      setThumbnail({
        db,
        env,
        userId: u,
        videoId: id,
        image: new ArrayBuffer(10),
        mimeType: "image/png",
        fetch: g.f,
      }),
    ).rejects.toThrow(/Upload the video/);
    await upload(g, u, id);
    await confirmUpload({
      db,
      env,
      userId: u,
      videoId: id,
      youtubeVideoId: "abcDEF12345",
      fetch: g.f,
    });
    await expect(
      setThumbnail({
        db,
        env,
        userId: u,
        videoId: id,
        image: new ArrayBuffer(10),
        mimeType: "image/gif",
        fetch: g.f,
      }),
    ).rejects.toThrow(/PNG or JPEG/);
    await expect(
      setThumbnail({
        db,
        env,
        userId: u,
        videoId: id,
        image: new ArrayBuffer(3 * 1024 * 1024),
        mimeType: "image/png",
        fetch: g.f,
      }),
    ).rejects.toThrow(/2 MB/);
    await setThumbnail({
      db,
      env,
      userId: u,
      videoId: id,
      image: new ArrayBuffer(100),
      mimeType: "image/jpeg",
      fetch: g.f,
    });
    const call = g.calls.find((c) => c.url.includes("thumbnails/set"))!;
    expect(call.url).toContain("videoId=abcDEF12345");
    expect(call.headers.get("content-type")).toBe("image/jpeg");
    await expect(
      setThumbnail({
        db,
        env,
        userId: u,
        videoId: id,
        image: new ArrayBuffer(100),
        mimeType: "image/png",
        fetch: fakeYt({ thumbStatus: 403 }).f,
      }),
    ).rejects.toThrow(/verified/);
  });
});
