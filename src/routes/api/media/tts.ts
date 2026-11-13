import { createFileRoute } from "@tanstack/react-router";
import { aiFor } from "@/server/aipick";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { hasBotBearer, requireUserOrBot } from "@/server/context";
import { synthesizeSpeech } from "@/server/media";

const Body = z.object({ text: z.string().min(1).max(4000), lang: z.string().max(8).optional() });
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export const Route = createFileRoute("/api/media/tts")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request) && request.headers.get("origin") !== new URL(request.url).origin)
          return fail(403, "Cross-site request blocked.");
        try {
          const { db, user, env } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          const { bytes, mime } = await synthesizeSpeech({
            db,
            userId: user.id,
            ai: aiFor(env, request),
            text: body.text,
            ...(body.lang ? { lang: body.lang } : {}),
          });
          return new Response(bytes as BodyInit, {
            headers: { "Content-Type": mime, "Cache-Control": "no-store" },
          });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("tts route failed", e);
          return fail(500, "Something went wrong. Please try again.");
        }
      },
    },
  },
});
