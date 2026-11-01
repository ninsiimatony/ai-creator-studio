import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUserOrBot, hasBotBearer } from "@/server/context";
import { getAccessToken } from "@/server/google";

const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Gives the GitHub video job a short-lived (about 1 hour) YouTube token so it can upload as PRIVATE.
export const Route = createFileRoute("/api/automation/youtube-token")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return fail(403, "Not allowed.");
        try {
          const { db, env, user } = await requireUserOrBot(request);
          const { accessToken } = await getAccessToken(db, env, user.id, fetch);
          return Response.json({ accessToken }, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          console.error("youtube token route failed", e);
          return fail(500, "Something went wrong.");
        }
      },
    },
  },
});
