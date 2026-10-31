import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { getScript } from "@/server/repo";
import { chunkNarration, synthesizePart } from "@/server/voiceover";

const Body = z.object({
  scriptId: z.string().min(1).max(64),
  part: z.number().int().min(0).max(50),
  voiceId: z.string().trim().max(64).optional(),
});

const json = (status: number, message: string) =>
  Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });

// Streams one part of a script's narration as MP3. Same-origin POST only (this route is not
// covered by the server-function CSRF middleware, so the Origin is checked here).
export const Route = createFileRoute("/api/voiceover")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const origin = request.headers.get("origin");
        if (origin !== new URL(request.url).origin) return json(403, "Cross-site request blocked.");
        try {
          const { db, user, env } = await requireUser();
          const body = Body.parse(await request.json().catch(() => ({})));
          const script = await getScript(db, user.id, body.scriptId);
          const parts = chunkNarration(script.body);
          const text = parts[body.part];
          if (!text) throw new AppError("There is no such part of the narration.");
          const { audio } = await synthesizePart({
            db,
            userId: user.id,
            apiKey: env.ELEVENLABS_API_KEY,
            voiceId: body.voiceId || env.ELEVENLABS_VOICE_ID,
            text,
          });
          return new Response(audio, {
            headers: {
              "Content-Type": "audio/mpeg",
              "Cache-Control": "no-store",
              "X-Voiceover-Parts": String(parts.length),
            },
          });
        } catch (e) {
          if (e instanceof AppError) return json(400, e.message);
          if (e instanceof z.ZodError) return json(400, "Invalid request.");
          console.error("voiceover failed", e);
          return json(500, "Something went wrong. Please try again.");
        }
      },
    },
  },
});
