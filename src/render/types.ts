// Types for the in-browser video rendering engine. Pure data: no DOM types, so it is testable in Node.

export type TransitionKind =
  "none" | "crossfade" | "fade-black" | "slide-left" | "slide-right" | "zoom" | "wipe";
export const TRANSITIONS: { key: TransitionKind; label: string }[] = [
  { key: "crossfade", label: "Crossfade" },
  { key: "fade-black", label: "Dip to black" },
  { key: "slide-left", label: "Slide left" },
  { key: "slide-right", label: "Slide right" },
  { key: "zoom", label: "Zoom" },
  { key: "wipe", label: "Wipe" },
  { key: "none", label: "Cut (none)" },
];

export type Motion = "none" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right";

/** One scene as the user/AI describes it. */
export type SceneInput = {
  id: string;
  /** Narration for this scene. Used for voiceover text and subtitles. */
  narration: string;
  /** Exact length of this scene's generated voiceover in seconds, or null when there is none. */
  voiceSeconds: number | null;
  /** Transition used when ENTERING this scene (ignored for the first scene). */
  transition: TransitionKind;
  motion: Motion;
  /** Large on-screen text (title cards, key phrases). */
  overlayText?: string | undefined;
};

export type TimelineScene = SceneInput & {
  start: number;
  end: number;
  duration: number;
  /** Seconds of overlap with the previous scene (the transition length). */
  transitionSec: number;
  /** When this scene's voiceover starts, on the global timeline. */
  voiceStart: number;
  /** How long the voiceover (or the reading-pace estimate) lasts. */
  voiceDuration: number;
};

export type Timeline = { scenes: TimelineScene[]; duration: number };

export type SubtitleCue = { start: number; end: number; text: string };

export type Preset = {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  note: string;
};

/** Something the renderer can draw for a scene. Images are static; video clips seek per frame. */
export interface VisualAsset {
  width: number;
  height: number;
  /** Make the asset ready for `localT` seconds into its scene (e.g. seek a video). */
  prepare(localT: number): Promise<void>;
  source(): CanvasImageSource;
  dispose(): void;
}
