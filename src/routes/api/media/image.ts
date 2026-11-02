import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { hasBotBearer, requireUserOrBot } from "@/server/context";
import { generateImage } from "@/server/media";

const Body = z.object({ prompt: z.string().min(1).max(2000) });
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Same-origin only (not covered by the server-function CSRF middleware), session required.
export const Route = createFileRoute("/api/media/image")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request) && request.headers.get("origin") !== new URL(request.url).origin)
          return fail(403, "Cross-site request blocked.");
        try {
          const { db, user, env } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          const { bytes, mime } = await generateImage({
            db,
            userId: user.id,
            ai: env.AI,
            prompt: body.prompt,
          });
          return new Response(bytes as BodyInit, {
            headers: { "Content-Type": mime, "Cache-Control": "no-store" },
          });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("image route failed", e);
          return fail(500, "Something went wrong. Please try again.");
        }
      },
    },
  },
});
