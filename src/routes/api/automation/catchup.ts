import { createFileRoute } from "@tanstack/react-router";
import { hasBotBearer, requireUserOrBot } from "@/server/context";
import { runCatchup } from "@/server/catchup";

// Manual trigger (same check the 15-minute timer runs). Only the bot secret can call it.
export const Route = createFileRoute("/api/automation/catchup")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
        const { env } = await requireUserOrBot(request);
        return Response.json({ result: await runCatchup(env) }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
