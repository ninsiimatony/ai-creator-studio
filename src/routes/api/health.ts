import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/server/db";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const db = await getDb();
        if (!db) return Response.json({ ok: true, database: "unavailable (demo mode)" });
        const row = await db.prepare("SELECT note FROM spike WHERE id = 1").first<{ note: string }>();
        return Response.json({ ok: true, database: "d1", note: row?.note ?? null });
      },
    },
  },
});
