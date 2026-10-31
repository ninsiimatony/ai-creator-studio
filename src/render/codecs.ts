// Chooses the best codecs this browser can encode. YouTube's recommendation is H.264 + AAC in MP4.
import type { Preset } from "./types";

export type VideoChoice = { webcodecs: string; mux: "avc" | "vp9" | "av1"; label: string };
export type AudioChoice = { webcodecs: string; mux: "aac" | "opus"; label: string };
export type CodecChoice = {
  video: VideoChoice;
  audio: AudioChoice;
  /** True when the file is H.264 + AAC (YouTube's recommended combination). */
  youtubeRecommended: boolean;
  warnings: string[];
};

export function supportsRendering(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof OfflineAudioContext !== "undefined"
  );
}

/** H.264 level string for a frame size (High profile). */
export function avcCodecFor(width: number, height: number): string {
  const px = width * height;
  if (px <= 1280 * 720) return "avc1.64001f"; // level 3.1
  if (px <= 1920 * 1088) return "avc1.640028"; // level 4.0
  return "avc1.640033"; // level 5.1 (1440p and up)
}

export async function pickCodecs(preset: Preset, sampleRate = 48000): Promise<CodecChoice> {
  if (!supportsRendering()) {
    throw new Error(
      "This browser cannot render video (it needs WebCodecs). Use a current Chrome, Edge or Safari on a computer.",
    );
  }
  const base = {
    width: preset.width,
    height: preset.height,
    bitrate: preset.videoBitrate,
    framerate: preset.fps,
  };
  const videoCandidates: VideoChoice[] = [
    { webcodecs: avcCodecFor(preset.width, preset.height), mux: "avc", label: "H.264" },
    { webcodecs: "vp09.00.40.08", mux: "vp9", label: "VP9" },
    { webcodecs: "av01.0.08M.08", mux: "av1", label: "AV1" },
  ];
  let video: VideoChoice | undefined;
  for (const c of videoCandidates) {
    try {
      if ((await VideoEncoder.isConfigSupported({ ...base, codec: c.webcodecs })).supported) {
        video = c;
        break;
      }
    } catch {
      /* try the next one */
    }
  }
  if (!video)
    throw new Error("This browser cannot encode video at this size. Try 720p or another browser.");

  const abase = { sampleRate, numberOfChannels: 2, bitrate: preset.audioBitrate };
  const audioCandidates: AudioChoice[] = [
    { webcodecs: "mp4a.40.2", mux: "aac", label: "AAC" },
    { webcodecs: "opus", mux: "opus", label: "Opus" },
  ];
  let audio: AudioChoice | undefined;
  for (const c of audioCandidates) {
    try {
      if ((await AudioEncoder.isConfigSupported({ ...abase, codec: c.webcodecs })).supported) {
        audio = c;
        break;
      }
    } catch {
      /* try the next one */
    }
  }
  if (!audio) throw new Error("This browser cannot encode audio. Try Chrome, Edge or Safari.");

  const youtubeRecommended = video.mux === "avc" && audio.mux === "aac";
  const warnings: string[] = [];
  if (!youtubeRecommended) {
    warnings.push(
      `This browser encodes ${video.label} + ${audio.label}, not YouTube's recommended H.264 + AAC. YouTube re-encodes uploads anyway and accepts this, but for the standard format use Chrome, Edge or Safari on a computer.`,
    );
  }
  return { video, audio, youtubeRecommended, warnings };
}
