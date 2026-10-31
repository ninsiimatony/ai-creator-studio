// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  autoSplitScenes,
  buildTimeline,
  countWords,
  readingSeconds,
  sceneIndexAt,
} from "@/render/timeline";
import {
  buildSubtitleCues,
  cueAt,
  splitPhrases,
  toSrt,
  toVtt,
  wrapLines,
} from "@/render/subtitles";
import { clamp01, drawTransition, easeInOut, motionRect, type Ctx } from "@/render/transitions";
import { duckingEnvelope, gainAt, mergeIntervals } from "@/render/audio";
import { PRESETS, getPreset } from "@/render/presets";
import { avcCodecFor } from "@/render/codecs";
import type { SceneInput, TransitionKind } from "@/render/types";

const scene = (
  id: string,
  narration: string,
  voiceSeconds: number | null,
  transition: TransitionKind = "crossfade",
): SceneInput => ({
  id,
  narration,
  voiceSeconds,
  transition,
  motion: "zoom-in",
});

describe("timeline and voice/picture sync", () => {
  it("makes each scene exactly as long as its voice plus lead and tail", () => {
    const tl = buildTimeline([scene("a", "Hello there.", 6), scene("b", "More words.", 8)], {
      leadSec: 0.25,
      transitionSec: 0.6,
      tailSec: 0.4,
    });
    const [a, b] = tl.scenes;
    expect(a!.duration).toBeCloseTo(0.25 + 6 + 0.6, 6); // tail = max(tailSec, transition)
    expect(a!.start).toBe(0);
    expect(a!.voiceStart).toBeCloseTo(0.25, 6);
    expect(b!.duration).toBeCloseTo(0.25 + 8 + 0.6, 6);
  });

  it("overlaps scenes by the transition length, never overlapping speech", () => {
    const tl = buildTimeline([scene("a", "x", 5), scene("b", "y", 5), scene("c", "z", 5, "none")], {
      transitionSec: 0.8,
    });
    const [a, b, c] = tl.scenes;
    expect(b!.start).toBeCloseTo(a!.end - 0.8, 6);
    expect(b!.transitionSec).toBe(0.8);
    expect(c!.transitionSec).toBe(0); // "none" = a hard cut
    expect(c!.start).toBeCloseTo(b!.end, 6);
    for (let i = 1; i < tl.scenes.length; i++) {
      const prev = tl.scenes[i - 1]!;
      const cur = tl.scenes[i]!;
      // Previous voice has finished before the next scene's voice begins.
      expect(prev.voiceStart + prev.voiceDuration).toBeLessThanOrEqual(cur.voiceStart + 1e-9);
    }
    expect(tl.duration).toBeCloseTo(c!.end, 6);
  });

  it("never applies a transition to the first scene", () => {
    const tl = buildTimeline([scene("a", "x", 3, "wipe")]);
    expect(tl.scenes[0]!.transitionSec).toBe(0);
    expect(tl.scenes[0]!.start).toBe(0);
  });

  it("paces scenes without voice from reading speed, with a minimum length", () => {
    const words = Array.from({ length: 150 }, () => "word").join(" ");
    expect(readingSeconds(words, 150)).toBeCloseTo(60, 6);
    const tl = buildTimeline([scene("a", words, null), scene("b", "Hi.", null)], {
      minSceneSec: 3,
    });
    expect(tl.scenes[0]!.voiceDuration).toBeCloseTo(60, 6);
    expect(tl.scenes[1]!.duration).toBe(3);
    expect(countWords("  a  b   c ")).toBe(3);
  });

  it("finds the scene on screen at a time (the incoming one during a transition)", () => {
    const tl = buildTimeline([scene("a", "x", 5), scene("b", "y", 5)], { transitionSec: 1 });
    expect(sceneIndexAt(tl, 0)).toBe(0);
    expect(sceneIndexAt(tl, tl.scenes[1]!.start)).toBe(1);
    expect(sceneIndexAt(tl, tl.scenes[1]!.start - 0.01)).toBe(0);
    expect(sceneIndexAt(tl, 999)).toBe(1);
    expect(buildTimeline([]).duration).toBe(0);
  });

  it("splits narration into scene-sized chunks without losing any text", () => {
    const text = Array.from(
      { length: 12 },
      (_, i) => `This is sentence number ${i} with some extra words in it.`,
    ).join(" ");
    const chunks = autoSplitScenes(text, 28);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.join(" ")).toBe(text);
    expect(autoSplitScenes("")).toEqual([]);
    expect(autoSplitScenes("No punctuation at all")).toEqual(["No punctuation at all"]);
  });
});

