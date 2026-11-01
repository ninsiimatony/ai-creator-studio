import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { requireUserOrBot, hasBotBearer } from "@/server/context";
import { sendTelegram } from "@/server/bot";

const Body = z.object({ text: z.string().min(1).max(3900) });
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// The GitHub video job reports back here; we forward the message to the owner's Telegram chat.
export const Route = createFileRoute("/api/automation/notify")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return fail(403, "Not allowed.");
        try {
          const { env } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
            throw new AppError("Telegram is not set up.");
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, body.text);
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("notify route failed", e);
          return fail(500, "Something went wrong.");
        }
      },
    },
  },
});
