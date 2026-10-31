// The renderer: composes frames on a canvas, encodes them with WebCodecs and writes an MP4.
// It runs entirely in the user's browser — no server, no cost, and no upload of raw media.
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { pickCodecs, type CodecChoice } from "./codecs";
import { colorFromAvcC } from "./h264";
import { cueAt, wrapLines } from "./subtitles";
import { sceneIndexAt } from "./timeline";
import { clamp01, drawTransition, motionRect, type Ctx } from "./transitions";
import type { Preset, SubtitleCue, Timeline, TimelineScene, VisualAsset } from "./types";

export type RenderProgress = { phase: "video" | "audio" | "finalize"; fraction: number };

export type RenderOptions = {
  timeline: Timeline;
  /** Visual per scene id. A scene with no asset is drawn on the dark background. */
  assets: Map<string, VisualAsset>;
  /** The finished stereo mix (voice + music), or null for a silent video. */
  audio: AudioBuffer | null;
  cues: SubtitleCue[];
  burnSubtitles: boolean;
  preset: Preset;
  signal?: AbortSignal | undefined;
  onProgress?: ((p: RenderProgress) => void) | undefined;
};

export type RenderResult = {
  blob: Blob;
  info: {
    width: number;
    height: number;
    fps: number;
    durationSec: number;
    frames: number;
    bytes: number;
    videoCodec: string;
    audioCodec: string | null;
    youtubeRecommended: boolean;
    warnings: string[];
  };
};

const BG = "#05080f";
const FINAL_FADE = 0.6;

