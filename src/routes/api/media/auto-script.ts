import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppError } from "@/server/errors";
import { hasBotBearer, requireUserOrBot } from "@/server/context";
import { writeOutline, writePolicyCheck, writeSceneTerms, writeSection } from "@/server/autoscript";

const Body = z.discriminatedUnion("step", [
  z.object({
    step: z.literal("outline"),
    topic: z.string().min(3).max(500),
    minutes: z.number().int().min(1).max(90),
    tone: z.enum(["emotional"]).optional(),
  }),
  z.object({
    step: z.literal("section"),
    topic: z.string().min(3).max(500),
    title: z.string().min(1).max(200),
    sections: z.array(z.string().min(1).max(200)).min(1).max(50),
    index: z.number().int().min(0).max(49),
    style: z.enum(["real", "cartoon"]),
    tone: z.enum(["emotional"]).optional(),
  }),
  z.object({
    step: z.literal("policy"),
    title: z.string().min(1).max(300),
    description: z.string().max(5000),
    script: z.string().min(1).max(40000),
  }),
  z.object({
    step: z.literal("scenes"),
    scenes: z.array(z.string().min(1).max(600)).min(1).max(40),
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
        if (!hasBotBearer(request) && request.headers.get("origin") !== new URL(request.url).origin)
          return fail(403, "Cross-site request blocked.");
        try {
          const { db, user, env } = await requireUserOrBot(request);
          const body = Body.parse(await request.json().catch(() => ({})));
          const out =
            body.step === "policy"
              ? await writePolicyCheck({ ai: env.AI, title: body.title, description: body.description, script: body.script })
              : body.step === "scenes"
              ? await writeSceneTerms({ db, userId: user.id, ai: env.AI, scenes: body.scenes, style: body.style })
              : body.step === "outline"
              ? await writeOutline({ db, userId: user.id, ai: env.AI, topic: body.topic, minutes: body.minutes, tone: body.tone })
              : await writeSection({
                  db,
                  userId: user.id,
                  ai: env.AI,
                  topic: body.topic,
                  title: body.title,
                  sections: body.sections,
                  index: body.index,
                  style: body.style,
                  tone: body.tone,
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
