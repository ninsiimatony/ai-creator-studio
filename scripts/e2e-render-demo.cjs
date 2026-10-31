// Usage: npx vite dev --host 127.0.0.1 --port 5199 &   then   BASE=http://127.0.0.1:5199 node scripts/e2e-render-demo.cjs
// Needs Playwright and ffmpeg/ffprobe on PATH.
// No-keys path: demo mode (no database, no providers). Title cards + generated music + reading-pace timing.
const { chromium } = require("playwright");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs"),
  path = require("node:path");
const BASE = process.env.BASE || "http://127.0.0.1:5199",
  OUT = process.env.OUT || "/tmp/render-demo";
fs.mkdirSync(OUT, { recursive: true });
const res = [];
const ok = (n, c, d = "") => {
  res.push(c);
  console.log(c ? "PASS" : "FAIL", n, d);
};
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(BASE + "/");
  await p
    .getByText(/Demo mode/)
    .first()
    .waitFor({ timeout: 20000 });
  await p.getByRole("link", { name: "Script editor" }).first().click();
  await p
    .getByLabel(/^Narration/)
    .fill(
      "Robots learn by practising in simulation. They try millions of steps before touching the floor. Each success earns a reward, and clumsy movements fade away. The lesson is simple: practice beats programming.",
    );
  await p.getByRole("link", { name: "Render video" }).first().click();
  await p.getByLabel("Script", { exact: true }).selectOption({ index: 1 });
  const providers = await p
    .getByLabel("Voice provider")
    .locator("option")
    .evaluateAll((os) => os.map((o) => [o.textContent, o.disabled]));
  ok(
    "server voice providers are disabled in demo mode, 'no voiceover' is available",
    providers.filter(([, d]) => d).length === 2 &&
      providers.some(([t, d]) => /No voiceover/.test(t) && !d),
    JSON.stringify(providers),
  );
  const img = await p
    .getByLabel("Image provider")
    .locator("option")
    .evaluateAll((os) => os.map((o) => [o.textContent, o.disabled]));
  ok(
    "AI image provider is disabled in demo mode, title cards available",
    img.some(([t, d]) => /Title cards/.test(t) && !d) && img.some(([t, d]) => /FLUX/.test(t) && d),
    JSON.stringify(img),
  );
  await p.getByLabel("Format").selectOption("shorts");
  await p.getByRole("button", { name: "Render MP4" }).click();
  await p.getByTestId("result-video").waitFor({ timeout: 120000 });
  const dl = p.waitForEvent("download");
  await p.getByRole("link", { name: "Download MP4" }).click();
  const f = path.join(OUT, "demo.mp4");
  await (await dl).saveAs(f);
  const pr = JSON.parse(
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
  const v = pr.streams.find((s) => s.codec_type === "video"),
    a = pr.streams.find((s) => s.codec_type === "audio");
  ok(
    "Shorts format: 1080x1920 H.264",
    v.width === 1080 && v.height === 1920 && v.codec_name === "h264",
    `${v.width}x${v.height}`,
  );
  ok("has an audio track from the generated music, even with no voiceover", !!a, a && a.codec_name);
  ok(
    "decodes with zero errors",
    spawnSync("ffmpeg", ["-v", "error", "-i", f, "-f", "null", "-"]).stderr.length === 0,
  );
  const cap = [
    ...spawnSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      "1.5",
      "-i",
      f,
      "-frames:v",
      "1",
      "-vf",
      "crop=iw*0.9:ih*0.2:iw*0.05:ih*0.55,format=gray",
      "-f",
      "rawvideo",
      "-",
    ]).stdout,
  ].filter((x) => x > 230).length;
  ok("subtitles are burned in (reading-pace timing)", cap > 300, `${cap} bright px`);
  ok("no browser errors", errs.length === 0, errs.slice(0, 2).join("|"));
  await b.close();
  const n = res.filter(Boolean).length;
  console.log(`\n${n}/${res.length} passed`);
  process.exit(n === res.length ? 0 : 1);
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
