import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { completeOAuth } from "@/server/google";
import { STATE2, STATE3, completeOAuth2 } from "@/server/google2";

// Google redirects here after the user approves (or declines). The single-use `state`
// must belong to the signed-in user's session, so a forged link cannot attach someone's channel.
export const Route = createFileRoute("/api/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const back = (q: string) =>
          new Response(null, {
            status: 302,
            headers: { Location: `/channel?${q}`, "Cache-Control": "no-store" },
          });
        if (url.searchParams.get("error")) return back("youtube=denied");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state)
          return back(`youtube=error&reason=${encodeURIComponent("Missing sign-in details.")}`);
        try {
          const { db, user, env } = await requireUser();
          if (state.startsWith(STATE2) || state.startsWith(STATE3)) await completeOAuth2(db, env, user.id, url.origin, code, state);
          else await completeOAuth(db, env, user.id, url.origin, code, state);
          return back("youtube=connected");
        } catch (e) {
          if (!(e instanceof AppError)) console.error("google callback failed", e);
          const reason = e instanceof AppError ? e.message : "Could not connect YouTube.";
          return back(`youtube=error&reason=${encodeURIComponent(reason.slice(0, 240))}`);
        }
      },
    },
  },
});
