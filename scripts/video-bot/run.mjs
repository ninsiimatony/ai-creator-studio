// Makes a video from a topic using only free services, then uploads it to YouTube as PRIVATE.
// Runs on a GitHub Actions computer (ffmpeg installed). Talks to the studio with the AUTOMATION_SECRET.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm, stat, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const STUDIO = (process.env.STUDIO_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.AUTOMATION_SECRET ?? "";
const TOPIC = (process.env.TOPIC ?? "").trim();
const MINUTES = Math.min(90, Math.max(3, Number(process.env.MINUTES) || 10));
const TONE = process.env.TONE === "emotional" ? "emotional" : undefined;
const STYLE = process.env.STYLE === "cartoon" ? "cartoon" : "real";
const W = MINUTES > 30 ? 1280 : 1920;
const H = MINUTES > 30 ? 720 : 1080;
const WORK = path.join(os.tmpdir(), "videobot");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function studio(pathname, body, { raw = false } = {}) {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(STUDIO + pathname, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
      const j = await res.json().catch(() => ({}));
      last = j.error ?? `HTTP ${res.status}`;
      if (res.status === 400 && /Daily|limit|not connected|not available/i.test(last)) break;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await wait(2500 * (attempt + 1));
  }
  throw new Error(last || "The studio did not answer.");
}

async function notify(text) {
  try {
    await studio("/api/automation/notify", { text });
  } catch (e) {
    log("notify failed:", e.message);
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.slice(-600)}`)),
    );
  });
}

const ffmpeg = (args, opts) => run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], opts);
async function duration(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(out.trim()) || 0;
}

/** Same idea as the studio's scene splitter: sentences grouped into ~28 word scenes. */
function splitScenes(text, target = 28) {
  const sentences =
    text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const out = [];
  let cur = [];
  let n = 0;
  for (const s of sentences) {
    const w = words(s);
    if (cur.length && n + w > target * 1.4) {
      out.push(cur.join(" "));
      cur = [];
      n = 0;
    }
    cur.push(s);
    n += w;
    if (n >= target) {
      out.push(cur.join(" "));
      cur = [];
      n = 0;
    }
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

function srtFor(narration, dur) {
  const words = narration.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += 7) chunks.push(words.slice(i, i + 7).join(" "));
  const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
  let t = 0.15;
  const span = Math.max(0.5, dur - 0.2);
  return chunks
    .map((c, i) => {
      const len = (c.length / total) * span;
      const s = `${i + 1}\n${srtTime(t)} --> ${srtTime(t + len)}\n${c}\n`;
      t += len;
      return s;
    })
    .join("\n");
}

/** Picks one of Tony's face photos (scripts/video-bot/faces) to match the story's feeling. */
function pickFace(title, topic) {
  const t = `${title} ${topic}`.toLowerCase();
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  if (/secret|shock|never|truth|unbelievable|surpris|mystery|hidden|discover|found out|strange/.test(t)) return "shocked";
  if (/hope|kind|happy|success|smile|gift|friend|saved|thank|reunion|together|celebrat|love/.test(t)) return pick(["thumbsup", "pointing"]);
  if (/why|how|what if|lesson|learn|understand/.test(t)) return pick(["thinking", "pointing"]);
  if (/lost|loss|grave|alone|lonely|cry|empty|goodbye|last|died|passed|miss|wait|tears|sad|hungry|poor/.test(t)) return pick(["crying", "sad"]);
  return TONE === "emotional" ? pick(["crying", "sad", "pointing", "thinking"]) : pick(["pointing", "thinking", "shocked"]);
}

/** Thumbnail: AI background + Tony's face + big title text, 1280x720 JPEG. */
async function makeThumbnail(title) {
  const prompt =
    TONE === "emotional"
      ? `Cinematic emotional background scene for a story titled "${title}", soft dramatic light, warm and blue tones, shallow depth of field, ultra detailed, 8k, no people in foreground, no text`
      : `Eye-catching cinematic background for a YouTube video titled "${title}", vivid colors, dramatic lighting, ultra detailed, 8k, no text`;
  const img = await studio("/api/media/image", { prompt: prompt.slice(0, 900) }, { raw: true });
  const src = path.join(WORK, "thumb-src.jpg");
  await writeFile(src, img);
  const face = pickFace(title, TOPIC);
  const here = path.dirname(new URL(import.meta.url).pathname);
  const out = path.join(WORK, "thumb.jpg");
  log("Thumbnail face:", face);
  await run("python3", [
    path.join(here, "thumb.py"), src, path.join(here, "faces", `${face}.png`),
    face === "pointing" ? "left" : "right", title, out,
  ]);
  return out;
}

async function setThumbnail(videoId, file) {
  const { accessToken } = await studio("/api/automation/youtube-token", {});
  const body = await readFile(file);
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/jpeg" },
    body,
  });
  if (!res.ok) throw new Error(`thumbnail ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function uploadToYouTube(file, title, description) {
  const { accessToken } = await studio("/api/automation/youtube-token", {});
  const size = (await stat(file)).size;
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(size),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title: title.slice(0, 100), description: description.slice(0, 4900), tags: globalThis.__videoTags ?? [], categoryId: TONE === "emotional" ? "22" : "28" },
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
      }),
    },
  );
  if (!init.ok) {
    const t = await init.text();
    throw new Error(init.status === 401 ? "Google access expired. Reconnect YouTube in the studio." : `YouTube refused the upload (${init.status}): ${t.slice(0, 200)}`);
  }
  const url = init.headers.get("location");
  if (!url) throw new Error("YouTube gave no upload address.");
  const CH = 32 * 1024 * 1024; // multiple of 256 KiB
  const fh = await open(file, "r");
  try {
    let offset = 0;
    while (offset < size) {
      const len = Math.min(CH, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      let done = false;
      for (let attempt = 0; attempt < 6 && !done; attempt++) {
        try {
          const res = await fetch(url, {
            method: "PUT",
            headers: {
              "content-length": String(len),
              "content-range": `bytes ${offset}-${offset + len - 1}/${size}`,
            },
            body: buf,
          });
          if (res.status === 200 || res.status === 201) {
            const j = await res.json();
            return j.id;
          }
          if (res.status === 308) {
            done = true;
            const r = res.headers.get("range");
            const got = r ? Number(r.split("-")[1]) + 1 : offset + len;
            offset = Math.min(size, Math.max(offset, got));
            continue;
          }
          if (res.status >= 500) throw new Error(`server ${res.status}`);
          throw new Error(`YouTube upload error ${res.status}: ${(await res.text()).slice(0, 200)}`);
        } catch (e) {
          if (attempt === 5 || /upload error/.test(String(e.message))) throw e;
          await wait(3000 * (attempt + 1));
        }
      }
    }
  } finally {
    await fh.close();
  }
  throw new Error("The upload finished without a video id.");
}

