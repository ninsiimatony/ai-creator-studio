import { createFileRoute } from "@tanstack/react-router";
import { hasBotBearer, requireUserOrBot } from "@/server/context";
import { runWeeklyReport } from "@/server/growth";

// Manual trigger for the weekly report. Only the bot secret can call it.
export const Route = createFileRoute("/api/automation/growth-report")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
        const { env } = await requireUserOrBot(request);
        return Response.json({ result: await runWeeklyReport(env, true) }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