describe("subtitles", () => {
  it("wraps lines without splitting words", () => {
    expect(wrapLines("the quick brown fox jumps over the lazy dog", 15)).toEqual([
      "the quick brown",
      "fox jumps over",
      "the lazy dog",
    ]);
    expect(wrapLines("supercalifragilistic", 5)).toEqual(["supercalifragilistic"]);
    expect(wrapLines("")).toEqual([]);
  });

  it("splits narration into phrases that fit two lines", () => {
    const text =
      "Your assistant answered confidently, and it was completely wrong. Here is why that happens: models predict words, not facts.";
    const ph = splitPhrases(text, 42, 2);
    expect(ph.length).toBeGreaterThan(1);
    expect(ph.every((p) => p.length <= 84)).toBe(true);
    expect(ph.join(" ").replace(/\s+/g, " ")).toBe(text);
  });

  it("times cues inside each scene's voice window, in order, with no gaps in speech", () => {
    const tl = buildTimeline(
      [
        scene(
          "a",
          "First sentence is here. Second sentence follows right after it, longer than the first.",
          8,
        ),
        scene("b", "A short scene.", 3),
      ],
      { transitionSec: 0.6 },
    );
    const cues = buildSubtitleCues(tl);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    for (const c of cues) expect(c.end).toBeGreaterThan(c.start);
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end - 1e-9);
    const a = tl.scenes[0]!;
    const inA = cues.filter((c) => c.start < a.voiceStart + a.voiceDuration);
    expect(inA[0]!.start).toBeCloseTo(a.voiceStart, 6);
    expect(inA[inA.length - 1]!.end).toBeCloseTo(a.voiceStart + a.voiceDuration, 6);
    // Time is shared in proportion to length: seconds-per-character is the same for every cue in the scene.
    const perChar = inA.map((c) => (c.end - c.start) / c.text.length);
    for (const v of perChar) expect(v).toBeCloseTo(perChar[0]!, 6);
  });

  it("formats SRT and WebVTT correctly", () => {
    const cues = [
      { start: 0.5, end: 2.25, text: "Hello\nworld" },
      { start: 3661.007, end: 3662, text: "Later" },
    ];
    expect(toSrt(cues)).toBe(
      "1\n00:00:00,500 --> 00:00:02,250\nHello\nworld\n\n2\n01:01:01,007 --> 01:01:02,000\nLater\n",
    );
    expect(toVtt(cues)).toBe(
      "WEBVTT\n\n00:00:00.500 --> 00:00:02.250\nHello\nworld\n\n01:01:01.007 --> 01:01:02.000\nLater\n",
    );
  });

  it("looks up the visible cue by time, and skips scenes with no speech", () => {
    const cues = [
      { start: 1, end: 2, text: "a" },
      { start: 3, end: 4, text: "b" },
    ];
    expect(cueAt(cues, 1.5)?.text).toBe("a");
    expect(cueAt(cues, 2.5)).toBeUndefined();
    expect(cueAt(cues, 4)).toBeUndefined();
    expect(buildSubtitleCues(buildTimeline([scene("a", "", 3)]))).toEqual([]);
  });
});

