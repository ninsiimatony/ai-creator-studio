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
const TONE = process.env.TONE === "emotional" ? "emotional" : process.env.TONE === "scary" ? "scary" : undefined;
const SCARY = TONE === "scary";
// Look of every picture in the scary channel (one recurring goblin keeper, original character design).
const GOBLIN_STYLE =
  "Stylized 3D animated horror-cartoon film still, wide cinematic shot, dark moody lighting, blue and green fog, no text. " +
  "A small pale gray-green goblin keeper with huge bloodshot yellow eyes, long drooping pointed ears, tiny sharp teeth and a ragged green-and-black striped sweater appears in the scene. Scene: ";
const STYLE = process.env.STYLE === "cartoon" ? "cartoon" : "real";
const W = MINUTES > 30 ? 1280 : 1920;
const H = MINUTES > 30 ? 720 : 1080;
const WORK = path.join(os.tmpdir(), "videobot");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Natural human-sounding voices (free Microsoft neural voices). One voice per video, picked from the topic.
// If they are not reachable, we fall back to the studio's built-in voice, so a video is never lost.
const EDGE_VOICES = ["en-US-AndrewNeural", "en-US-AvaNeural", "en-US-GuyNeural", "en-US-JennyNeural"];
const EDGE_VOICE = SCARY ? "en-US-ChristopherNeural" : EDGE_VOICES[[...TOPIC].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % EDGE_VOICES.length];
let edgeFails = 0;
async function speak(text, file) {
  if (edgeFails < 3) {
    try {
      const txt = file + ".txt";
      await writeFile(txt, text);
      await run("python3", ["-m", "edge_tts", "--voice", EDGE_VOICE, SCARY ? "--rate=-12%" : "--rate=-4%", ...(SCARY ? ["--pitch=-6Hz"] : []), "--file", txt, "--write-media", file]);
      const st = await stat(file);
      if (st.size > 2000) {
        edgeFails = 0;
        return;
      }
      throw new Error("empty audio");
    } catch (e) {
      edgeFails++;
      if (edgeFails === 1 || edgeFails === 3) log("natural voice failed, using fallback:", String(e.message).slice(0, 160));
    }
  }
  await writeFile(file, await studio("/api/media/tts", { text, lang: "en" }, { raw: true }));
}
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
      if (res.status === 400 && /Daily|limit|not connected|not available|No stock clip/i.test(last)) break;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await wait(2500 * (attempt + 1));
  }
  throw new Error(last || "The studio did not answer.");
}

const CHANNEL = process.env.CHANNEL === "2" ? 2 : 1;
// Links in Telegram ask Google to open the right account for each channel.
const AUTH = "authuser=" + encodeURIComponent(CHANNEL === 2 ? "ninsiimamusigo@gmail.com" : "ninsiimatony@gmail.com");
// Random start so different videos pick different clips from the same search.
const CLIP_OFFSET = Math.floor(Math.random() * 20);

