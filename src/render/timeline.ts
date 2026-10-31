// Builds the timeline. Voice/picture sync is exact by construction: every scene is voiced on its own,
// so a scene lasts precisely as long as its audio (plus a short lead-in and tail), with no estimating.
import type { SceneInput, Timeline, TimelineScene } from "./types";

export type TimelineOptions = {
  /** Reading pace used for scenes without voiceover. */
  wpm?: number;
  /** Silence before the voice starts, after the scene begins. */
  leadSec?: number;
  /** Minimum pause after the voice ends, before the next scene. */
  tailSec?: number;
  /** Length of an overlapping transition. */
  transitionSec?: number;
  /** Shortest a scene may be. */
  minSceneSec?: number;
};

export const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Estimated spoken length of text at `wpm` words per minute. */
export const readingSeconds = (text: string, wpm = 150) => (countWords(text) / wpm) * 60;

export function buildTimeline(scenes: SceneInput[], opts: TimelineOptions = {}): Timeline {
  const wpm = opts.wpm ?? 150;
  const lead = opts.leadSec ?? 0.25;
  const tailMin = opts.tailSec ?? 0.4;
  const T = Math.max(0, opts.transitionSec ?? 0.6);
  const minScene = opts.minSceneSec ?? 2.5;

  const out: TimelineScene[] = [];
  let prevEnd = 0;
  scenes.forEach((s, i) => {
    const transitionSec = i === 0 || s.transition === "none" ? 0 : T;
    const voiceDuration = s.voiceSeconds ?? readingSeconds(s.narration, wpm);
    // The tail must be long enough that the next scene's transition never overlaps this scene's speech.
    const tail = Math.max(tailMin, T);
    const duration = Math.max(minScene, lead + voiceDuration + tail);
    const start = i === 0 ? 0 : prevEnd - transitionSec;
    const end = start + duration;
    out.push({
      ...s,
      start,
      end,
      duration,
      transitionSec,
      voiceStart: start + lead,
      voiceDuration,
    });
    prevEnd = end;
  });
  return { scenes: out, duration: out.length ? out[out.length - 1]!.end : 0 };
}

/** Index of the scene that is on screen at `t` (the incoming one during a transition). */
export function sceneIndexAt(tl: Timeline, t: number): number {
  let idx = 0;
  for (let i = 0; i < tl.scenes.length; i++) {
    if (t >= tl.scenes[i]!.start) idx = i;
    else break;
  }
  return idx;
}

/**
 * Splits narration into scene-sized chunks (one or more sentences, about `targetWords` each).
 * Used when there is no storyboard to take scenes from.
 */
export function autoSplitScenes(narration: string, targetWords = 28): string[] {
  const sentences =
    narration
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  const chunks: string[] = [];
  let cur: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const w = countWords(s);
    if (cur.length && words + w > targetWords * 1.4) {
      chunks.push(cur.join(" "));
      cur = [];
      words = 0;
    }
    cur.push(s);
    words += w;
    if (words >= targetWords) {
      chunks.push(cur.join(" "));
      cur = [];
      words = 0;
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}