describe("motion and transitions", () => {
  it("crops images to cover the frame with the right aspect ratio, inside the image", () => {
    for (const [iw, ih, w, h] of [
      [1024, 1024, 1920, 1080],
      [1920, 1080, 1080, 1920],
      [3000, 1000, 1280, 720],
    ] as const) {
      for (const m of ["none", "zoom-in", "zoom-out", "pan-left", "pan-right"] as const) {
        for (const p of [0, 0.5, 1]) {
          const r = motionRect(m, p, iw, ih, w, h);
          expect(r.sw / r.sh).toBeCloseTo(w / h, 6);
          expect(r.sx).toBeGreaterThanOrEqual(-1e-9);
          expect(r.sy).toBeGreaterThanOrEqual(-1e-9);
          expect(r.sx + r.sw).toBeLessThanOrEqual(iw + 1e-6);
          expect(r.sy + r.sh).toBeLessThanOrEqual(ih + 1e-6);
        }
      }
    }
  });

  it("zooms in over time, and pans in the stated direction", () => {
    const a = motionRect("zoom-in", 0, 2000, 1125, 1920, 1080);
    const b = motionRect("zoom-in", 1, 2000, 1125, 1920, 1080);
    expect(b.sw).toBeLessThan(a.sw);
    const l0 = motionRect("pan-left", 0, 3000, 1080, 1920, 1080);
    const l1 = motionRect("pan-left", 1, 3000, 1080, 1920, 1080);
    expect(l1.sx).toBeLessThan(l0.sx); // camera moves left
    const r0 = motionRect("pan-right", 0, 3000, 1080, 1920, 1080);
    const r1 = motionRect("pan-right", 1, 3000, 1080, 1920, 1080);
    expect(r1.sx).toBeGreaterThan(r0.sx);
  });

  it("eases between 0 and 1 and clamps", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(9)).toBe(1);
  });

  /** A recording fake canvas context. */
  const fakeCtx = () => {
    const log: string[] = [];
    const ctx = {
      globalAlpha: 1,
      fillStyle: "",
      save: () => log.push("save"),
      restore: () => log.push("restore"),
      drawImage: () => {},
      fillRect: () => log.push("fillRect"),
      beginPath: () => {},
      rect: (x: number, y: number, w: number) => log.push(`rect:${Math.round(w)}`),
      clip: () => log.push("clip"),
      translate: (x: number) => log.push(`translate:${Math.round(x)}`),
      scale: () => {},
    } as unknown as Ctx;
    return { ctx, log };
  };

  it("draws every transition kind with both layers at the right blend", () => {
    for (const kind of [
      "crossfade",
      "fade-black",
      "slide-left",
      "slide-right",
      "zoom",
      "wipe",
      "none",
    ] as TransitionKind[]) {
      const { ctx } = fakeCtx();
      const calls: string[] = [];
      drawTransition(
        ctx,
        kind,
        0.5,
        1000,
        500,
        () => calls.push("A"),
        () => calls.push("B"),
      );
      expect(calls.length).toBeGreaterThan(0);
      if (kind !== "none" && kind !== "fade-black") expect(calls).toEqual(["A", "B"]);
      if (kind === "none") expect(calls).toEqual(["B"]);
    }
    // fade-black shows only one scene at a time.
    const { ctx } = fakeCtx();
    const first: string[] = [];
    drawTransition(
      ctx,
      "fade-black",
      0.2,
      100,
      100,
      () => first.push("A"),
      () => first.push("B"),
    );
    expect(first).toEqual(["A"]);
    const second: string[] = [];
    drawTransition(
      ctx,
      "fade-black",
      0.8,
      100,
      100,
      () => second.push("A"),
      () => second.push("B"),
    );
    expect(second).toEqual(["B"]);
  });

  it("wipes progressively and slides in the stated direction", () => {
    const w = fakeCtx();
    drawTransition(
      w.ctx,
      "wipe",
      0.5,
      1000,
      500,
      () => {},
      () => {},
    );
    expect(w.log).toContain("rect:500");
    const left = fakeCtx();
    drawTransition(
      left.ctx,
      "slide-left",
      0.5,
      1000,
      500,
      () => {},
      () => {},
    );
    expect(left.log.filter((l) => l.startsWith("translate"))).toEqual([
      "translate:-500",
      "translate:500",
    ]);
    const right = fakeCtx();
    drawTransition(
      right.ctx,
      "slide-right",
      0.5,
      1000,
      500,
      () => {},
      () => {},
    );
    expect(right.log.filter((l) => l.startsWith("translate"))).toEqual([
      "translate:500",
      "translate:-500",
    ]);
  });
});

describe("music ducking envelope", () => {
  const env = duckingEnvelope(
    [
      [2, 5],
      [10, 12],
    ],
    20,
    { base: 0.2, duck: 0.06, attack: 0.25, release: 0.6, fadeIn: 1, fadeOut: 2 },
  );

  it("is non-decreasing in time and stays inside the clip", () => {
    for (let i = 1; i < env.length; i++) expect(env[i]!.t).toBeGreaterThanOrEqual(env[i - 1]!.t);
    expect(env[0]!.t).toBe(0);
    expect(env[env.length - 1]!.t).toBe(20);
  });

  it("starts silent, fades in, ducks under speech, recovers, and fades out", () => {
    expect(gainAt(env, 0)).toBe(0);
    expect(gainAt(env, 1)).toBeCloseTo(0.2, 6);
    expect(gainAt(env, 3)).toBeCloseTo(0.06, 6); // under speech
    expect(gainAt(env, 7)).toBeCloseTo(0.2, 6); // between speech
    expect(gainAt(env, 11)).toBeCloseTo(0.06, 6);
    expect(gainAt(env, 15)).toBeCloseTo(0.2, 6);
    expect(gainAt(env, 20)).toBeCloseTo(0, 6);
    expect(gainAt(env, 19)).toBeCloseTo(0.1, 6); // halfway through the 2 s fade-out
  });

  it("merges close intervals so the music does not pump between phrases", () => {
    expect(
      mergeIntervals(
        [
          [0, 1],
          [1.2, 2],
          [5, 6],
        ],
        0.5,
      ),
    ).toEqual([
      [0, 2],
      [5, 6],
    ]);
    expect(
      mergeIntervals(
        [
          [3, 3],
          [1, 2],
        ],
        0,
      ),
    ).toEqual([[1, 2]]);
    const none = duckingEnvelope([], 10, { base: 0.2, duck: 0.06 });
    expect(gainAt(none, 5)).toBeCloseTo(0.2, 6);
  });
});

