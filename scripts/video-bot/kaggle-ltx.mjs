// Optional upgrade: generate short MOVING clips with LTX-Video on a free Kaggle GPU,
// instead of the usual still pictures (channel 2) / Pixabay stock clips (channel 1).
//
// OFF BY DEFAULT. Turns on only when USE_LTX_VIDEO=1 AND KAGGLE_API_TOKEN is set as a GitHub
// Actions secret (Kaggle's newer single-token auth — Settings > API Tokens > Generate New Token).
// If anything here fails for any reason (no credentials, Kaggle down, weekly GPU-hour budget
// used up, timeout), it returns null and run.mjs falls straight back to its normal behaviour —
// nothing about the existing pipeline changes when this fails.
//
// How it works: one Kaggle "kernel" (script) is pushed per video. It loads LTX-Video ONCE,
// then renders one short (~3s) clip per group of narration scenes (same grouping channel 2
// already uses for its picture refreshes: every 4 scenes). ffmpeg already loops/trims clips
// to fit each scene's exact voice-over length (`-stream_loop -1 -i clip.mp4 -t <seconds>`),
// the same way channel 1's Pixabay clips work today — so the short clip doesn't need to match
// the scene's length exactly.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const KAGGLE_ENABLED = process.env.USE_LTX_VIDEO === "1";
const KAGGLE_API_TOKEN = process.env.KAGGLE_API_TOKEN ?? "";
// Public (not secret) — just the account name, needed to address the kernel as "<username>/<slug>".
const KAGGLE_USERNAME = process.env.KAGGLE_USERNAME ?? "";

export const GROUP_SIZE = 4; // narration scenes per clip (matches ch2's existing picture-refresh cadence)
export const FPS = 16;
export const CLIP_FRAMES = 49; // 8k+1 (LTX-Video requirement); 49/16 = 3.0625s, looped by ffmpeg to fit
export const WEEKLY_CAP_HOURS = 30; // Kaggle's free quota
export const MODEL_LOAD_MINUTES = 5; // once per kernel run
export const MINUTES_PER_CLIP = 4; // measured on a free Kaggle T4 at 384x384, ~49 frames

export function estimateHours(nClips) {
  return (MODEL_LOAD_MINUTES + nClips * MINUTES_PER_CLIP) / 60;
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[kaggle]", ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.slice(-600)}`)),
    );
  });
}

async function kaggleAuth() {
  // Newer Kaggle auth: a single bearer token saved to ~/.kaggle/access_token, read automatically
  // by the kaggle CLI (>= 1.8.0). No username/key pair needed.
  const dir = path.join(os.homedir(), ".kaggle");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "access_token"), KAGGLE_API_TOKEN);
  await run("chmod", ["600", path.join(dir, "access_token")]);
}

function buildScript(prompts, seed, characterStyle) {
  const promptList = JSON.stringify(prompts.map((p) => (characterStyle + p + " The camera slowly pushes in. One single clear character, sharp focus, smooth natural motion.").slice(0, 900)));
  const neg = JSON.stringify(
    "worst quality, blurry, low resolution, jittery, distorted, deformed, melted, extra limbs, extra heads, two characters, text, watermark",
  );
  return `import os, subprocess
subprocess.run(["pip", "install", "-q", "diffusers", "accelerate", "transformers", "sentencepiece", "imageio", "imageio-ffmpeg"], check=True)
import torch
from diffusers import LTXPipeline
from diffusers.utils import export_to_video

PROMPTS = ${promptList}
NEG = ${neg}
SEED = ${seed}
FPS = ${FPS}
FRAMES = ${CLIP_FRAMES}
OUT = "/kaggle/working"
os.makedirs(OUT, exist_ok=True)

pipe = LTXPipeline.from_pretrained("Lightricks/LTX-Video", torch_dtype=torch.bfloat16)
pipe.enable_model_cpu_offload()
print("model loaded", flush=True)

for idx, prompt in enumerate(PROMPTS):
    f = f"{OUT}/clip{idx:04d}.mp4"
    if os.path.exists(f):
        continue
    gen = torch.Generator(device="cuda").manual_seed(SEED)
    video = pipe(prompt=prompt, negative_prompt=NEG, width=640, height=384, num_frames=FRAMES,
        num_inference_steps=30, guidance_scale=3.0, generator=gen).frames[0]
    export_to_video(video, f, fps=FPS)
    print(f"clip {idx+1}/{len(PROMPTS)} done", flush=True)
print("ALL_DONE")`;
}

