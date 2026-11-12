import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { startOAuth } from "@/server/google";

// Open this page while signed in to (re)connect the MAIN YouTube channel without disconnecting first.
// Useful after the Google app moves from "Testing" to "In production", so a fresh long-lived token is issued.
export const Route = createFileRoute("/api/auth/google1/start")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        try {
          const { db, user, env } = await requireUser();
          const url = await startOAuth(db, env, user.id, new URL(request.url).origin);
          return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
        } catch (e) {
          const msg = e instanceof AppError ? e.message : "Could not start the connection.";
          return new Response(msg, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