async function notify(text) {
  try {
    await studio("/api/automation/notify", { text: CHANNEL === 2 ? `[Little Hope Tales - ninsiimamusigo@gmail.com]\n${text}` : `[Tony Ninsiima - ninsiimatony@gmail.com]\n${text}` });
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

/** Thumbnail: a different look every time. Mixes Tony's face, AI-made people / characters, and plain scenes. */
async function makeThumbnail(title) {
  const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const r = Math.random();
  // ch1: 40% Tony's face, 35% AI-made person, 25% scene only. ch2 (no real faces): 50% cartoon character, 50% scene.
  const mode = SCARY ? "scene" : CHANNEL === 2 ? (r < 0.5 ? "person" : "scene") : r < 0.4 ? "tony" : r < 0.75 ? "person" : "scene";
  const sceneLook = pickOne(["warm golden light", "cool blue night light", "soft sunrise glow", "moody dramatic shadows", "rainy window light", "candle light"]);
  let prompt;
  if (SCARY) {
    prompt = GOBLIN_STYLE.replace("wide cinematic shot", "dramatic close-up") + `the goblin peeks out of the dark, creepy atmosphere for a scary story titled "${title}", glowing yellow eyes, strong contrast`;
  } else if (mode === "person") {
    const feel = pickOne(["shocked", "heartbroken, eyes full of tears", "worried", "hopeful and smiling softly", "angry and hurt", "surprised"]);
    if (CHANNEL === 2) {
      const who = pickOne(["a cute cartoon mother", "a cute cartoon father", "a cartoon little girl", "a cartoon little boy", "a kind cartoon grandmother", "a cartoon grandfather"]);
      prompt = `Pixar style 3D cartoon close-up of ${who} with a ${feel} expression, placed on the right side of the frame, ${sceneLook}, empty calm space on the left, ultra detailed, no text`;
    } else {
      const who = pickOne(["a middle-aged woman", "a young woman", "a worried father", "an elderly man", "a young man", "an elderly woman", "a mother holding her child"]);
      prompt = `Cinematic close-up photo of ${who} with a ${feel} expression, placed on the right side of the frame, ${sceneLook}, dark empty space on the left, shallow depth of field, ultra detailed, 8k, no text`;
    }
  } else if (CHANNEL === 2) {
    prompt = `Colorful 3D animated cartoon movie scene for a story titled "${title}", Pixar style, expressive characters, ${sceneLook}, ultra detailed, no text`;
  } else if (TONE === "emotional") {
    prompt = `Cinematic emotional background scene for a story titled "${title}", ${sceneLook}, shallow depth of field, ultra detailed, 8k, no people in foreground, no text`;
  } else {
    prompt = `Eye-catching cinematic background for a YouTube video titled "${title}", vivid colors, dramatic lighting, ultra detailed, 8k, no text`;
  }
  const img = await studio("/api/media/image", { prompt: prompt.slice(0, 900) }, { raw: true });
  const src = path.join(WORK, "thumb-src.jpg");
  await writeFile(src, img);
  const face = mode === "tony" ? pickFace(title, TOPIC) : "none";
  const here = path.dirname(new URL(import.meta.url).pathname);
  const out = path.join(WORK, "thumb.jpg");
  log("Thumbnail mode:", mode, "face:", face);
  await run("python3", [
    path.join(here, "thumb.py"), src, face === "none" ? "none" : path.join(here, "faces", `${face}.png`),
    face === "pointing" ? "left" : "right", title, out, mode === "person" ? "half" : "full",
  ]);
  return out;
}

async function setThumbnail(videoId, file) {
  const { accessToken } = await studio("/api/automation/youtube-token", { channel: CHANNEL });
  const body = await readFile(file);
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "image/jpeg" },
    body,
  });
  if (!res.ok) throw new Error(`thumbnail ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function publishVideo(videoId) {
  // Auto-publish: make the uploaded video public right away (set AUTO_PUBLISH=0 to turn off).
  const { accessToken } = await studio("/api/automation/youtube-token", { channel: CHANNEL });
  const h = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  const cur = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`, { headers: h })).json();
  const st = cur.items?.[0]?.status;
  if (!st) throw new Error("video not found for publishing");
  const res = await fetch("https://www.googleapis.com/youtube/v3/videos?part=status", {
    method: "PUT", headers: h,
    body: JSON.stringify({ id: videoId, status: { privacyStatus: "public", selfDeclaredMadeForKids: st.selfDeclaredMadeForKids ?? false, embeddable: st.embeddable ?? true, license: st.license ?? "youtube", publicStatsViewable: st.publicStatsViewable ?? true } }),
  });
  if (!res.ok) throw new Error(`publish ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function uploadToYouTube(file, title, description) {
  const { accessToken } = await studio("/api/automation/youtube-token", { channel: CHANNEL });
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
        snippet: { title: title.slice(0, 100), description: description.slice(0, 4900), tags: globalThis.__videoTags ?? [], categoryId: SCARY ? "24" : TONE === "emotional" ? "22" : "28" },
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
      }),
    },
  );
  if (!init.ok) {
    const t = await init.text();
    if (init.status === 403 && /quota/i.test(t)) {
      const q = new Error("YouTube daily upload limit reached.");
      q.quota = true;
      throw q;
    }
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
  log("Topic:", TOPIC, "| minutes:", MINUTES, "| style:", STYLE, "| voice:", EDGE_VOICE);
  // Check YouTube access first, so we never spend 20 minutes making a video we cannot upload.
  try {
    await studio("/api/automation/youtube-token", { channel: CHANNEL });
  } catch (e) {
    throw new Error(`Google access expired. Reconnect YouTube in the studio. (${e.message})`);
  }

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
      style: CHANNEL === 2 ? "real" : STYLE,
      tone: TONE,
    });
    const parts = splitScenes(sec.narration);
    // Ask the AI for one filmable search phrase per scene, so each clip matches its own sentences.
    let terms = [];
    if (!SCARY) try {
      terms = (await studio("/api/media/auto-script", { step: "scenes", scenes: parts.slice(0, 40), style: CHANNEL === 2 ? "real" : STYLE })).terms ?? [];
    } catch (e) {
      log(`Part ${i + 1}: scene matching skipped (${String(e.message).slice(0, 80)})`);
    }
    parts.forEach((narration, k) =>
      scenes.push({
        narration,
        term: terms[k] || sec.visuals[k % Math.max(1, sec.visuals.length)] || outline.sections[i],
      }),
    );
    log(`Script part ${i + 1}/${outline.sections.length} done`);
  }

  // 2. One scene at a time: voice, clip, encode.
  const segs = [];
  let curImg = null, imgN = 0, imgT = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const id = String(i).padStart(4, "0");
    const voice = path.join(WORK, `v${id}.bin`);
    await speak(sc.narration, voice);
    const dur = (await duration(voice)) + 0.5;
    await writeFile(path.join(WORK, "seg.srt"), srtFor(sc.narration, dur));
    if (SCARY) {
      if (i % 4 === 0) {
        const chunk = scenes.slice(i, i + 4).map((x) => x.narration).join(" ").replace(/\s+/g, " ").slice(0, 230);
        try {
          const img = await studio("/api/media/image", { prompt: GOBLIN_STYLE + chunk }, { raw: true });
          curImg = path.join(WORK, `img${i}.` + (img[0] === 0x89 ? "png" : "jpg"));
          await writeFile(curImg, img);
          imgN++;
          imgT = 0;
        } catch (e) {
          log(`Picture ${imgN + 1}: reusing the last picture (${String(e.message).slice(0, 80)})`);
        }
        await wait(300);
      }
      const frames = Math.ceil(dur * 30);
      const off = Math.round(imgT * 30);
      const zoom = imgN % 2 === 0 ? `min(1.0+0.00025*(${off}+on),1.4)` : `max(1.4-0.00025*(${off}+on),1.0)`;
      const sub = `subtitles=seg.srt:force_style='FontName=DejaVu Sans,FontSize=20,Bold=1,Outline=2,Shadow=0,MarginV=36'`;
      const vfs = curImg
        ? `scale=2240:2240,crop=2240:1260,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,vignette=PI/4,format=yuv420p,${sub}`
        : `fps=30,format=yuv420p,${sub}`;
      const segS = path.join(WORK, `seg${id}.mp4`);
      await ffmpeg(
        [
          ...(curImg ? ["-loop", "1", "-framerate", "30", "-i", curImg] : ["-f", "lavfi", "-i", `color=c=0x05080f:s=${W}x${H}:r=30`]),
          "-i", voice,
          "-t", dur.toFixed(3),
          "-vf", vfs,
          "-af", "aecho=0.8:0.55:80:0.22,apad",
          "-map", "0:v:0", "-map", "1:a:0",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
          "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
          segS,
        ],
        { cwd: WORK },
      );
      imgT += dur;
      segs.push(`file '${path.basename(segS)}'`);
      await rm(voice, { force: true });
      if ((i + 1) % 20 === 0 || i === scenes.length - 1) log(`Scene ${i + 1}/${scenes.length} done`);
      continue;
    }
    let clip = null;
    let animated = false;
    try {
      await wait(500);
      clip = path.join(WORK, `c${id}.mp4`);
      let bytes = null;
      if (CHANNEL === 2) {
        // First choice: a real cartoon clip that no video has used before. When none is left, use a normal clip with the cartoon filter.
        try {
          bytes = await studio(
            "/api/media/stock-clip",
            { text: sc.narration.slice(0, 400), query: sc.term, index: i + CLIP_OFFSET, style: "cartoon", strict: true },
            { raw: true },
          );
          animated = true;
        } catch {
          bytes = null;
        }
      }
      if (!bytes) {
        bytes = await studio(
          "/api/media/stock-clip",
          { text: sc.narration.slice(0, 400), query: sc.term, index: i + CLIP_OFFSET, style: CHANNEL === 2 ? "real" : STYLE },
          { raw: true },
        );
      }
      await writeFile(clip, bytes);
    } catch (e) {
      log(`Scene ${i + 1}: no clip (${e.message}); using a plain background`);
      clip = null;
    }
    const seg = path.join(WORK, `seg${id}.mp4`);
    const vf =
      (clip ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` : "") +
      // Channel 2: turn normal clips into a painted cartoon look (many more clips to choose from, so no repeats).
      (clip && CHANNEL === 2 && !animated
        ? `split[o][e];[e]edgedetect=mode=canny:low=0.10:high=0.30,negate[ed];[o]hqdn3d=8:6:10:8,eq=saturation=1.45:contrast=1.06:brightness=0.02,lutyuv=y='floor(val/16)*16+8'[c];[c][ed]blend=all_mode=multiply:all_opacity=0.75,`
        : "") +
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
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
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
  const music = SCARY
    ? "aevalsrc=0.07*sin(2*PI*55*t)+0.06*sin(2*PI*58.3*t)+0.04*sin(2*PI*82.4*t)*(0.5+0.5*sin(2*PI*0.05*t))+0.02*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*0.11*t)):s=48000:d=" + Math.ceil(total)
    : "aevalsrc=0.05*sin(2*PI*110*t)+0.04*sin(2*PI*164.8*t)+0.03*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.07*t)):s=48000:d=" +
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
  const baseTags = SCARY
    ? ["#scarystories", "#horrorstory", "#goblin", "#animatedhorror", "#creepystories", "#storytime"]
    : CHANNEL === 2
    ? ["#animation", "#cartoonstory", "#animatedstory", "#familystory", "#faith", "#hope"]
    : TONE === "emotional"
    ? ["#emotionalstory", "#sadstory", "#lifelessons", "#storytime", "#touchingstory"]
    : ["#explained", "#documentary", "#facts"];
  const hashtags = [...new Set([...baseTags, ...topicTags])].slice(0, 8);
  const description =
    `${outline.title}\n\n` +
    (SCARY
      ? `If you love scary stories, please like, share and subscribe for a new scary story every day. Would you have opened the door? Tell us in the comments.\n\n`
      : TONE === "emotional"
      ? `If this story touched your heart, please like, share and subscribe for a new emotional story every day.\n\n`
      : `Like and subscribe for more.\n\n`) +
    `${outline.sections.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
    (SCARY ? `This is an original fictional story.\n` : TONE === "emotional" ? `This is a fictional story, written for reflection and inspiration.\n` : "") +
    (SCARY ? `Made with AI narration and AI-generated artwork.\n\n` : `Made with AI narration and stock video clips from Pixabay (https://pixabay.com).\n\n`) +
    hashtags.join(" ");
  globalThis.__videoTags = hashtags.map((h) => h.slice(1));
  // Policy check (advice only; never blocks the upload).
  let policyNote = "";
  let policyRisk = "low";
  let green = true; // GREEN = every check passed. Anything else = YELLOW (stay private) or RED (rejected).
  try {
    const pc = await studio("/api/media/auto-script", {
      step: "policy",
      title: outline.title,
      description,
      script: scenes.map((x) => x.narration).join(" "),
    });
    policyRisk = pc.risk;
    if (pc.risk !== "low") green = false;
    log("Policy check:", pc.risk, JSON.stringify(pc.issues));
    if (pc.risk !== "low" && pc.issues?.length)
      policyNote = `\n\n⚠️ YouTube safety check (${pc.risk}) - look before you publish:\n` + pc.issues.map((x) => "- " + x).join("\n");
    else policyNote = "\n\n🛡 YouTube safety check: OK";
  } catch (e) {
    green = false;
    log("Policy check skipped:", String(e.message).slice(0, 80));
  }
  // Quality check (advice only): catch a video that came out too short, too small or with too few scenes.
  try {
    const { size } = await stat(final);
    const problems = [];
    if (total < 6 * 60) problems.push(`short video (${Math.round(total / 60)} min)`);
    if (size < 5 * 1024 * 1024) problems.push(`small file (${Math.round(size / 1048576)} MB)`);
    if (scenes.length < 12) problems.push(`only ${scenes.length} scenes`);
    const audio = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", final]);
    if (!audio.trim()) {
      problems.push("NO SOUND in the video");
      policyRisk = "high";
    }
    if (problems.length) green = false;
    log("Quality check:", problems.length ? problems.join(", ") : "OK");
    policyNote += problems.length ? `\n\n⚠️ Quality check: ${problems.join(", ")}. Watch it before you publish.` : "\n✅ Quality check: OK";
  } catch (e) {
    green = false;
    log("Quality check skipped:", String(e.message).slice(0, 80));
  }
  if (process.env.BLOCK_ON_HIGH !== "0" && policyRisk === "high") {
    await notify(`🛑 Video "${outline.title}" was NOT uploaded because the checks found a high risk.${policyNote}`);
    log("Blocked by checks");
    return;
  }
  log("Uploading to YouTube (private)...");
  const id = await uploadToYouTube(final, outline.title, description);
  let pubNote = "";
  const AUTO = process.env.AUTO_PUBLISH !== "0" && green;
  if (process.env.AUTO_PUBLISH !== "0" && !green) pubNote = "HELD";
  if (AUTO) {
    try { await publishVideo(id); log("Published (public)"); pubNote = "PUBLIC"; }
    catch (e) { log("auto-publish failed:", e.message); pubNote = "FAILED"; }
  }
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
  // Channel 1 stays at 1 Short per video (YouTube's daily upload quota); channel 2 gets 2.
  for (const part of CHANNEL === 2 ? [1, 2] : [1]) {
  try {
    log("Making Short", part, "...");
    const shortFile = path.join(WORK, `short${part}.mp4`);
    const tl = [];
    for (const w of outline.title.toUpperCase().split(/\s+/)) {
      const last = tl[tl.length - 1];
      if (last !== undefined && (last + " " + w).length <= 20) tl[tl.length - 1] = last + " " + w;
      else tl.push(w);
    }
    await writeFile(path.join(WORK, "short-title.txt"), tl.slice(0, 3).join("\n"));
    await run("ffmpeg", [
      "-y", "-ss", part === 1 ? "0" : String(Math.round(total * 0.45)), "-t", "55", "-i", final,
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
      `${outline.title.slice(0, part === 1 ? 85 : 78)}${part === 1 ? "" : " Part 2"} #shorts`,
      `Watch the full story: https://youtu.be/${id}\n\n${hashtags.join(" ")} #shorts`,
    );
    shortNote += `\n\nShort ${part} (1 min): https://www.youtube.com/watch?v=${shortId}&${AUTH}\nPublish it: https://studio.youtube.com/video/${shortId}/edit?${AUTH}`;
    log("Short uploaded:", shortId);
    if (AUTO) { try { await publishVideo(shortId); log("Short published"); } catch (e) { log("short publish failed:", e.message); } }
    // Also send the Short file to Telegram, ready to post on TikTok.
    try {
      const caption =
        `${outline.title} ${SCARY ? "👻" : "💔"}\nFull story on YouTube: ${CHANNEL === 2 ? "Little Hope Tales" : "@TonyNinsiima"}\n\n` +
        `${hashtags.join(" ")} #fyp #storytime ${SCARY ? "#scary" : "#emotional"}`;
      const res = await fetch(`${STUDIO}/api/automation/notify-video?caption=${encodeURIComponent(caption)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "video/mp4" },
        body: await readFile(shortFile),
      });
      log("Short sent to Telegram:", res.status);
    } catch (e) {
      log("telegram video skipped:", e.message);
    }
  } catch (e) {
    log("short skipped:", e.message);
  }
  }
  await notify(
    `✅ Your video is ${pubNote === "PUBLIC" ? "LIVE (public)" : "ready (PRIVATE)"}\n"${outline.title}" · ${Math.round(total / 60)} min\n\nWatch: https://www.youtube.com/watch?v=${id}&${AUTH}\nPublish it: https://studio.youtube.com/video/${id}/edit?${AUTH}\n\nOne-tap publish page: ${STUDIO}/go-public\n\n${pubNote === "PUBLIC" ? "It was published automatically." : pubNote === "HELD" ? "🟡 YELLOW: a check was not fully clean, so it stays PRIVATE. Watch it, then use the publish page." : pubNote === "FAILED" ? "Auto-publish failed, so it is still private. Use the publish page." : "It is private until you press Publish."}${thumbNote}${shortNote}${policyNote}`,
  );
  log("All done:", id);
}

main()
  .catch(async (e) => {
    console.error(e);
    if (e?.quota) {
      // Retrying today would only fail again. Finish quietly; tomorrow's videos continue as normal.
      await notify("⚠️ YouTube's daily upload limit is full. This video is skipped today. Tomorrow's 3 videos continue normally.");
      return;
    }
    await notify(`❌ I could not finish the video (I will try again automatically).\nReason: ${String(e.message ?? e).slice(0, 500)}`);
    process.exitCode = 1;
  })
  .finally(() => rm(WORK, { recursive: true, force: true }).catch(() => {}));
