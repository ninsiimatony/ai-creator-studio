import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { startOAuth2 } from "@/server/google2";

// Open this page while signed in to connect the FOURTH (Night Tales Uganda) YouTube channel (shares the second channel's Google project unless GOOGLE_CLIENT_ID_3 is set; slot 4 always uses the second project).
export const Route = createFileRoute("/api/auth/google4/start")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        try {
          const { db, user, env } = await requireUser();
          const url = await startOAuth2(db, env, user.id, new URL(request.url).origin, 4);
          return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
        } catch (e) {
          const msg = e instanceof AppError ? e.message : "Could not start the connection.";
          return new Response(msg, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
      },
    },
  },
});
