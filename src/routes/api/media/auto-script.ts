import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { writeOutline, writeSection } from "@/server/autoscript";

const Body = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("outline"),
    topic: z.string().min(3).max(500),
    minutes: z.number().int().min(1).max(90),
  }),
  z.object({
    step: z.literal("section"),
    topic: z.string().min(3).max(500),
    title: z.string().min(1).max(200),
    sections: z.array(z.string().min(1).max(200)).min(1).max(50),
    index: z.number().int().min(0).max(49),
    style: z.enum(["real", "cartoon"]),
  }),
]);
const fail = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

// Same-origin only, session required.
export const Route = createFileRoute("/api/media/auto-script")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (request.headers.get("origin") !== new URL(request.url).origin)
          return fail(403, "Cross-site request blocked.");
        try {
          const { db, user, env } = await requireUser();
          const body = Body.parse(await request.json().catch(() => ({})));
          const out =
            body.step === "outline"
              ? await writeOutline({ db, userId: user.id, ai: env.AI, topic: body.topic, minutes: body.minutes })
              : await writeSection({
                  db,
                  userId: user.id,
                  ai: env.AI,
                  topic: body.topic,
                  title: body.title,
                  sections: body.sections,
                  index: body.index,
                  style: body.style,
                });
          return Response.json(out, { headers: { "Cache-Control": "no-store" } });
        } catch (e) {
          if (e instanceof AppError) return fail(400, e.message);
          if (e instanceof z.ZodError) return fail(400, "Invalid request.");
          console.error("auto script route failed", e);
          return fail(500, "Something went wrong. Please try again.");
        }
      },
    },
  },
});
