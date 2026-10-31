// Render verification harness. Renders real MP4s with the engine in headless Chromium, then checks them
// independently with ffprobe/ffmpeg (codecs, size, duration, colour, transitions, subtitles, voice sync, audio).
//
// Requirements: Playwright (any version with Chromium), ffmpeg + ffprobe on PATH.
// Usage:
//   npx vite dev --host 127.0.0.1 --port 5199 &      # the engine is loaded straight from src/ by the dev server
//   BASE=http://127.0.0.1:5199 OUT=/tmp/render-verify NO_PROXY=127.0.0.1 node scripts/verify-render.cjs
// Exit code 0 means every check passed.
// Renders MP4s in headless Chromium using the real engine, then verifies them with ffprobe/ffmpeg.
const { chromium } = require("playwright");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const BASE = process.env.BASE || "http://127.0.0.1:5199";
const OUT = process.env.OUT || "/tmp/render-verify";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, detail = "") => {
  results.push([cond ? "PASS" : "FAIL", name, detail]);
  console.log(cond ? "PASS" : "FAIL", name, detail);
};
const probe = (f) =>
  JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      f,
    ]).toString(),
  );
const declaredRange = (f) => {
  const v = probe(f).streams.find((x) => x.codec_type === "video");
  return v.color_range === "pc" ? "pc" : "tv";
};
const pixel = (f, t, crop = "iw*0.08:ih*0.1:iw*0.46:ih*0.45") => {
  // Decode the way a correct player does: using the colour range the file itself declares, BT.709.
  const r = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(t),
    "-i",
    f,
    "-frames:v",
    "1",
    "-vf",
    `crop=${crop},scale=1:1:in_color_matrix=bt709:in_range=${declaredRange(f)}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]);
  return [...r.stdout.subarray(0, 3)];
};
const meanVolume = (f, ss, t) => {
  const r = spawnSync("ffmpeg", [
    "-hide_banner",
    "-ss",
    String(ss),
    "-t",
    String(t),
    "-i",
    f,
    "-vn",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr.toString());
  return m ? parseFloat(m[1]) : -99;
};

const PAGE_FN = `async (cfg) => {
  const [{ buildTimeline }, { buildSubtitleCues, toSrt }, { renderVideo }, { mixAudio, generateAmbientLoop }, { canvasAsset }, { getPreset }] = await Promise.all([
    import('/src/render/timeline.ts'), import('/src/render/subtitles.ts'), import('/src/render/renderer.ts'),
    import('/src/render/audio.ts'), import('/src/render/assets.ts'), import('/src/render/presets.ts'),
  ]);
  const preset = getPreset(cfg.preset);
  const sr = 48000;
  const tone = async (sec, hz = 440) => {
    const ctx = new OfflineAudioContext(2, Math.ceil(sec * sr), sr);
    const o = ctx.createOscillator(); o.frequency.value = hz; const g = ctx.createGain(); g.gain.value = 0.5;
    o.connect(g).connect(ctx.destination); o.start(); return ctx.startRendering();
  };
  const solid = (color) => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0,0,640,360); return c; };
  const colors = cfg.colors;
  const scenes = cfg.voices.map((v, i) => ({ id: 's'+i, narration: cfg.narration[i], voiceSeconds: v, transition: cfg.transitions[i], motion: 'none', overlayText: undefined }));
  const tl = buildTimeline(scenes, { transitionSec: 0.6 });
  const assets = new Map(tl.scenes.map((s, i) => [s.id, canvasAsset(solid(colors[i]))]));
  const voice = [];
  for (let i = 0; i < tl.scenes.length; i++) voice.push({ buffer: await tone(cfg.voices[i]), start: tl.scenes[i].voiceStart });
  const music = cfg.music ? { buffer: await generateAmbientLoop(sr), volume: 0.2, duck: true } : undefined;
  const audio = await mixAudio({ duration: tl.duration, sampleRate: sr, voice, music });
  const cues = buildSubtitleCues(tl, { maxChars: preset.height > preset.width ? 26 : 42 });
  const t0 = performance.now();
  const progress = [];
  const res = await renderVideo({ timeline: tl, assets, audio: cfg.silent ? null : audio, cues, burnSubtitles: cfg.burn, preset, onProgress: (p) => progress.push(p.phase) });
  const buf = new Uint8Array(await res.blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { b64: btoa(bin), info: res.info, tl, srt: toSrt(cues), ms: Math.round(performance.now() - t0), phases: [...new Set(progress)] };
}`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(BASE + "/");
  await page.waitForTimeout(1500);
  // Vite's dev server may re-optimise dependencies on first import and reload the page; warm up and retry.
  const run = async (cfg) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await page.evaluate(`(${PAGE_FN})(${JSON.stringify(cfg)})`);
      } catch (e) {
        if (!/context was destroyed|Target closed/.test(String(e.message))) throw e;
        await page.waitForLoadState("load");
        await page.waitForTimeout(2500);
      }
    }
    throw new Error("page kept reloading");
  };
  for (let i = 0; i < 3; i++) {
    try {
      await page.evaluate(
        "Promise.all([import('/src/render/renderer.ts'), import('/src/render/audio.ts'), import('/src/render/assets.ts')]).then(() => 1)",
      );
      break;
    } catch {
      await page.waitForLoadState("load");
      await page.waitForTimeout(2500);
    }
  }

  // ---- Case 1: 1080p, voice + music + burned subtitles + 3 transition kinds ----
  const cfg1 = {
    preset: "1080p",
    voices: [3, 3, 3, 3],
    colors: ["#e00000", "#0000e0", "#00b000", "#e0e000"],
    transitions: ["none", "crossfade", "slide-left", "wipe"],
    narration: [
      "Red scene narration goes right here.",
      "Blue scene follows with more words to read.",
      "Green scene is third.",
      "Yellow scene closes the video.",
    ],
    music: true,
    burn: true,
  };
  let r = await run(cfg1);
  const f1 = OUT + "/case1-1080p.mp4";
  fs.writeFileSync(f1, Buffer.from(r.b64, "base64"));
  fs.writeFileSync(OUT + "/case1.srt", r.srt);
  console.log(
    `rendered case 1 in ${r.ms} ms, ${r.info.bytes} bytes, codecs ${r.info.videoCodec}+${r.info.audioCodec}`,
  );
  const p1 = probe(f1);
  const v = p1.streams.find((s) => s.codec_type === "video"),
    a = p1.streams.find((s) => s.codec_type === "audio");
  ok(
    "1080p: video stream is H.264 1920x1080 @30fps",
    v &&
      v.codec_name === "h264" &&
      v.width === 1920 &&
      v.height === 1080 &&
      v.r_frame_rate === "30/1",
    v && `${v.codec_name} ${v.width}x${v.height} ${v.r_frame_rate} profile=${v.profile}`,
  );
  ok(
    "1080p: yuv420p with BT.709 colour matrix and primaries declared",
    (v && v.pix_fmt.startsWith("yuv420p")) || v.pix_fmt === "yuvj420p",
    v &&
      `pix_fmt=${v.pix_fmt} range=${v.color_range} space=${v.color_space} primaries=${v.color_primaries} trc=${v.color_transfer}`,
  );
  ok(
    "1080p: colour matrix is bt709 and primaries bt709",
    v.color_space === "bt709" && v.color_primaries === "bt709",
    `${v.color_space}/${v.color_primaries}`,
  );
  {
    // The container's colour tag (colr box) must agree with what the H.264 stream (SPS) declares.
    const buf = fs.readFileSync(f1);
    const i = buf.indexOf("colr");
    const nclx = buf.subarray(i + 4, i + 8).toString("latin1");
    const prim = buf.readUInt16BE(i + 8),
      trc = buf.readUInt16BE(i + 10),
      mat = buf.readUInt16BE(i + 12),
      full = (buf[i + 14] & 0x80) !== 0;
    const tr = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "trace",
      "-i",
      f1,
      "-c:v",
      "copy",
      "-bsf:v",
      "trace_headers",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ]).stderr.toString();
    const g = (name) => {
      const m = new RegExp(name + "\\s+[01]+ = (\\d+)").exec(tr);
      return m ? +m[1] : undefined;
    };
    const sps = {
      full: g("video_full_range_flag") === 1,
      prim: g("colour_primaries"),
      trc: g("transfer_characteristics"),
      mat: g("matrix_coefficients"),
    };
    ok(
      "1080p: container colour tag agrees with the H.264 stream (no conflicting signals)",
      nclx === "nclx" &&
        prim === sps.prim &&
        trc === sps.trc &&
        mat === sps.mat &&
        full === sps.full,
      JSON.stringify({ container: { prim, trc, mat, full }, stream: sps }),
    );
  }
  ok(
    "1080p: has an audio stream, stereo 48 kHz",
    a && a.channels === 2 && a.sample_rate === "48000",
    a && `${a.codec_name} ${a.channels}ch ${a.sample_rate}`,
  );
  const dur = parseFloat(p1.format.duration);
  ok(
    "1080p: container duration matches the timeline",
    Math.abs(dur - r.tl.duration) < 0.15,
    `${dur.toFixed(3)}s vs ${r.tl.duration.toFixed(3)}s`,
  );
  ok(
    "1080p: audio and video lengths agree within 100 ms",
    a && v && Math.abs(parseFloat(a.duration) - parseFloat(v.duration)) < 0.1,
    a && `${a.duration} vs ${v.duration}`,
  );
  console.log(
    "INFO 1080p file bitrate (solid-colour test content compresses extremely well):",
    p1.format.bit_rate,
    "bps",
  );
  // faststart: moov must come before mdat so YouTube/streaming can start immediately
  const head = fs.readFileSync(f1).subarray(0, 4096).toString("latin1");
  ok(
    "1080p: MP4 is fast-start (moov before mdat)",
    head.indexOf("moov") > 0 &&
      head.indexOf("moov") <
        (fs.readFileSync(f1).toString("latin1").indexOf("mdat") === -1
          ? 1e9
          : fs.readFileSync(f1).toString("latin1").indexOf("mdat")),
    "",
  );
  const dec = spawnSync("ffmpeg", ["-v", "error", "-i", f1, "-f", "null", "-"]);
  ok(
    "1080p: the whole file decodes with zero errors",
    dec.status === 0 && dec.stderr.toString().trim() === "",
    dec.stderr.toString().slice(0, 200),
  );
  const frames = parseInt(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      f1,
    ]).toString(),
  );
  ok(
    "1080p: frame count equals duration x fps",
    Math.abs(frames - Math.ceil(r.tl.duration * 30)) <= 1,
    `${frames} frames`,
  );

  // visuals: scene colours and the crossfade blend
  const [s0, s1, s2, s3] = r.tl.scenes;
  const red = pixel(f1, s0.start + 1.0);
  const near = (px, rgb, tol = 12) => px.every((x, i) => Math.abs(x - rgb[i]) <= tol);
  ok(
    "scene 1 colour is accurate: #e00000 -> within 12 per channel",
    near(red, [224, 0, 0]),
    JSON.stringify(red),
  );
  const blue = pixel(f1, s1.start + s1.transitionSec + 1.0);
  ok("scene 2 colour is accurate: #0000e0", near(blue, [0, 0, 224]), JSON.stringify(blue));
  const mid = pixel(f1, s1.start + s1.transitionSec * 0.5);
  ok(
    "mid-crossfade frame is a real blend: ~50% red + ~50% blue",
    Math.abs(mid[0] - 112) < 25 && Math.abs(mid[2] - 112) < 25 && mid[1] < 20,
    JSON.stringify(mid),
  );
  const slideMid = pixel(f1, s2.start + s2.transitionSec * 0.5, "iw/4:ih/4:iw/2:ih/2");
  const edge = (x) =>
    pixel(f1, s2.start + s2.transitionSec * 0.5, `iw*0.08:ih*0.1:iw*${x}:ih*0.45`);
  const left = edge(0.02),
    right = edge(0.9);
  ok(
    "mid-slide frame: blue on the far left, green on the far right",
    left[2] > 150 && left[1] < 60 && right[1] > 130 && right[2] < 60,
    JSON.stringify({ left, right }),
  );
  const green = pixel(f1, s2.start + s2.transitionSec + 1.0);
  ok("scene 3 colour is accurate: #00b000", near(green, [0, 176, 0]), JSON.stringify(green));
  const yellow = pixel(f1, s3.start + s3.transitionSec + 1.0);
  ok(
    "scene 4 colour is accurate after the wipe: #e0e000",
    near(yellow, [224, 224, 0]),
    JSON.stringify(yellow),
  );
  const end = pixel(f1, r.tl.duration - 0.04);
  ok("the video fades to black at the end", end[0] + end[1] + end[2] < 40, JSON.stringify(end));
  // burned-in subtitles: the strip where captions are drawn must contain bright text pixels while speaking
  const cap = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(s0.voiceStart + 1),
    "-i",
    f1,
    "-frames:v",
    "1",
    "-vf",
    "crop=iw*0.6:ih*0.14:iw*0.2:ih*0.78,format=gray",
    "-f",
    "rawvideo",
    "-",
  ]);
  const white = [...cap.stdout].filter((x) => x > 230).length;
  ok("burned-in subtitle text is visible while speaking", white > 500, `${white} bright pixels`);
  const nocap = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "0.05",
    "-i",
    f1,
    "-frames:v",
    "1",
    "-vf",
    "crop=iw*0.6:ih*0.14:iw*0.2:ih*0.78,format=gray",
    "-f",
    "rawvideo",
    "-",
  ]);
  ok(
    "no subtitle text before anyone speaks",
    [...nocap.stdout].filter((x) => x > 230).length < 50,
    "",
  );

  // audio: voice louder than the gap, and music ducks under speech
  const vo = meanVolume(f1, s0.voiceStart + 0.5, 2);
  const gap = meanVolume(f1, s0.voiceStart + s0.voiceDuration + 0.03, 0.12);
  ok(
    "audible voice during speech, much quieter in the gap after it",
    vo > -20 && gap < vo - 8,
    `voice ${vo} dB, gap ${gap} dB`,
  );

  // ---- Case 2: exact voice sync, measured. No music, no subtitles. ----
  const cfg2 = {
    preset: "720p",
    voices: [2, 2.5, 3],
    colors: ["#400000", "#000040", "#004000"],
    transitions: ["none", "crossfade", "crossfade"],
    narration: ["One.", "Two.", "Three."],
    music: false,
    burn: false,
  };
  r = await run(cfg2);
  const f2 = OUT + "/case2-sync-720p.mp4";
  fs.writeFileSync(f2, Buffer.from(r.b64, "base64"));
  const sd = spawnSync("ffmpeg", [
    "-hide_banner",
    "-i",
    f2,
    "-vn",
    "-af",
    "silencedetect=noise=-40dB:d=0.1",
    "-f",
    "null",
    "-",
  ]).stderr.toString();
  const starts = [...sd.matchAll(/silence_end: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...sd.matchAll(/silence_start: ([\d.]+)/g)].map((m) => parseFloat(m[1]));
  r.tl.scenes.forEach((s, i) => {
    const onset = starts[i],
      off = ends[i + 1];
    ok(
      `sync: scene ${i + 1} voice starts at the timeline time (±60 ms)`,
      onset !== undefined && Math.abs(onset - s.voiceStart) < 0.06,
      `expected ${s.voiceStart.toFixed(3)}s, measured ${onset}`,
    );
    ok(
      `sync: scene ${i + 1} voice lasts its true duration (±80 ms)`,
      onset !== undefined && off !== undefined && Math.abs(off - onset - s.voiceDuration) < 0.08,
      `expected ${s.voiceDuration}s, measured ${off !== undefined && onset !== undefined ? (off - onset).toFixed(3) : "n/a"}`,
    );
  });
  const v2 = probe(f2).streams.find((s) => s.codec_type === "video");
  ok(
    "720p: 1280x720 H.264",
    v2.width === 1280 && v2.height === 720 && v2.codec_name === "h264",
    `${v2.width}x${v2.height} ${v2.codec_name}`,
  );

  // ---- Case 3: Shorts 9:16 ----
  const cfg3 = {
    preset: "shorts",
    voices: [2, 2],
    colors: ["#e00000", "#0000e0"],
    transitions: ["none", "zoom"],
    narration: ["Vertical video for Shorts works too.", "Second short scene."],
    music: true,
    burn: true,
  };
  r = await run(cfg3);
  const f3 = OUT + "/case3-shorts.mp4";
  fs.writeFileSync(f3, Buffer.from(r.b64, "base64"));
  const v3 = probe(f3).streams.find((s) => s.codec_type === "video");
  ok(
    "Shorts: 1080x1920 portrait, decodes cleanly",
    v3.width === 1080 &&
      v3.height === 1920 &&
      spawnSync("ffmpeg", ["-v", "error", "-i", f3, "-f", "null", "-"]).stderr.length === 0,
    `${v3.width}x${v3.height}`,
  );

  // ---- Case 4: silent video (no audio track) ----
  r = await run({ ...cfg3, preset: "720p", silent: true, music: false });
  const f4 = OUT + "/case4-silent.mp4";
  fs.writeFileSync(f4, Buffer.from(r.b64, "base64"));
  const p4 = probe(f4);
  ok(
    "silent render has a video stream and no audio stream",
    p4.streams.some((s) => s.codec_type === "video") &&
      !p4.streams.some((s) => s.codec_type === "audio"),
    "",
  );

  ok("no browser errors during rendering", errs.length === 0, errs.slice(0, 3).join(" | "));
  await browser.close();
  const fails = results.filter((x) => x[0] === "FAIL");
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  console.log(
    "Codec path used in this browser:",
    `${r.info.videoCodec} + ${r.info.audioCodec}`,
    "| YouTube-recommended H.264+AAC:",
    r.info.youtubeRecommended,
  );
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