/**
 * Generates one short clip per group of `GROUP_SIZE` scenes, in a single Kaggle kernel run.
 * Returns { [groupStartIndex]: localFilePath } on success, or null if skipped/failed for any reason.
 *
 * studio: the same studio() helper from run.mjs, used to check/record the weekly GPU-hour budget.
 * scenes: the full scenes[] array (narration text) already built by run.mjs's script step.
 * characterStyle: prefix prepended to every clip prompt (e.g. GOBLIN_STYLE) for consistent look.
 * channel: 1 or 2, for budget logging only.
 * workDir: a scratch folder to generate output clips into.
 */
export async function generateClipsOnKaggle({
  studio,
  scenes,
  characterStyle,
  channel,
  workDir,
  seed = 42,
}) {
  if (!KAGGLE_ENABLED) return null;
  if (!KAGGLE_API_TOKEN || !KAGGLE_USERNAME) {
    log("skipped: USE_LTX_VIDEO=1 but KAGGLE_API_TOKEN/KAGGLE_USERNAME are not set");
    return null;
  }
  const groups = [];
  for (let i = 0; i < scenes.length; i += GROUP_SIZE) {
    const chunk = scenes
      .slice(i, i + GROUP_SIZE)
      .map((s) => s.narration)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 230);
    groups.push({ start: i, prompt: chunk });
  }
  if (!groups.length) return null;

  const needHours = estimateHours(groups.length);
  let budget;
  try {
    budget = await studio("/api/automation/kaggle-budget", { action: "check", needHours });
  } catch (e) {
    log("skipped: could not check GPU-hour budget:", String(e.message).slice(0, 120));
    return null;
  }
  if (!budget.allowed) {
    log(
      `skipped: this video needs ~${needHours.toFixed(2)}h, only ${budget.remainingHours.toFixed(2)}h left this week (of ${WEEKLY_CAP_HOURS}h)`,
    );
    return null;
  }

  const dir = path.join(workDir, "kaggle-job");
  await mkdir(dir, { recursive: true });
  const slug = `tony-ltx-ch${channel}-${Date.now()}`;
  const kernelId = `${KAGGLE_USERNAME}/${slug}`;
  await writeFile(
    path.join(dir, "kernel-metadata.json"),
    JSON.stringify({
      id: kernelId,
      title: slug,
      code_file: "script.py",
      language: "python",
      kernel_type: "script",
      is_private: true,
      enable_gpu: true,
      enable_internet: true,
      dataset_sources: [],
      competition_sources: [],
      kernel_sources: [],
    }),
  );
  await writeFile(
    path.join(dir, "script.py"),
    buildScript(
      groups.map((g) => g.prompt),
      seed,
      characterStyle,
    ),
  );

  const t0 = Date.now();
  try {
    await kaggleAuth();
    log(`pushing Kaggle kernel for ${groups.length} clips (~${needHours.toFixed(2)}h budget)...`);
    await run("kaggle", ["kernels", "push", "-p", dir]);

    // Poll for completion. Generous timeout (3.5h) so a slow Kaggle GPU queue doesn't fail the video outright.
    const deadline = Date.now() + 210 * 60 * 1000;
    let status = "";
    while (Date.now() < deadline) {
      await wait(30_000);
      try {
        const out = await run("kaggle", ["kernels", "status", kernelId]);
        status = out.toLowerCase();
      } catch (e) {
        status = "";
      }
      if (/complete/.test(status)) break;
      if (/error|cancel/.test(status))
        throw new Error(`Kaggle kernel failed: ${status.trim().slice(0, 160)}`);
    }
    if (!/complete/.test(status)) throw new Error("Kaggle kernel did not finish in time");

    await run("kaggle", ["kernels", "output", kernelId, "-p", dir]);
    const files = (await readdir(dir)).filter((f) => /^clip\d{4}\.mp4$/.test(f));
    if (!files.length) throw new Error("Kaggle kernel finished but produced no clip files");

    const out = {};
    for (const f of files) {
      const idx = Number(f.match(/\d{4}/)[0]);
      if (groups[idx]) out[groups[idx].start] = path.join(dir, f);
    }
    const usedHours = (Date.now() - t0) / 3_600_000;
    try {
      await studio("/api/automation/kaggle-budget", {
        action: "record",
        channel,
        hours: usedHours,
        note: `${groups.length} clips`,
      });
    } catch (e) {
      log("note: could not record GPU-hour usage:", String(e.message).slice(0, 120));
    }
    log(`done: ${Object.keys(out).length}/${groups.length} clips in ${usedHours.toFixed(2)}h`);
    return out;
  } catch (e) {
    const usedHours = (Date.now() - t0) / 3_600_000;
    try {
      await studio("/api/automation/kaggle-budget", {
        action: "record",
        channel,
        hours: usedHours,
        note: `failed: ${String(e.message).slice(0, 100)}`,
      });
    } catch {
      /* best effort */
    }
    log("failed, falling back to normal pictures/clips:", String(e.message).slice(0, 200));
    return null;
  }
}
