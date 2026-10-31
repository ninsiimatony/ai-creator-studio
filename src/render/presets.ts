import type { Preset } from "./types";

// Bitrates follow YouTube's recommended upload bitrates for SDR at 24-30 fps.
export const PRESETS: Preset[] = [
  {
    id: "1080p",
    label: "1080p HD (16:9)",
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrate: 8_000_000,
    audioBitrate: 192_000,
    note: "Standard YouTube upload.",
  },
  {
    id: "720p",
    label: "720p (16:9)",
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrate: 5_000_000,
    audioBitrate: 192_000,
    note: "Faster to render, smaller file.",
  },
  {
    id: "1440p",
    label: "1440p QHD (16:9)",
    width: 2560,
    height: 1440,
    fps: 30,
    videoBitrate: 16_000_000,
    audioBitrate: 192_000,
    note: "Sharper, but slow in a browser.",
  },
  {
    id: "shorts",
    label: "YouTube Shorts (9:16)",
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrate: 8_000_000,
    audioBitrate: 192_000,
    note: "Vertical, up to 3 minutes.",
  },
];

export const getPreset = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
