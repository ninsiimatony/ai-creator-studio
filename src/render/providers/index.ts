import { CLIP_PROVIDERS } from "./clips";
import { IMAGE_PROVIDERS } from "./images";
import { MUSIC_PROVIDERS } from "./music";
import { VOICE_PROVIDERS } from "./voices";
import type { Availability, MediaEnv, ProviderInfo } from "./types";

export * from "./types";
export { VOICE_PROVIDERS, IMAGE_PROVIDERS, CLIP_PROVIDERS, MUSIC_PROVIDERS };
export { decodeAudioFile } from "./music";

export type ProviderRow = { id: string; label: string; cost: string; availability: Availability };

/** Every provider of a kind with its current availability, for display. */
export function describeProviders(list: ProviderInfo[], env: MediaEnv): ProviderRow[] {
  return list.map((p) => ({
    id: p.id,
    label: p.label,
    cost: p.cost,
    availability: p.availability(env),
  }));
}

export function findProvider<T extends ProviderInfo>(list: T[], id: string): T | undefined {
  return list.find((p) => p.id === id);
}
