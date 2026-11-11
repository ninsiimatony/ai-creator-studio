import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { hasBotBearer, requireUserOrBot } from "@/server/context";
import { fetchDocClip } from "@/server/clips";
import { getNote, setNote } from "@/server/topicgen";

const Body = z.object({
  text: z.string().min(1).max(500),
  index: z.number().int().min(0).max(1000).optional(),
  query: z.string().max(100).optional(),
});
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Channel 3 clips from several free sources (Pexels, Pixabay, NASA, Internet Archive, Wikimedia). Bot or signed-in user only.
export const Route = createFileRoute("/api/media/doc-clip")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!hasBotBearer(request) && request.headers.get("origin") !== new URL(request.url).origin)
          return fail(403, "Cross-site request blocked.");
        try {
          const { env, db } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          let used: string[] = [];
          try {
            used = JSON.parse((await getNote(db, "used_doc_clips")) || "[]") as string[];
          } catch {
            used = [];
          }
          const clip = await fetchDocClip({
            pexelsKey: env.PEXELS_API_KEY,
            pixabayKey: env.PIXABAY_API_KEY,
            text: body.text,
            ...(body.index !== undefined ? { index: body.index } : {}),
            ...(body.query ? { query: body.query } : {}),
            exclude: used,
          });
          try {
            await setNote(db, "used_doc_clips", JSON.stringify([...used, clip.key].slice(-3000)));
          } catch {
            /* remembering is best-effort */
          }
          return new Response(clip.bytes as BodyInit, {
            headers: {
              "Content-Type": clip.mime,
              "Cache-Control": "no-store",
              "x-clip-source": clip.source,
              "x-clip-credit": encodeURIComponent(clip.credit).slice(0, 200),
            },
          });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("doc clip route failed", e);
          return fail(500, "Something went wrong. Please try again.");
        }
      },
    },
  },
});
