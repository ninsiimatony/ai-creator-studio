import { createFileRoute } from "@tanstack/react-router";
import { requireUserOrBot, hasBotBearer } from "@/server/context";

/** Next 00:10 UTC (just after the free Workers AI allowance resets). */
export function nextResetIso(now = new Date()): string {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 10, 0));
  return t.toISOString();
}

// The video job calls this when the free daily AI allowance is used up, so the catch-up stops starting
// videos that would only fail, until just after the allowance resets.
export const Route = createFileRoute("/api/automation/pause")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request)) return Response.json({ error: "Not allowed." }, { status: 403 });
        try {
          const { env } = await requireUserOrBot(request);
          const until = nextResetIso();
          if (!env.DB) throw new Error("no database");
          await env.DB.prepare("INSERT INTO app_notes (key, value) VALUES ('pause_dispatch_until', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(until).run();
          return Response.json({ ok: true, until }, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          console.error("pause route failed", e);
          return Response.json({ error: "Something went wrong." }, { status: 500 });
        }
      },
    },
  },
});
