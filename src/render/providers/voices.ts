import { OK, unavailable, type VoiceProvider } from "./types";
import { postForBlob } from "./http";

/** ElevenLabs via our server (the key never reaches the browser). Uses the user's own ElevenLabs credits. */
export const elevenLabsVoice: VoiceProvider = {
  id: "elevenlabs",
  label: "ElevenLabs (high quality)",
  cost: "Uses credits from your ElevenLabs plan.",
  availability: (env) =>
    !env.server
      ? unavailable("Needs the database (unavailable in demo mode).")
      : env.elevenlabs
        ? OK
        : unavailable("Not connected: the ELEVENLABS_API_KEY secret has not been added."),
  async synthesize(text, opts) {
    const blob = await postForBlob(
      "/api/voiceover",
      { text, ...(opts.voiceId ? { voiceId: opts.voiceId } : {}) },
      opts.signal,
    );
    return blob.arrayBuffer();
  },
};

/** Cloudflare Workers AI MeloTTS: free within Cloudflare's daily allowance. */
export const workersAiVoice: VoiceProvider = {
  id: "workers-ai-melotts",
  label: "Cloudflare MeloTTS (free)",
  cost: "Free within Cloudflare's daily allowance (about $0.0002 per audio minute beyond it).",
  availability: (env) =>
    !env.server
      ? unavailable("Needs the database (unavailable in demo mode).")
      : env.workersAi
        ? OK
        : unavailable(
            "Not connected: the Workers AI binding is not configured on this deployment.",
          ),
  async synthesize(text, opts) {
    const blob = await postForBlob("/api/media/tts", { text, lang: "en" }, opts.signal);
    return blob.arrayBuffer();
  },
};

export const VOICE_PROVIDERS: VoiceProvider[] = [workersAiVoice, elevenLabsVoice];