async function main() {
  if (!STUDIO || !SECRET || !TOPIC) throw new Error("Missing STUDIO_URL, AUTOMATION_SECRET or TOPIC.");
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  log("Topic:", TOPIC, "| minutes:", MINUTES, "| style:", STYLE);

  // 1. Script
  const outline = await studio("/api/media/auto-script", { step: "outline", topic: TOPIC, minutes: MINUTES, tone: TONE });
  log("Outline:", outline.title, `(${outline.sections.length} parts)`);
  const scenes = [];
  for (let i = 0; i < outline.sections.length; i++) {
    const sec = await studio("/api/media/auto-script", {
      step: "section",
      topic: TOPIC,
      title: outline.title,
      sections: outline.sections,
      index: i,
      style: STYLE,
      tone: TONE,
    });
    splitScenes(sec.narration).forEach((narration, k) =>
      scenes.push({ narration, term: sec.visuals[k % Math.max(1, sec.visuals.length)] ?? outline.sections[i] }),
    );
    log(`Script part ${i + 1}/${outline.sections.length} done`);
  }

  // 2. One scene at a time: voice, clip, encode.
  const segs = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const id = String(i).padStart(4, "0");
    const voice = path.join(WORK, `v${id}.bin`);
    await writeFile(voice, await studio("/api/media/tts", { text: sc.narration, lang: "en" }, { raw: true }));
    const dur = (await duration(voice)) + 0.5;
    await writeFile(path.join(WORK, "seg.srt"), srtFor(sc.narration, dur));
    let clip = null;
    try {
      await wait(1100);
      clip = path.join(WORK, `c${id}.mp4`);
      await writeFile(
        clip,
        await studio(
          "/api/media/stock-clip",
          { text: sc.narration.slice(0, 400), query: sc.term, index: i, style: STYLE },
          { raw: true },
        ),
      );
    } catch (e) {
      log(`Scene ${i + 1}: no clip (${e.message}); using a plain background`);
      clip = null;
    }
    const seg = path.join(WORK, `seg${id}.mp4`);
    const vf =
      (clip ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` : "") +
      `fps=30,format=yuv420p,subtitles=seg.srt:force_style='FontName=DejaVu Sans,FontSize=20,Bold=1,Outline=2,Shadow=0,MarginV=36'`;
    const input = clip
      ? ["-stream_loop", "-1", "-i", clip]
      : ["-f", "lavfi", "-i", `color=c=0x0f172a:s=${W}x${H}:r=30`];
    await ffmpeg(
      [
        ...input,
        "-i", voice,
        "-t", dur.toFixed(3),
        "-vf", vf,
        "-af", "apad",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        seg,
      ],
      { cwd: WORK },
    );
    segs.push(`file '${path.basename(seg)}'`);
    await rm(voice, { force: true });
    if (clip) await rm(clip, { force: true });
    if ((i + 1) % 20 === 0 || i === scenes.length - 1) log(`Scene ${i + 1}/${scenes.length} done`);
  }

  // 3. Join, add quiet music, upload.
  await writeFile(path.join(WORK, "list.txt"), segs.join("\n"));
  const body = path.join(WORK, "body.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", body], { cwd: WORK });
  const total = await duration(body);
  log("Joined video:", Math.round(total / 60), "minutes");
  const final = path.join(WORK, "final.mp4");
  const music =
    "aevalsrc=0.05*sin(2*PI*110*t)+0.04*sin(2*PI*164.8*t)+0.03*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.07*t)):s=48000:d=" +
    Math.ceil(total);
  await ffmpeg([
    "-i", body, "-f", "lavfi", "-i", music,
    "-filter_complex",
    `[1:a]volume=0.5,afade=t=in:d=3,afade=t=out:st=${Math.max(0, total - 4).toFixed(1)}:d=4[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`,
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", final,
  ]);

  const topicTags = TOPIC.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !["about", "their", "with", "from", "that", "this", "until", "every", "after"].includes(w))
    .slice(0, 3).map((w) => `#${w}`);
  const baseTags = TONE === "emotional"
    ? ["#emotionalstory", "#sadstory", "#lifelessons", "#storytime", "#touchingstory"]
    : ["#explained", "#documentary", "#facts"];
  const hashtags = [...new Set([...baseTags, ...topicTags])].slice(0, 8);
  const description =
    `${outline.title}\n\n` +
    (TONE === "emotional"
      ? `If this story touched your heart, please like, share and subscribe for a new emotional story every day.\n\n`
      : `Like and subscribe for more.\n\n`) +
    `${outline.sections.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
    (TONE === "emotional" ? `This is a fictional story, written for reflection and inspiration.\n` : "") +
    `Made with AI narration and stock video clips from Pixabay (https://pixabay.com).\n\n` +
    hashtags.join(" ");
  globalThis.__videoTags = hashtags.map((h) => h.slice(1));
  log("Uploading to YouTube (private)...");
  const id = await uploadToYouTube(final, outline.title, description);
  let thumbNote = "";
  try {
    log("Making thumbnail...");
    await setThumbnail(id, await makeThumbnail(outline.title));
    log("Thumbnail set");
  } catch (e) {
    log("thumbnail skipped:", e.message);
    thumbNote = "\n(Thumbnail could not be set this time.)";
  }
  // Short: first ~55 seconds as a vertical 1080x1920 clip, linking to the full story.
  let shortNote = "";
  try {
    log("Making Short...");
    const shortFile = path.join(WORK, "short.mp4");
    const tl = [];
    for (const w of outline.title.toUpperCase().split(/\s+/)) {
      const last = tl[tl.length - 1];
      if (last !== undefined && (last + " " + w).length <= 20) tl[tl.length - 1] = last + " " + w;
      else tl.push(w);
    }
    await writeFile(path.join(WORK, "short-title.txt"), tl.slice(0, 3).join("\n"));
    await run("ffmpeg", [
      "-y", "-ss", "0", "-t", "55", "-i", final,
      "-filter_complex",
      "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[bg];" +
        "[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2," +
        "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=short-title.txt:" +
        "fontsize=58:fontcolor=white:borderw=4:bordercolor=black:line_spacing=12:x=(w-text_w)/2:y=200,format=yuv420p[v]",
      "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-shortest", shortFile,
    ], { cwd: WORK });
    const shortId = await uploadToYouTube(
      shortFile,
      `${outline.title.slice(0, 85)} #shorts`,
      `Watch the full story: https://youtu.be/${id}\n\n${hashtags.join(" ")} #shorts`,
    );
    shortNote = `\n\nShort (1 min): https://youtu.be/${shortId}\nPublish it: https://studio.youtube.com/video/${shortId}/edit`;
    log("Short uploaded:", shortId);
  } catch (e) {
    log("short skipped:", e.message);
  }
  await notify(
    `✅ Your video is ready (PRIVATE)\n"${outline.title}" · ${Math.round(total / 60)} min\n\nWatch: https://youtu.be/${id}\nPublish it: https://studio.youtube.com/video/${id}/edit\n\nIt is private until you press Publish.${thumbNote}${shortNote}`,
  );
  log("All done:", id);
}

main()
  .catch(async (e) => {
    console.error(e);
    await notify(`❌ I could not finish the video.\nReason: ${String(e.message ?? e).slice(0, 500)}`);
    process.exitCode = 1;
  })
  .finally(() => rm(WORK, { recursive: true, force: true }).catch(() => {}));
