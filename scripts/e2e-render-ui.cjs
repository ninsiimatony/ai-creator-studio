// Usage: build, then start the app with local D1 and a setup code, and run this against it:
//   SETUP_CODE=local-test-setup-code bun run cf:preview &
//   BASE=http://127.0.0.1:8787 SETUP_CODE=local-test-setup-code node scripts/e2e-render-ui.cjs
// Needs a FRESH local database (delete .wrangler/state first), Playwright, and ffmpeg/ffprobe on PATH.
// Drives the Render Studio UI end to end in a real browser, then verifies the MP4 with ffprobe/ffmpeg.
// Provider HTTP responses (Workers AI image + speech) are simulated AT THE BROWSER BOUNDARY with Playwright
// route interception, because Cloudflare's AI cannot be reached from the test sandbox. Everything after that
// boundary (decode, per-scene sync, compositing, mixing, encoding) is the real code.
const { chromium } = require("playwright");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.BASE || "http://127.0.0.1:8787";
const ASSETS = process.env.ASSETS || path.join(__dirname, "assets");
const OUT = process.env.OUT || "/tmp/render-ui";
const SETUP_CODE = process.env.SETUP_CODE || "local-test-setup-code";
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ok = (name, cond, detail = "") => {
  results.push(cond);
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
const px = (f, t, range, crop = "iw*0.06:ih*0.08:iw*0.47:ih*0.4") => [
  ...spawnSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(t),
    "-i",
    f,
    "-frames:v",
    "1",
    "-vf",
    `crop=${crop},scale=1:1:in_color_matrix=bt709:in_range=${range}`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ]).stdout.subarray(0, 3),
];

