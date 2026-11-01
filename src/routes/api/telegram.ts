import { createFileRoute } from "@tanstack/react-router";
import { requireDb } from "@/server/context";
import { safeEqualStrings } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { dispatchVideoJob, parseVideoRequest, sendTelegram } from "@/server/bot";

type Update = { message?: { chat?: { id?: number }; text?: string } };

const HELP =
  "Tell me what video to make, for example:\n" +
  "• make a 10 minute video about how robots learn to walk\n" +
  "• 1 hour cartoon video about the history of coffee\n" +
  "• 30 min video: why AI makes mistakes\n\n" +
  "Lengths: 3 to 90 minutes. Say \"cartoon\" for animation clips. I upload it to your YouTube as PRIVATE and send you the link. You press Publish yourself.";

// Telegram webhook. Only Telegram (secret header) can call it, and only the owner's chat is obeyed.
export const Route = createFileRoute("/api/telegram")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { env } = await requireDb().catch(() => ({ env: null }));
        const ok = Response.json({ ok: true });
        if (!env?.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET)
          return new Response("Not configured", { status: 503 });
        const given = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (!safeEqualStrings(given, env.TELEGRAM_WEBHOOK_SECRET))
          return new Response("Forbidden", { status: 403 });

        const update = (await request.json().catch(() => ({}))) as Update;
        const chatId = update.message?.chat?.id;
        const text = update.message?.text?.trim();
        if (chatId === undefined || !text) return ok;
        const token = env.TELEGRAM_BOT_TOKEN;
        const reply = (t: string) => sendTelegram(token, String(chatId), t);

        if (!env.TELEGRAM_CHAT_ID) {
          await reply(
            `Hello! Your chat number is ${chatId}.\nAdd it to your studio as the secret TELEGRAM_CHAT_ID, then message me again.`,
          );
          return ok;
        }
        if (String(chatId) !== env.TELEGRAM_CHAT_ID) return ok; // strangers get no answer at all

        if (/^\/(start|help)\b/i.test(text)) {
          await reply(HELP);
          return ok;
        }
        const req = parseVideoRequest(text);
        if (!req) {
          await reply(HELP);
          return ok;
        }
        if (!env.GITHUB_TOKEN || !env.AUTOMATION_SECRET) {
          await reply("The video job is not set up yet (missing GITHUB_TOKEN or AUTOMATION_SECRET).");
          return ok;
        }
        try {
          await dispatchVideoJob({
            token: env.GITHUB_TOKEN,
            repo: "ninsiimatony/ai-creator-studio",
            ref: "main",
            req,
          });
          await reply(
            `Got it ✅\nTopic: ${req.topic}\nLength: ${req.minutes} min · Style: ${req.style === "cartoon" ? "cartoon" : "real footage"}\n\nMaking it now. A long video can take an hour or more. I will message you with the YouTube link.`,
          );
        } catch (e) {
          await reply(e instanceof AppError ? e.message : "Could not start the video. Try again.");
        }
        return ok;
      },
    },
  },
});
