import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { guard, requireUser } from "@/server/context";
import { confirmUpload, setVisibility, startUpload } from "@/server/youtube";
import { disconnect, fetchChannelStats, startOAuth, type ChannelStats } from "@/server/google";

/** Returns Google's consent URL. The browser then navigates there; Google handles the sign-in. */
export const startGoogleConnect = createServerFn({ method: "POST" }).handler(async () =>
  guard(async () => {
    const { db, user, env } = await requireUser();
    const url = await startOAuth(db, env, user.id, new URL(getRequest().url).origin);
    return { url };
  }),
);

export const disconnectYoutube = createServerFn({ method: "POST" }).handler(async () =>
  guard(async () => {
    const { db, user, env } = await requireUser();
    await disconnect(db, env, user.id);
    return { ok: true as const };
  }),
);

export const getChannelStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChannelStats> =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      return fetchChannelStats(db, env, user.id);
    }),
);

const vid = z.string().min(1).max(64);

/** Creates a resumable YouTube upload session. Only approved videos; private unless confirmed. */
export const startYoutubeUpload = createServerFn({ method: "POST" })
  .validator(
    z.object({
      videoId: vid,
      privacy: z.enum(["private", "unlisted", "public"]).default("private"),
      publishAt: z.string().max(40).optional(),
      confirmPublic: z.string().max(20).optional(),
      fileSize: z.number().int().positive(),
      mimeType: z.string().max(100),
    }),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      return startUpload({
        db,
        env,
        userId: user.id,
        origin: new URL(getRequest().url).origin,
        ...data,
      });
    }),
  );

export const confirmYoutubeUpload = createServerFn({ method: "POST" })
  .validator(z.object({ videoId: vid, youtubeVideoId: z.string().min(6).max(20) }))
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      return confirmUpload({ db, env, userId: user.id, ...data });
    }),
  );

export const setYoutubeVisibility = createServerFn({ method: "POST" })
  .validator(
    z.object({
      videoId: vid,
      privacy: z.enum(["private", "unlisted", "public"]),
      confirmPublic: z.string().max(20).optional(),
    }),
  )
  .handler(async ({ data }) =>
    guard(async () => {
      const { db, user, env } = await requireUser();
      return setVisibility({ db, env, userId: user.id, ...data });
    }),
  );
