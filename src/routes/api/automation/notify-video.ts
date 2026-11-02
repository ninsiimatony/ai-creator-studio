import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUserOrBot, hasBotBearer } from "@/server/context";

const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
const MAX_BYTES = 48 * 1024 * 1024; // Telegram bots can send files up to 50 MB

// The GitHub video job sends the finished Short here (raw MP4 body, caption in the query string);
// we forward it to the owner's Telegram chat so it can be posted to TikTok.
export const Route = createFileRoute("/api/automation/notify-video")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return fail(403, "Not allowed.");
        try {
          const { env } = await requireUserOrBot(request);
          if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID)
            throw new AppError("Telegram is not set up.");
          const caption = (new URL(request.url).searchParams.get("caption") ?? "").slice(0, 1000);
          const bytes = await request.arrayBuffer();
          if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
            throw new AppError("The video is empty or too large for Telegram.");
          const form = new FormData();
          form.append("chat_id", env.TELEGRAM_CHAT_ID);
          form.append("caption", caption);
          form.append("supports_streaming", "true");
          form.append("video", new Blob([bytes], { type: "video/mp4" }), "short.mp4");
          const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVideo`, {
            method: "POST",
            body: form,
          });
          if (!res.ok) {
            console.error("telegram sendVideo failed", res.status, (await res.text()).slice(0, 200));
            throw new AppError("Telegram did not accept the video.");
          }
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          console.error("notify-video route failed", e);
          return fail(500, "Something went wrong.");
        }
      },
    },
  },
});