function drawOverlayText(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
  const unit = Math.min(w, h);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(unit * 0.08)}px Sora, system-ui, sans-serif`;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const wd of words) {
    const t = cur ? cur + " " + wd : wd;
    if (ctx.measureText(t).width <= w * 0.8 || !cur) cur = t;
    else {
      lines.push(cur);
      cur = wd;
    }
  }
  if (cur) lines.push(cur);
  const lh = unit * 0.1;
  const top = h * 0.42 - ((lines.length - 1) * lh) / 2;
  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = unit * 0.02;
  ctx.fillStyle = "#fff";
  lines.slice(0, 4).forEach((l, i) => ctx.fillText(l, w / 2, top + i * lh));
  ctx.restore();
}

function drawSubtitle(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
  const portrait = h > w;
  const fs = Math.round(Math.min(w, h) * (portrait ? 0.052 : 0.05));
  ctx.save();
  ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxW = w * (portrait ? 0.86 : 0.8);
  const lines = text
    .split("\n")
    .flatMap((l) =>
      ctx.measureText(l).width > maxW ? wrapLines(l, Math.floor(l.length / 2)) : [l],
    );
  const lh = fs * 1.3;
  const boxH = lines.length * lh + fs * 0.5;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  // Shorts keep captions above the app's bottom UI.
  const bottom = h * (portrait ? 0.76 : 0.92);
  const y0 = bottom - boxH;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  const bx = w / 2 - widest / 2 - fs * 0.5;
  ctx.beginPath();
  ctx.roundRect(bx, y0, widest + fs, boxH, fs * 0.3);
  ctx.fill();
  ctx.fillStyle = "#fff";
  lines.forEach((l, i) => ctx.fillText(l, w / 2, y0 + fs * 0.25 + lh * (i + 0.5)));
  ctx.restore();
}

let bgCanvas: HTMLCanvasElement | undefined;
const background = () => {
  if (!bgCanvas) {
    bgCanvas = document.createElement("canvas");
    bgCanvas.width = bgCanvas.height = 2;
    const c = bgCanvas.getContext("2d")!;
    c.fillStyle = BG;
    c.fillRect(0, 0, 2, 2);
  }
  return bgCanvas;
};

function drawLayer(
  ctx: CanvasRenderingContext2D,
  sc: TimelineScene,
  assets: Map<string, VisualAsset>,
  t: number,
  w: number,
  h: number,
) {
  // Never paint an opaque background here: during a transition this layer is drawn at partial opacity, and a
  // background fill would be blended in and darken the picture. A scene without an asset draws a tiny
  // background-coloured image instead, which blends correctly.
  const a = assets.get(sc.id);
  if (!a) ctx.drawImage(background(), 0, 0, w, h);
  if (a) {
    const r = motionRect(sc.motion, clamp01((t - sc.start) / sc.duration), a.width, a.height, w, h);
    ctx.drawImage(a.source(), r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  }
  if (sc.overlayText) drawOverlayText(ctx, sc.overlayText, w, h);
}

/** Draws the frame at time `t` (exported so a preview can reuse it). */
export async function drawFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tl: Timeline,
  assets: Map<string, VisualAsset>,
  cues: SubtitleCue[],
  burn: boolean,
  t: number,
): Promise<void> {
  ctx.fillStyle = BG; // opaque base for the whole frame (layers draw on top of it)
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = BG; // opaque base for the whole frame; layers draw on top of it
  ctx.fillRect(0, 0, w, h);
  const i = sceneIndexAt(tl, t);
  const sc = tl.scenes[i];
  if (!sc) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const prev = i > 0 ? tl.scenes[i - 1] : undefined;
  const inTransition = prev && sc.transitionSec > 0 && t < sc.start + sc.transitionSec;
  await assets.get(sc.id)?.prepare(Math.max(0, t - sc.start));
  if (inTransition && prev) {
    await assets.get(prev.id)?.prepare(Math.max(0, t - prev.start));
    const p = (t - sc.start) / sc.transitionSec;
    drawTransition(
      ctx as Ctx,
      sc.transition,
      p,
      w,
      h,
      () => drawLayer(ctx, prev, assets, t, w, h),
      () => drawLayer(ctx, sc, assets, t, w, h),
    );
  } else {
    drawLayer(ctx, sc, assets, t, w, h);
  }
  if (burn) {
    const cue = cueAt(cues, t);
    if (cue) drawSubtitle(ctx, cue.text, w, h);
  }
  if (t > tl.duration - FINAL_FADE) {
    ctx.save();
    // Finish the fade slightly before the end so the very last frame is fully black.
    ctx.globalAlpha = clamp01((t - (tl.duration - FINAL_FADE)) / (FINAL_FADE - 0.1));
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

/**
 * Make the MP4 container's colour tag agree with the H.264 stream. The encoder declares its colour range inside
 * the bitstream (Chrome: full range, BT.709); the container is otherwise tagged from separate metadata, and players
 * can disagree about which one wins. We read the stream's declaration and mirror it. The stream is never altered.
 */
function tagContainerColor(
  meta: EncodedVideoChunkMetadata | undefined,
): EncodedVideoChunkMetadata | undefined {
  const dc = meta?.decoderConfig;
  const desc = dc?.description;
  if (!meta || !dc || !desc) return meta;
  const view = desc as ArrayBufferView;
  const bytes = ArrayBuffer.isView(desc)
    ? new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
    : new Uint8Array(desc as ArrayBuffer);
  const declared = colorFromAvcC(bytes);
  return declared
    ? { ...meta, decoderConfig: { ...dc, colorSpace: declared as VideoColorSpaceInit } }
    : meta;
}

const abortError = () => new DOMException("Rendering was cancelled.", "AbortError");

export async function renderVideo(o: RenderOptions): Promise<RenderResult> {
  const { preset, timeline } = o;
  if (timeline.scenes.length === 0 || timeline.duration <= 0)
    throw new Error("There is nothing to render yet.");
  const sampleRate = o.audio?.sampleRate ?? 48000;
  const codecs: CodecChoice = await pickCodecs(preset, sampleRate);
  const { width, height, fps } = preset;
  const frames = Math.ceil(timeline.duration * fps);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: codecs.video.mux, width, height, frameRate: fps },
    ...(o.audio ? { audio: { codec: codecs.audio.mux, numberOfChannels: 2, sampleRate } } : {}),
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let failure: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, tagContainerColor(meta)),
    error: (e) => (failure = e instanceof Error ? e : new Error(String(e))),
  });
  venc.configure({
    codec: codecs.video.webcodecs,
    width,
    height,
    bitrate: preset.videoBitrate,
    framerate: fps,
    latencyMode: "quality",
    ...(codecs.video.mux === "avc" ? { avc: { format: "avc" as const } } : {}),
  });

  const closeAll = () => {
    try {
      if (venc.state !== "closed") venc.close();
    } catch {
      /* already closed */
    }
  };
  try {
    for (let i = 0; i < frames; i++) {
      if (o.signal?.aborted) throw abortError();
      if (failure) throw failure;
      await drawFrame(ctx, width, height, timeline, o.assets, o.cues, o.burnSubtitles, i / fps);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 1));
      if (i % 5 === 0) o.onProgress?.({ phase: "video", fraction: i / frames });
    }
    await venc.flush();
    if (failure) throw failure;
    venc.close();

    if (o.audio) {
      const aenc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => (failure = e instanceof Error ? e : new Error(String(e))),
      });
      aenc.configure({
        codec: codecs.audio.webcodecs,
        sampleRate,
        numberOfChannels: 2,
        bitrate: preset.audioBitrate,
      });
      const total = o.audio.length;
      const chunk = 4096;
      const left = o.audio.getChannelData(0);
      const right = o.audio.numberOfChannels > 1 ? o.audio.getChannelData(1) : left;
      for (let off = 0; off < total; off += chunk) {
        if (o.signal?.aborted) {
          aenc.close();
          throw abortError();
        }
        const n = Math.min(chunk, total - off);
        const data = new Float32Array(n * 2);
        data.set(left.subarray(off, off + n), 0);
        data.set(right.subarray(off, off + n), n);
        const ad = new AudioData({
          format: "f32-planar",
          sampleRate,
          numberOfFrames: n,
          numberOfChannels: 2,
          timestamp: Math.round((off * 1e6) / sampleRate),
          data,
        });
        aenc.encode(ad);
        ad.close();
        while (aenc.encodeQueueSize > 12) await new Promise((r) => setTimeout(r, 1));
        if ((off / chunk) % 40 === 0) o.onProgress?.({ phase: "audio", fraction: off / total });
      }
      await aenc.flush();
      aenc.close();
      if (failure) throw failure;
    }

    o.onProgress?.({ phase: "finalize", fraction: 0.9 });
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: "video/mp4" });
    o.onProgress?.({ phase: "finalize", fraction: 1 });
    return {
      blob,
      info: {
        width,
        height,
        fps,
        durationSec: timeline.duration,
        frames,
        bytes: blob.size,
        videoCodec: codecs.video.label,
        audioCodec: o.audio ? codecs.audio.label : null,
        youtubeRecommended: codecs.youtubeRecommended && !!o.audio,
        warnings: codecs.warnings,
      },
    };
  } finally {
    closeAll();
  }
}
