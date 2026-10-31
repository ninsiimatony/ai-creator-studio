// Provider interfaces. To connect a new AI service, implement one of these and add it to the registry in
// index.ts; the renderer and UI need no other change. Providers never pretend to work: availability() says
// plainly why one cannot be used right now.
import type { VisualAsset } from "../types";

/** What the signed-in server says is configured (from the integrations endpoint). */
export type MediaEnv = {
  /** Running with the database (false in demo mode, where no server-side provider can be called). */
  server: boolean;
  elevenlabs: boolean;
  workersAi: boolean;
};

export type Availability = { ok: true } | { ok: false; reason: string };

export type ProviderInfo = {
  id: string;
  label: string;
  /** Plain-language cost, so there are no surprises. */
  cost: string;
  availability(env: MediaEnv): Availability;
};

export interface VoiceProvider extends ProviderInfo {
  /** Returns encoded audio (MP3/WAV/...) for the text, decodable by the browser. */
  synthesize(text: string, opts: { voiceId?: string; signal?: AbortSignal }): Promise<ArrayBuffer>;
}

export interface ImageProvider extends ProviderInfo {
  generate(req: {
    prompt: string;
    title: string;
    width: number;
    height: number;
    index: number;
    signal?: AbortSignal;
  }): Promise<VisualAsset>;
}

export interface ClipProvider extends ProviderInfo {
  /** Generates a short video clip for a prompt. Only providers that are actually connected implement this. */
  generate(req: {
    prompt: string;
    seconds: number;
    width: number;
    height: number;
    signal?: AbortSignal;
  }): Promise<VisualAsset>;
}

export interface MusicProvider extends ProviderInfo {
  /** Returns a music bed (it will be looped and ducked under the voice), or null for none. */
  generate(opts: { sampleRate: number }): Promise<AudioBuffer | null>;
}

export const OK: Availability = { ok: true };
export const unavailable = (reason: string): Availability => ({ ok: false, reason });
