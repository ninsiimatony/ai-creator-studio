// Transition and camera-motion math (pure) plus canvas drawing for each transition kind.
import type { Motion, TransitionKind } from "./types";

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
};

export type Rect = { sx: number; sy: number; sw: number; sh: number };

/**
 * Source rectangle to crop from an image so it covers a `w`x`h` frame ("cover" fit),
 * with Ken Burns motion applied at progress `p` (0..1) through the scene.
 */
export function motionRect(
  motion: Motion,
  p: number,
  imgW: number,
  imgH: number,
  w: number,
  h: number,
): Rect {
  const prog = clamp01(p);
  const frameAspect = w / h;
  let sw = imgW;
  let sh = sw / frameAspect;
  if (sh > imgH) {
    sh = imgH;
    sw = sh * frameAspect;
  }
  let zoom = 1;
  let panX = 0; // -1..1: where in the free horizontal space the crop sits
  if (motion === "zoom-in") zoom = 1 + 0.12 * prog;
  else if (motion === "zoom-out") zoom = 1.12 - 0.12 * prog;
  else if (motion === "pan-left") {
    zoom = 1.12;
    panX = 1 - 2 * prog;
  } else if (motion === "pan-right") {
    zoom = 1.12;
    panX = -1 + 2 * prog;
  }
  const zw = sw / zoom;
  const zh = sh / zoom;
  const freeX = imgW - zw;
  const freeY = imgH - zh;
  const cx = freeX / 2 + (panX * freeX) / 2;
  return { sx: Math.min(Math.max(0, cx), freeX), sy: freeY / 2, sw: zw, sh: zh };
}

/** Subset of CanvasRenderingContext2D the transitions use (so they can be tested with a fake). */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "drawImage"
  | "fillRect"
  | "beginPath"
  | "rect"
  | "clip"
  | "translate"
  | "scale"
> & { globalAlpha: number; fillStyle: string | CanvasGradient | CanvasPattern };

/**
 * Draws the blend of an outgoing and incoming layer at transition progress `p` (0..1).
 * `drawA` / `drawB` paint a full frame of each scene.
 */
export function drawTransition(
  ctx: Ctx,
  kind: TransitionKind,
  p: number,
  w: number,
  h: number,
  drawA: () => void,
  drawB: () => void,
) {
  const e = easeInOut(p);
  switch (kind) {
    case "crossfade":
      drawA();
      ctx.save();
      ctx.globalAlpha = e;
      drawB();
      ctx.restore();
      return;
    case "fade-black":
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      if (e < 0.5) {
        ctx.globalAlpha = 1 - e * 2;
        drawA();
      } else {
        ctx.globalAlpha = (e - 0.5) * 2;
        drawB();
      }
      ctx.restore();
      return;
    case "slide-left":
    case "slide-right": {
      const dir = kind === "slide-left" ? -1 : 1; // slide-left: content moves left, new scene enters from the right
      ctx.save();
      ctx.translate(dir * e * w, 0);
      drawA();
      ctx.restore();
      ctx.save();
      ctx.translate(dir * (e - 1) * w, 0);
      drawB();
      ctx.restore();
      return;
    }
    case "zoom":
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(1 + 0.35 * e, 1 + 0.35 * e);
      ctx.translate(-w / 2, -h / 2);
      ctx.globalAlpha = 1 - e;
      drawA();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = e;
      drawB();
      ctx.restore();
      return;
    case "wipe":
      drawA();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w * e, h);
      ctx.clip();
      drawB();
      ctx.restore();
      return;
    default:
      drawB();
  }
}
