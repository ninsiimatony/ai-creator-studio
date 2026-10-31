import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/server/db";

// Reports whether a database is bound and answering. Exposes no data.
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        if (!db) return Response.json({ ok: true, database: "unavailable (demo mode)" });
        try {
          await db.prepare("SELECT 1").first();
          return Response.json({ ok: true, database: "d1" });
        } catch {
          return Response.json({ ok: false, database: "error" }, { status: 503 });
        }
      },
    },
  },
});
