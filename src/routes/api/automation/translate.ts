import { createFileRoute } from "@tanstack/react-router";
import { aiFor } from "@/server/aipick";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { requireUserOrBot, hasBotBearer } from "@/server/context";
import { translateAll } from "@/server/translate";

const Body = z.object({
  texts: z.array(z.string().min(1).max(1200)).min(1).max(4),
  langs: z.array(z.string().regex(/^[a-z]{2}$/)).min(1).max(8),
});
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// The GitHub video job asks for translated titles/descriptions here (free Workers AI translation model).
export const Route = createFileRoute("/api/automation/translate")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return fail(403, "Not allowed.");
        try {
          const { env } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          const ai = aiFor(env, request);
          if (!ai) throw new AppError("The free AI is not available.");
          const out = await translateAll(ai, body.texts, body.langs);
          return Response.json({ ok: true, translations: out }, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("translate route failed", e);
          return fail(500, "Something went wrong.");
        }
      },
    },
  },
});
