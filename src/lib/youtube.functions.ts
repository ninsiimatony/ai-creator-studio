import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { guard, requireUser } from "@/server/context";
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
