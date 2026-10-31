// Visual assets for scenes: generated title cards, images and video clips.
import type { VisualAsset } from "./types";

const HUES = [188, 205, 170, 222, 160, 195];

/** Draws wrapped text centred in a box; returns the y after the last line. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = cur ? cur + " " + word : word;
    if (ctx.measureText(test).width <= maxWidth || !cur) cur = test;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * A free, always-available visual: the studio's navy-and-teal gradient with a title. Needs no AI or network.
 * `index` varies the hue slightly between scenes.
 */
export function makeTitleCard(opts: {
  title: string;
  subtitle?: string;
  width: number;
  height: number;
  index?: number;
}): HTMLCanvasElement {
  const { width: w, height: h } = opts;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const hue = HUES[(opts.index ?? 0) % HUES.length]!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${hue + 28} 55% 9%)`);
  g.addColorStop(1, `hsl(${hue} 70% 22%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Soft glow
  const glow = ctx.createRadialGradient(
    w * 0.7,
    h * 0.3,
    0,
    w * 0.7,
    h * 0.3,
    Math.max(w, h) * 0.6,
  );
  glow.addColorStop(0, `hsla(${hue} 90% 60% / 0.22)`);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const unit = Math.min(w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${Math.round(unit * 0.075)}px Sora, system-ui, sans-serif`;
  const lines = wrapText(ctx, opts.title, w * 0.8).slice(0, 5);
  const lh = unit * 0.095;
  const top = h / 2 - ((lines.length - 1) * lh) / 2 - (opts.subtitle ? unit * 0.04 : 0);
  lines.forEach((l, i) => ctx.fillText(l, w / 2, top + i * lh));
  if (opts.subtitle) {
    ctx.fillStyle = `hsl(${hue} 80% 75%)`;
    ctx.font = `500 ${Math.round(unit * 0.035)}px system-ui, sans-serif`;
    ctx.fillText(opts.subtitle, w / 2, top + lines.length * lh + unit * 0.03);
  }
  return c;
}

export function canvasAsset(c: HTMLCanvasElement | ImageBitmap): VisualAsset {
  return {
    width: c.width,
    height: c.height,
    prepare: async () => {},
    source: () => c,
    dispose: () => {
      if ("close" in c) c.close();
    },
  };
}

export async function imageAsset(blob: Blob): Promise<VisualAsset> {
  return canvasAsset(await createImageBitmap(blob));
}

/** An uploaded video clip. The clip loops if the scene is longer than the clip. Audio in the clip is ignored. */
export async function videoClipAsset(blob: Blob): Promise<VisualAsset> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.src = url;
  await new Promise<void>((resolve, reject) => {
    v.addEventListener("loadeddata", () => resolve(), { once: true });
    v.addEventListener("error", () => reject(new Error("That video clip could not be read.")), {
      once: true,
    });
  });
  return {
    width: v.videoWidth,
    height: v.videoHeight,
    async prepare(localT) {
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
      const t = Math.min(dur - 0.001, Math.max(0, localT % dur));
      if (Math.abs(v.currentTime - t) < 0.0005) return;
      v.currentTime = t;
      await new Promise<void>((res) => v.addEventListener("seeked", () => res(), { once: true }));
    },
    source: () => v,
    dispose() {
      URL.revokeObjectURL(url);
      v.removeAttribute("src");
      v.load();
    },
  };
}
