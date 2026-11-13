import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { listPrivate } from "@/server/gopublic";

const out = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Private videos of all channels (session required).
export const Route = createFileRoute("/api/publish/list")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { db, user, env } = await requireUser();
          const result: Record<string, unknown> = {};
          for (const ch of [1, 2, 3, 4]) {
            try {
              result[String(ch)] = { ok: true, ...(await listPrivate(db, env, user.id, ch)) };
            } catch (e) {
              result[String(ch)] = { ok: false, error: e instanceof AppError ? e.message : "Could not load this channel." };
            }
          }
          return out(200, result);
        } catch (e) {
          return out(401, { error: e instanceof AppError ? e.message : "Please sign in." });
        }
      },
    },
  },
});
