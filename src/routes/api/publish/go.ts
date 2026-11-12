import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { makePublic } from "@/server/gopublic";

const Body = z.object({ channel: z.number().int().min(1).max(3), id: z.string().min(6).max(20) });
const out = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Makes ONE chosen private video public (session required, same-origin only).
export const Route = createFileRoute("/api/publish/go")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (request.headers.get("origin") !== new URL(request.url).origin) return out(403, { error: "Cross-site request blocked." });
        try {
          const { db, user, env } = await requireUser();
          const body = Body.parse(await request.json().catch(() => ({})));
          await makePublic(db, env, user.id, body.channel, body.id);
          return out(200, { ok: true });
        } catch (e) {
          if (e instanceof AppError) return out(400, { error: e.message });
          if (e instanceof z.ZodError) return out(400, { error: "Invalid request." });
          console.error("go public failed", e);
          return out(500, { error: "Something went wrong." });
        }
      },
    },
  },
});
