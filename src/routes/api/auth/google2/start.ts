import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { startOAuth2 } from "@/server/google2";

// Open this page while signed in to connect the SECOND YouTube channel (uses its own Google project).
export const Route = createFileRoute("/api/auth/google2/start")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        try {
          const { db, user, env } = await requireUser();
          const url = await startOAuth2(db, env, user.id, new URL(request.url).origin);
          return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
        } catch (e) {
          const msg = e instanceof AppError ? e.message : "Could not start the connection.";
          return new Response(msg, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
