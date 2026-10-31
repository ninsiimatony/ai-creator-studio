import { unavailable, type ClipProvider } from "./types";

/** A slot for an AI video generator that is known to exist but is deliberately NOT connected. */
function notConnected(id: string, label: string, cost: string, reason: string): ClipProvider {
  return {
    id,
    label,
    cost,
    availability: () => unavailable(reason),
    async generate() {
      throw new Error(`${label} is not connected. ${reason}`);
    },
  };
}

/**
 * AI video-clip generators. None is connected: every hosted generator is a paid, per-second service, and this
 * project does not switch on paid services without an explicit decision. Upload your own clips per scene instead
 * (always available), or implement ClipProvider for the service you choose and add it here.
 */
export const CLIP_PROVIDERS: ClipProvider[] = [
  notConnected(
    "cloudflare-video",
    "Cloudflare Workers AI video models (PixVerse, Veo, Seedance, …)",
    "Paid, billed per second by Cloudflare (roughly $0.03 - $0.12 per second of video).",
    "Not enabled: these models bill per second and nothing here turns on paid usage by itself.",
  ),
];
