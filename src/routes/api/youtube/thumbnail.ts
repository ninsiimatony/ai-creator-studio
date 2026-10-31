import { createFileRoute } from "@tanstack/react-router";
import { AppError } from "@/server/errors";
import { requireUser } from "@/server/context";
import { MAX_THUMBNAIL_BYTES, setThumbnail } from "@/server/youtube";

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Uploads a custom thumbnail (PNG/JPEG, <= 2 MB) for an approved, already-uploaded video.
// Same-origin only: this route is not covered by the server-function CSRF middleware.
export const Route = createFileRoute("/api/youtube/thumbnail")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        if (request.headers.get("origin") !== url.origin)
          return json(403, { error: "Cross-site request blocked." });
        try {
          const videoId = url.searchParams.get("videoId") ?? "";
          if (!videoId || videoId.length > 64) throw new AppError("Missing video.");
          const declared = Number(request.headers.get("content-length") ?? 0);
          if (declared > MAX_THUMBNAIL_BYTES)
            throw new AppError("Thumbnails must be 2 MB or smaller.");
          const { db, user, env } = await requireUser();
          const image = await request.arrayBuffer();
          await setThumbnail({
            db,
            env,
            userId: user.id,
            videoId,
            image,
            mimeType: request.headers.get("content-type")?.split(";")[0] ?? "",
          });
          return json(200, { ok: true });
        } catch (e) {
          if (e instanceof AppError) return json(400, { error: e.message });
          console.error("thumbnail upload failed", e);
          return json(500, { error: "Something went wrong. Please try again." });
        }
      },
    },
  },
});