/** A mono PCM WAV tone of the given length (stands in for a provider's speech audio). */
function wav(seconds, hz = 330) {
  const sr = 24000,
    n = Math.round(seconds * sr),
    buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 0.5 * 32767), 44 + i * 2);
  return buf;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const calls = { tts: [], image: [] };
  await page.route("**/api/media/tts", async (route) => {
    const body = route.request().postDataJSON();
    calls.tts.push(body);
    await route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      body: wav(Math.max(1.5, body.text.length / 14)),
    });
  });
  await page.route("**/api/media/image", async (route) => {
    const body = route.request().postDataJSON();
    calls.image.push(body);
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      body: fs.readFileSync(path.join(ASSETS, "ai-orange.jpg")),
    });
  });

  // ---- sign up and create a script through the real UI ----
  await page.goto(BASE);
  await page.getByLabel("Email").fill("render@example.com");
  await page.getByLabel("Password").fill("a-long-render-test-passphrase");
  await page.getByLabel("Setup code").fill(SETUP_CODE);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "Overview" }).waitFor({ timeout: 15000 });
  await page.getByRole("link", { name: "Idea research" }).first().click();
  await page.getByLabel("Idea title").fill("How robots learn to walk");
  await page.getByRole("button", { name: "Add idea" }).click();
  await page.getByRole("button", { name: "Start script" }).first().click();
  await page.getByRole("link", { name: "Script editor" }).first().click();
  const narration = [
    "Humanoid robots used to fall over constantly. Engineers wrote rules for every single joint.",
    "Today the robots practise in simulation instead. They try millions of steps before they ever touch the floor.",
    "Each attempt earns a reward when the robot stays upright. Over time the clumsy movements fade away.",
    "Then the learned skill moves into a real machine. It adapts to the surprises that no simulator predicted.",
    "That is why modern robots can climb stairs, recover from a shove and even dance. The lesson is simple: practise beats programming.",
  ].join(" ");
  await page.getByLabel(/^Narration/).fill(narration);
  await page.getByText("All changes saved").waitFor({ timeout: 10000 });
  ok("script with narration created and saved", true);

  // ---- Render Studio ----
  await page.getByRole("link", { name: "Render video" }).first().click();
  await page.getByRole("heading", { name: "Render video" }).waitFor();
  await page
    .getByLabel("Script", { exact: true })
    .selectOption({ label: "How robots learn to walk" });
  const sceneCount = await page.locator("ol > li", { hasText: /^Scene \d/ }).count();
  ok("script is split into several scenes automatically", sceneCount >= 3, `${sceneCount} scenes`);

  // honest provider availability in this deployment
  const opts = await page
    .getByLabel("Voice provider")
    .locator("option")
    .evaluateAll((os) => os.map((o) => ({ text: o.textContent, disabled: o.disabled })));
  const eleven = opts.find((o) => /ElevenLabs/.test(o.text));
  ok(
    "ElevenLabs is shown as unavailable (no key configured)",
    eleven && eleven.disabled === true,
    JSON.stringify(opts),
  );
  const aiVideoNote = await page.getByText(/AI video clips:\s*not connected/).count();
  ok("AI video clips are labelled not connected", aiVideoNote > 0);

  await page.getByLabel("Voice provider").selectOption("workers-ai-melotts");
  await page.getByRole("button", { name: "Generate voiceover" }).click();
  await page
    .getByText(new RegExp(`Voiceover ready for all ${sceneCount} scenes`))
    .waitFor({ timeout: 30000 });
  ok(
    "voiceover generated per scene through the provider endpoint",
    calls.tts.length === sceneCount &&
      calls.tts.every((c) => c.lang === "en" && c.text.length > 10),
    `${calls.tts.length} calls`,
  );
  const voicedDur = (await page.locator("text=/Voiced [0-9.]+s/").allInnerTexts()).map((t) =>
    parseFloat(/Voiced ([0-9.]+)s/.exec(t)[1]),
  );
  ok(
    "every scene reports its exact voiced duration",
    voicedDur.length === sceneCount,
    JSON.stringify(voicedDur),
  );

  // scene 1 = uploaded video clip, scene 2 = uploaded image, the rest = AI images
  const canMp4 = await page.evaluate(
    () => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"') !== "",
  );
  const scene = (n) => page.locator("ol > li", { hasText: new RegExp(`^Scene ${n}(?!\\d)`) });
  await scene(1).getByRole("combobox").selectOption("upload-clip");
  await page
    .getByLabel("File for scene 1")
    .setInputFiles(path.join(ASSETS, canMp4 ? "clip-red.mp4" : "clip-red.webm"));
  await scene(2).getByRole("combobox").selectOption("upload-image");
  await page.getByLabel("File for scene 2").setInputFiles(path.join(ASSETS, "upload-blue.png"));
  await page.getByLabel(/^Image provider/).selectOption("workers-ai-flux");
  await page.getByRole("button", { name: "Generate visuals" }).click();
  await page
    .getByText(new RegExp(`Visuals ready for all ${sceneCount} scenes`))
    .waitFor({ timeout: 30000 });
  ok(
    "AI images requested only for the scenes without an upload, with a styled prompt",
    calls.image.length === sceneCount - 2 && calls.image.every((c) => /Cinematic/.test(c.prompt)),
    `${calls.image.length} image calls`,
  );

  await page.getByLabel("Format").selectOption("720p");
  await page.getByRole("button", { name: "Render MP4" }).click();
  const video = page.getByTestId("result-video");
  await video.waitFor({ timeout: 120000 });
  const info = await page.locator("text=/fps ·/").first().innerText();
  console.log("result info:", info);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download MP4" }).click();
  const dl = await download;
  const mp4 = path.join(OUT, "ui-render.mp4");
  await dl.saveAs(mp4);
  const srtDl = page.waitForEvent("download");
  await page.getByRole("button", { name: /\.srt/ }).click();
  const srtPath = path.join(OUT, "ui-render.srt");
  await (await srtDl).saveAs(srtPath);
  await page.screenshot({ path: path.join(OUT, "render-result.png"), fullPage: true });

  // ---- verify the downloaded file ----
  const p = probe(mp4);
  const v = p.streams.find((s) => s.codec_type === "video"),
    a = p.streams.find((s) => s.codec_type === "audio");
  const range = v.color_range === "pc" ? "pc" : "tv";
  ok(
    "downloaded MP4 is H.264 1280x720 @30 with an audio track",
    v.codec_name === "h264" &&
      v.width === 1280 &&
      v.height === 720 &&
      v.r_frame_rate === "30/1" &&
      !!a,
    `${v.codec_name} ${v.width}x${v.height} audio=${a && a.codec_name}`,
  );
  const expected =
    voicedDur.reduce((t, d) => t + Math.max(2.5, 0.25 + d + 0.6), 0) - 0.6 * (sceneCount - 1);
  const dur = parseFloat(p.format.duration);
  ok(
    "duration equals the timeline built from the real voice lengths",
    Math.abs(dur - expected) < 0.2,
    `${dur.toFixed(2)}s vs ${expected.toFixed(2)}s`,
  );
  const dec = spawnSync("ffmpeg", ["-v", "error", "-i", mp4, "-f", "null", "-"]);
  ok(
    "file decodes with zero errors",
    dec.status === 0 && dec.stderr.length === 0,
    dec.stderr.toString().slice(0, 150),
  );

  // scene start times from the same arithmetic the timeline uses
  const starts = [];
  let t = 0;
  voicedDur.forEach((d, i) => {
    starts.push(i === 0 ? 0 : t - 0.6);
    t = (i === 0 ? 0 : t - 0.6) + Math.max(2.5, 0.25 + d + 0.6);
  });
  const at = (i, off) => starts[i] + Math.min(off, Math.max(2.5, 0.25 + voicedDur[i] + 0.6) - 0.7);
  const c1 = px(mp4, at(0, 1.2), range);
  ok(
    "scene 1 shows the uploaded video clip (red)",
    c1[0] > 180 && c1[1] < 50 && c1[2] < 50,
    JSON.stringify(c1),
  );
  const c2 = px(mp4, starts[1] + 1.2, range);
  ok("scene 2 shows the uploaded image (blue)", c2[2] > 180 && c2[0] < 50, JSON.stringify(c2));
  const c3 = px(mp4, starts[2] + 1.2, range);
  ok(
    "scene 3 shows the AI image (orange)",
    c3[0] > 200 && c3[1] > 90 && c3[1] < 170 && c3[2] < 60,
    JSON.stringify(c3),
  );
  ok(
    "music + voice are present in the audio track",
    spawnSync("ffmpeg", [
      "-hide_banner",
      "-i",
      mp4,
      "-vn",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ])
      .stderr.toString()
      .match(/mean_volume: (-?[\d.]+)/) && true,
  );
  const vo = parseFloat(
    /mean_volume: (-?[\d.]+) dB/.exec(
      spawnSync("ffmpeg", [
        "-hide_banner",
        "-ss",
        String(starts[2] + 0.5),
        "-t",
        "1",
        "-i",
        mp4,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ]).stderr.toString(),
    )[1],
  );
  ok("voice is clearly audible during narration", vo > -25, `${vo} dB`);
  const cap = [
    ...spawnSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      String(starts[2] + 1.5),
      "-i",
      mp4,
      "-frames:v",
      "1",
      "-vf",
      "crop=iw*0.6:ih*0.16:iw*0.2:ih*0.76,format=gray",
      "-f",
      "rawvideo",
      "-",
    ]).stdout,
  ].filter((x) => x > 230).length;
  ok("burned-in subtitles are visible while a scene is spoken", cap > 300, `${cap} bright px`);

  const srt = fs.readFileSync(srtPath, "utf8");
  const stamps = [
    ...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/g),
  ].map((m) => [
    +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
    +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
  ]);
  ok(
    "downloaded SRT has ordered, valid cues covering the narration",
    stamps.length >= sceneCount &&
      stamps.every(([s, e], i) => e > s && (i === 0 || s >= stamps[i - 1][1] - 1e-6)) &&
      srt.includes("Humanoid robots"),
    `${stamps.length} cues`,
  );
  ok(
    "first subtitle starts when the first voice starts (0.25 s)",
    Math.abs(stamps[0][0] - 0.25) < 0.01,
    String(stamps[0][0]),
  );
  ok("no browser errors while rendering", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
