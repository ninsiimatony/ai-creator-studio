import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { hasBotBearer, requireUserOrBot } from "@/server/context";
import { fetchStockClip } from "@/server/stock";
import { getNote, setNote } from "@/server/topicgen";

const Body = z.object({
  text: z.string().min(1).max(500),
  index: z.number().int().min(0).max(1000).optional(),
  query: z.string().max(100).optional(),
  style: z.enum(["real", "cartoon"]).optional(),
  small: z.boolean().optional(),
  strict: z.boolean().optional(),
});
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Same-origin only (not covered by the server-function CSRF middleware), session required.
export const Route = createFileRoute("/api/media/stock-clip")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request) && request.headers.get("origin") !== new URL(request.url).origin)
          return fail(403, "Cross-site request blocked.");
        try {
          const { env, db } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          // Strict (cartoon-only) requests remember every animation clip used, so no clip is ever reused.
          let used: number[] = [];
          if (body.strict) {
            try {
              used = JSON.parse((await getNote(db, "used_anim_clips")) || "[]");
            } catch {
              used = [];
            }
          }
          const { bytes, mime, id } = await fetchStockClip({
            apiKey: env.PIXABAY_API_KEY,
            text: body.text,
            ...(body.index !== undefined ? { index: body.index } : {}),
            ...(body.query ? { query: body.query } : {}),
            ...(body.style ? { style: body.style } : {}),
            ...(body.small ? { small: true } : {}),
            ...(body.strict ? { strict: true, exclude: used } : {}),
          });
          if (body.strict && id !== undefined) {
            try {
              await setNote(db, "used_anim_clips", JSON.stringify([...used, id].slice(-3000)));
            } catch {
              /* remembering is best-effort */
            }
          }
          return new Response(bytes as BodyInit, {
            headers: { "Content-Type": mime, "Cache-Control": "no-store", ...(id !== undefined ? { "x-clip-id": String(id) } : {}) },
          });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("stock clip route failed", e);
          return fail(500, "Something went wrong. Please try again.");
        }
      },
    },
  },
});
