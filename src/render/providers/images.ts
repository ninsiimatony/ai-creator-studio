import { canvasAsset, imageAsset, makeTitleCard } from "../assets";
import { OK, unavailable, type ImageProvider } from "./types";
import { postForBlob } from "./http";

/** Always available and free: the studio's navy/teal gradient with the scene title. Needs no AI or network. */
export const titleCardImage: ImageProvider = {
  id: "title-card",
  label: "Title cards (free, no AI)",
  cost: "Free.",
  availability: () => OK,
  async generate(req) {
    return canvasAsset(
      makeTitleCard({ title: req.title, width: req.width, height: req.height, index: req.index }),
    );
  },
};

/** Cloudflare Workers AI FLUX-1-schnell: free within Cloudflare's daily allowance (about 230 images/day). */
export const workersAiImage: ImageProvider = {
  id: "workers-ai-flux",
  label: "Cloudflare FLUX-1-schnell (free AI images)",
  cost: "Free within Cloudflare's daily allowance (about 43 neurons of the 10,000 free per day, per image).",
  availability: (env) =>
    !env.server
      ? unavailable("Needs the database (unavailable in demo mode).")
      : env.workersAi
        ? OK
        : unavailable(
            "Not connected: the Workers AI binding is not configured on this deployment.",
          ),
  async generate(req) {
    const blob = await postForBlob("/api/media/image", { prompt: req.prompt }, req.signal);
    return imageAsset(blob);
  },
};

export const IMAGE_PROVIDERS: ImageProvider[] = [titleCardImage, workersAiImage];
