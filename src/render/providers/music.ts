import { generateAmbientLoop } from "../audio";
import { OK, type MusicProvider } from "./types";

/** A free, royalty-free ambient pad generated from code (not an AI composition). */
export const ambientMusic: MusicProvider = {
  id: "ambient",
  label: "Generated ambient pad (free, royalty-free)",
  cost: "Free.",
  availability: () => OK,
  generate: ({ sampleRate }) => generateAmbientLoop(sampleRate),
};

export const noMusic: MusicProvider = {
  id: "none",
  label: "No music",
  cost: "Free.",
  availability: () => OK,
  generate: async () => null,
};

/** Decodes an audio file the user supplies (they must have the rights to use it). */
export async function decodeAudioFile(file: Blob, sampleRate = 48000): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, 1, sampleRate);
  return ctx.decodeAudioData(await file.arrayBuffer());
}

export const MUSIC_PROVIDERS: MusicProvider[] = [ambientMusic, noMusic];