describe("presets", () => {
  it("offers YouTube-ready sizes with sensible bitrates", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["1080p", "720p", "1440p", "shorts"]);
    const p = getPreset("1080p");
    expect([p.width, p.height, p.fps, p.videoBitrate]).toEqual([1920, 1080, 30, 8_000_000]);
    const shorts = getPreset("shorts");
    expect(shorts.height).toBeGreaterThan(shorts.width);
    expect(getPreset("nonsense").id).toBe("1080p");
    for (const x of PRESETS) {
      expect(x.width % 2).toBe(0); // H.264 needs even dimensions
      expect(x.height % 2).toBe(0);
    }
  });
  it("selects an H.264 level that fits the frame size", () => {
    expect(avcCodecFor(1280, 720)).toBe("avc1.64001f");
    expect(avcCodecFor(1920, 1080)).toBe("avc1.640028");
    expect(avcCodecFor(1080, 1920)).toBe("avc1.640028");
    expect(avcCodecFor(2560, 1440)).toBe("avc1.640033");
  });
});

import { colorFromAvcC, findVuiColor, unescapeRbsp, escapeRbsp } from "@/render/h264";

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
// Real avcC boxes written by Chromium's H.264 encoder.
// 1280x720, latencyMode "quality": declares FULL range, sRGB transfer.
const FULL_RANGE_SPS = hex("67640c1fac18d00a00b74dc0434041e1108d40");
const FULL_RANGE_AVCC = hex(
  "01640c1fffe10013" + "67640c1fac18d00a00b74dc0434041e1108d40" + "01000468ce3c80" + "fdf8f800",
);
// 64x64, default latency mode: declares LIMITED range, BT.709 transfer.
const LIMITED_SPS = hex("67640c14ac18d084935010101078442350");
const LIMITED_AVCC = hex(
  "01640c14ffe10011" + "67640c14ac18d084935010101078442350" + "01000468ce3c80" + "fdf8f800",
);

describe("H.264 colour declaration (used to tag the MP4 container)", () => {
  it("reads full-range / sRGB-transfer flags from a real SPS", () => {
    expect(findVuiColor(unescapeRbsp(FULL_RANGE_SPS))?.value).toEqual({
      fullRange: true,
      primaries: 1,
      transfer: 13,
      matrix: 1,
    });
  });
  it("reads limited-range / BT.709-transfer flags from a real SPS", () => {
    expect(findVuiColor(unescapeRbsp(LIMITED_SPS))?.value).toEqual({
      fullRange: false,
      primaries: 1,
      transfer: 1,
      matrix: 1,
    });
  });
  it("maps the stream's declaration to WebCodecs names for the container tag", () => {
    expect(colorFromAvcC(FULL_RANGE_AVCC)).toEqual({
      primaries: "bt709",
      transfer: "iec61966-2-1",
      matrix: "bt709",
      fullRange: true,
    });
    expect(colorFromAvcC(LIMITED_AVCC)).toEqual({
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false,
    });
  });
  it("returns null (leave the tag alone) for garbage, truncated or wrong-version data", () => {
    expect(colorFromAvcC(new Uint8Array([0, 1, 2]))).toBeNull();
    expect(
      colorFromAvcC(hex("02640c1fffe10013" + "67640c1fac18d00a00b74dc0434041e1108d40")),
    ).toBeNull();
    expect(colorFromAvcC(hex("01640c1fffe1000467640c1f"))).toBeNull();
    expect(colorFromAvcC(new Uint8Array(0))).toBeNull();
  });
  it("escapes and unescapes emulation-prevention bytes losslessly", () => {
    const raw = hex("6700000100000200000300ff");
    expect(toHex(unescapeRbsp(escapeRbsp(raw)))).toBe(toHex(raw));
    expect(toHex(escapeRbsp(hex("000001")))).toBe("00000301");
  });
});
