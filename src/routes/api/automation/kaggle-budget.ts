import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { requireUserOrBot, hasBotBearer } from "@/server/context";
import { checkBudget, recordKaggleUsage } from "@/server/kaggle-budget";

const Body = z.union([
  z.object({ action: z.literal("check"), needHours: z.number().min(0).max(60) }),
  z.object({
    action: z.literal("record"),
    channel: z.number().int().min(1).max(3),
    hours: z.number().min(0).max(60),
    note: z.string().max(300).default(""),
  }),
]);
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Lets the GitHub video job check/record the weekly Kaggle GPU-hour budget for the optional
// LTX-Video upgrade (scripts/video-bot/kaggle-ltx.mjs). Never used by the browser.
export const Route = createFileRoute("/api/automation/kaggle-budget")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return fail(403, "Not allowed.");
        try {
          const { db } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          if (body.action === "check") {
            const res = await checkBudget(db, body.needHours);
            return Response.json(res, { headers: { "Cache-Control": "no-store" } });
          }
          await recordKaggleUsage(db, body.channel, body.hours, body.note);
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("kaggle-budget route failed", e);
          return fail(500, "Something went wrong.");
        }
      },
    },
  },
});
