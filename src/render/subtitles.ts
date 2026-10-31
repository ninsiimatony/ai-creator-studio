// Automatic subtitles. Each scene is voiced separately, so a scene's voice window is exact; inside the
// window, text is split into short phrases timed in proportion to their length. That is accurate to the
// scene and a close estimate within it (it is not word-level forced alignment).
import type { SubtitleCue, Timeline } from "./types";

/** Wraps text onto lines of at most `max` characters (words are never split unless longer than `max`). */
export function wrapLines(text: string, max = 42): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= max) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Splits narration into phrases that fit on at most `maxLines` lines. Prefers sentence/clause breaks. */
export function splitPhrases(text: string, maxChars = 42, maxLines = 2): string[] {
  const limit = maxChars * maxLines;
  const pieces =
    text
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?;:,—]+[.!?;:,—]*\s*/g)
      ?.map((p) => p.trim())
      .filter(Boolean) ?? [];
  const phrases: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) phrases.push(cur);
    cur = "";
  };
  for (const piece of pieces) {
    if (piece.length > limit) {
      flush();
      // A very long clause: break it on word boundaries.
      let chunk = "";
      for (const w of piece.split(" ")) {
        if ((chunk + " " + w).trim().length > limit) {
          phrases.push(chunk.trim());
          chunk = w;
        } else chunk = (chunk + " " + w).trim();
      }
      if (chunk) phrases.push(chunk.trim());
    } else if (!cur) cur = piece;
    else if ((cur + " " + piece).length <= limit) cur += " " + piece;
    else {
      flush();
      cur = piece;
    }
  }
  flush();
  return phrases;
}

export type CueOptions = { maxChars?: number; maxLines?: number; minCueSec?: number };

export function buildSubtitleCues(tl: Timeline, opts: CueOptions = {}): SubtitleCue[] {
  const maxChars = opts.maxChars ?? 42;
  const maxLines = opts.maxLines ?? 2;
  const minCue = opts.minCueSec ?? 0.8;
  const cues: SubtitleCue[] = [];
  for (const sc of tl.scenes) {
    const phrases = splitPhrases(sc.narration, maxChars, maxLines);
    if (phrases.length === 0 || sc.voiceDuration <= 0) continue;
    const weights = phrases.map((p) => Math.max(1, p.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = sc.voiceStart;
    phrases.forEach((p, i) => {
      const len = (weights[i]! / total) * sc.voiceDuration;
      const end = i === phrases.length - 1 ? sc.voiceStart + sc.voiceDuration : t + len;
      cues.push({ start: t, end, text: wrapLines(p, maxChars).join("\n") });
      t = end;
    });
  }
  // Avoid flicker: stretch very short cues into the silence that follows them, when there is room.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const next = cues[i + 1];
    if (c.end - c.start < minCue) c.end = Math.min(c.start + minCue, next ? next.start : Infinity);
  }
  return cues;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function stamp(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(cues: SubtitleCue[]): string {
  return (
    "WEBVTT\n\n" +
    cues.map((c) => `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${c.text}\n`).join("\n")
  );
}

/** The cue visible at time `t`, if any. */
export function cueAt(cues: SubtitleCue[], t: number): SubtitleCue | undefined {
  return cues.find((c) => t >= c.start && t < c.end);
}
