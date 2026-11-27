// Makes a video from a topic using only free services, then uploads it to YouTube as PRIVATE.
// Runs on a GitHub Actions computer (ffmpeg installed). Talks to the studio with the AUTOMATION_SECRET.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm, stat, open, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as ltx from "./kaggle-ltx.mjs";
import { makeExtras, fullSrt } from "./extras.mjs";

const STUDIO = (process.env.STUDIO_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.AUTOMATION_SECRET ?? "";
const TOPIC = (process.env.TOPIC ?? "").trim();
const MINUTES = Math.min(90, Math.max(3, Number(process.env.MINUTES) || 10));
const TONE = process.env.TONE === "emotional" ? "emotional" : process.env.TONE === "scary" ? "scary" : process.env.TONE === "wonder" ? "wonder" : undefined;
const SCARY = TONE === "scary";
// Channel 3: nature, space and old-world documentaries made from free licensed clips (Pexels, Pixabay, NASA, Internet Archive, Wikimedia) plus a few AI pictures.
const WONDER = TONE === "wonder";
const USED_SOURCES = new Set(); // where this video's clips came from (named in the description)
const SOURCE_NAMES = {
  pexels: "Pexels (https://www.pexels.com)",
  pixabay: "Pixabay (https://pixabay.com)",
  nasa: "NASA Image and Video Library (https://images.nasa.gov)",
  archive: "Internet Archive, public-domain films (https://archive.org)",
  wikimedia: "Wikimedia Commons, public-domain files (https://commons.wikimedia.org)",
};
let USED_AI_PICTURES = false;
// Look of every picture in the scary channel (one recurring goblin keeper, original character design).
const GOBLIN_STYLE =
  "Stylized 3D animated horror-cartoon film still, wide cinematic shot, dark moody lighting, blue and green fog, no text. " +
  "A small pale gray-green goblin keeper with huge bloodshot yellow eyes, long drooping pointed ears, tiny sharp teeth and a ragged green-and-black striped sweater appears in the scene. Scene: ";
// Picture variety for the goblin channel: same goblin look every time, but new camera, light and framing for every picture.
const CAMERAS = ["wide establishing shot", "medium shot", "extreme close-up", "low angle looking up", "high angle looking down",
  "over-the-shoulder shot", "silhouette against a window", "detail insert shot of an object", "dutch tilt angle", "shot through a half-open doorway"];
const LIGHTS = ["candlelight", "cold blue moonlight", "a swinging lantern", "dawn fog", "a lightning flash", "eerie green glow from below",
  "a flickering bulb", "warm firelight", "torchlight beam", "stormy grey daylight"];
const PIC_OFFSET = Math.floor(Math.random() * 10);
// Chapter start time (seconds) of each story part, for YouTube chapters in the description.
const CHAPTER_AT = {};
let CHAPTER_T = 0;
const SRT_PARTS = []; // { start, dur, narration } per scene, for one full subtitle file
let THUMB_FILE = null;
// Channel 2 look since 2026-11-12: dark, realistic night photographs (like scary-story compilation channels), no cartoons,
// no faces. Varied camera and light every picture. (The goblin cartoon look is kept in git history.)
const NIGHT_LIGHTS = ["a single porch light", "cold moonlight", "a flickering street lamp", "car headlights in fog", "a lit window in the dark",
  "a lightning flash", "a red exit sign glow", "a flashlight beam", "dim yellow motel lights", "a faint blue TV glow"];
function nightPrompt(chunk, n, g = null) {
  const cam = CAMERAS[(n + PIC_OFFSET) % CAMERAS.length];
  const light = NIGHT_LIGHTS[(n * 3 + PIC_OFFSET) % NIGHT_LIGHTS.length];
  if (CHANNEL === 4) return `Terrifying realistic horror film still at night in rural Uganda: mud-brick houses, red dirt path, banana trees, mist, faint lantern light, dark shadows, cinematic, grainy, no text. ${g === "m" ? "Any person shown is a Ugandan man, seen from behind or in shadow. " : g === "f" ? "Any person shown is a Ugandan woman, seen from behind or in shadow. " : ""}${cam}. ${light}. Scene: ${chunk}`.slice(0, 590);
  return `Realistic dark night photograph, eerie and quiet, slightly grainy amateur camera look, deep shadows, muted colors, no people's faces, no text, no words. Camera: ${cam}. Lighting: ${light}. Scene: ${chunk}`;
}
function goblinPrompt(chunk, n) {
  const cam = CAMERAS[(n + PIC_OFFSET) % CAMERAS.length];
  const light = LIGHTS[(n * 3 + PIC_OFFSET) % LIGHTS.length];
  // The goblin is in about 2 of every 3 pictures; the others show the place, the guests and the strange things.
  const withGoblin = n % 3 !== 2;
  const base = "Stylized 3D animated horror-cartoon film still, moody, rich detail, no text, no words. ";
  const who = withGoblin
    ? "Grub, a small goblin keeper: pale gray-green skin, very large round bloodshot yellow eyes, long drooping pointed ears, tiny sharp teeth, ragged green-and-black striped sweater. "
    : "No goblin in this picture; show the place, the people and the strange thing. ";
  return `${base}${who}Camera: ${cam}. Lighting: ${light}. Scene: ${chunk}`;
}
const STYLE = process.env.STYLE === "cartoon" ? "cartoon" : "real";
const W = MINUTES > 30 ? 1280 : 1920;
const H = MINUTES > 30 ? 720 : 1080;
const WORK = path.join(os.tmpdir(), "videobot");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Natural human-sounding voices (free Microsoft neural voices). One voice per video, picked from the topic.
// If they are not reachable, we fall back to the studio's built-in voice, so a video is never lost.
const EDGE_VOICES = WONDER
  ? ["en-GB-RyanNeural", "en-US-AndrewNeural", "en-GB-ThomasNeural", "en-US-BrianNeural"] // calm documentary-style narrators
  : ["en-US-AndrewNeural", "en-US-AvaNeural", "en-US-GuyNeural", "en-US-JennyNeural"];
const EDGE_VOICE = SCARY ? "en-US-ChristopherNeural" : EDGE_VOICES[[...TOPIC].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % EDGE_VOICES.length];
let edgeFails = 0;
let USED_KOKORO = false;
let AI_ALLOWANCE_GONE = false; // set when Workers AI says the free daily allowance is used up
// Kokoro: free, human-sounding voice (Apache-2.0) that runs on the runner's CPU. Used first for the channels in
// KOKORO_CHANNELS (repo variable, default "3"), because it adds about 8 minutes per video and the private repo has
// 2,000 free GitHub minutes a month. One fixed voice per channel so each channel sounds like itself.
// (Functions, not constants: CHANNEL is defined further down this file.)
const kokoroOn = () => (process.env.KOKORO_CHANNELS || "3").split(",").map((x) => x.trim()).includes(String(CHANNEL));
const kokoroVoice = () => CHANNEL === 3 ? { voice: "bm_george", lang: "en-gb", speed: 0.95 } : CHANNEL === 2 ? { voice: "am_michael", lang: "en-us", speed: 0.9 } : { voice: "af_heart", lang: "en-us", speed: 0.97 };
let kokoro = null; // { proc, waiters, ready }
let kokoroFails = 0;
function kokoroStart() {
  if (kokoro) return kokoro.ready;
  const proc = spawn("python3", [path.join(path.dirname(new URL(import.meta.url).pathname), "kokoro_tts.py")], { stdio: ["pipe", "pipe", "pipe"] });
  const waiters = [];
  let buf = "";
  let resolveReady;
  // Keep-alive: the helper is unref'd below, so while we wait for it (model loading) node would see nothing
  // pending and exit silently with code 0 (this happened on 2026-11-13). This timer keeps the bot alive until ready/failed.
  const keepAlive = setInterval(() => {}, 1000);
  const readyTimer = setTimeout(() => { log("Kokoro voice not ready after 4 minutes, using the next voice"); resolveReady(false); }, 4 * 60 * 1000);
  const ready = new Promise((r) => (resolveReady = (v) => { clearInterval(keepAlive); clearTimeout(readyTimer); r(v); }));
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === "ready") { resolveReady(true); continue; }
      if (line.startsWith("err") && !kokoro.started) { resolveReady(false); log("Kokoro voice not available:", line.slice(4, 200)); continue; }
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  proc.stderr.on("data", () => {});
  // Never let this helper keep the bot alive after the video is done (even if something crashes).
  proc.unref(); proc.stdin.unref?.(); proc.stdout.unref?.(); proc.stderr.unref?.();
  proc.on("exit", () => { resolveReady(false); while (waiters.length) waiters.shift()("err exited"); if (kokoro) kokoro.dead = true; });
  kokoro = { proc, waiters, ready, started: false, dead: false };
  return ready;
}
function kokoroStop() {
  if (kokoro && !kokoro.dead) { try { kokoro.proc.stdin.end(); kokoro.proc.kill(); } catch {} }
  kokoro = null;
}
async function kokoroSpeak(text, file) {
  if (!(await kokoroStart()) || kokoro.dead) throw new Error("kokoro not running");
  kokoro.started = true;
  const reply = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("kokoro timeout")), 5 * 60 * 1000);
    kokoro.waiters.push((line) => { clearTimeout(t); resolve(line); });
    kokoro.proc.stdin.write(JSON.stringify({ text, file, ...kokoroVoice() }) + "\n");
  });
  if (!reply.startsWith("ok")) throw new Error(reply.slice(0, 200));
  const st = await stat(file);
  if (st.size < 2000) throw new Error("empty audio");
}


// ---- Channel 4 (Night Tales Uganda): Luganda text and voice from Sunbird AI (the same engine as the Ensi AI site) ----
const SUNBIRD = "https://api.sunbird.ai";
let sunbirdLogin = "";
// The key page on Sunbird cannot copy the whole key, so the robot can also log in itself (email + password in GitHub secrets) to get a fresh 7-day key.
const sunbirdKey = () => sunbirdLogin || process.env.SUNBIRD_API_TOKEN || "";
async function sunbirdSignIn() {
  const user = process.env.SUNBIRD_USERNAME, pass = process.env.SUNBIRD_PASSWORD;
  if (!user || !pass || sunbirdLogin) return;
  // Sunbird logs in by username (Channel 4's account is "tony"); also try what was saved and the part before the @.
  const names = [...new Set([user, process.env.SUNBIRD_LOGIN_NAME || "tony", user.split("@")[0]])];
  let res = null;
  for (const name of names) {
    res = await fetch(SUNBIRD + "/auth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: name, password: pass }) });
    if (res.ok) break;
  }
  if (!res || !res.ok) throw new Error(`Sunbird login failed (${res?.status}) - check SUNBIRD_PASSWORD and that the email is verified`);
  sunbirdLogin = String((await res.json())?.access_token ?? "");
  if (!sunbirdLogin) throw new Error("Sunbird login returned no key");
  log("Signed in to Sunbird");
}
async function sunbirdFetch(pathname, init, tries = 5) {
  await sunbirdSignIn();
  let last = "";
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(SUNBIRD + pathname, { ...init, headers: { authorization: `Bearer ${sunbirdKey()}`, ...(init.headers || {}) } });
      if (res.ok) return res;
      last = `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
      if (res.status === 401 || res.status === 403) { const k = sunbirdKey(); throw new Error(`Sunbird key rejected (${last}) [key shape: length ${k.length}, starts eyJ: ${k.startsWith("eyJ")}, dots: ${k.split(".").length - 1}, has space/newline: ${/\s/.test(k)}, has quotes: ${/["']/.test(k)}]`); }
      if (res.status === 400 || res.status === 422) throw new Error(`Sunbird refused the request (${last})`);
    } catch (e) {
      if (/Sunbird (key|refused)/.test(String(e.message))) throw e;
      last = String(e.message).slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 4000 * (a + 1)));
  }
  throw new Error("Sunbird failed: " + last);
}
/** Free backup translator: Cloudflare m2m100 on Channel 4's own Cloudflare account (Luganda = "lg"), through the studio. */
async function toLugandaFree(clean) {
  const sentences = clean.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const pieces = [];
  let cur = "";
  for (const sn of sentences) {
    if ((cur + " " + sn).length > 900 && cur) { pieces.push(cur.trim()); cur = ""; }
    cur += " " + sn;
  }
  if (cur.trim()) pieces.push(cur.trim());
  const out = [];
  for (let i = 0; i < pieces.length; i += 4) {
    const r = await studio("/api/automation/translate", { texts: pieces.slice(i, i + 4), langs: ["lg"] });
    const got = r?.translations?.lg;
    if (!Array.isArray(got) || got.length !== pieces.slice(i, i + 4).length) throw new Error("free translator returned nothing");
    out.push(...got);
  }
  return out.join(" ");
}
/** Honest titles (YouTube spam rule, Nov 2026): our stories are fiction, so remove claims like "true story" or "real footage". */
function cleanTitle(t) {
  const tidy = (x) => x.replace(/\s{2,}/g, " ").replace(/^[\s:\-–|,]+|[\s:\-–|,]+$/g, "").trim();
  const orig = String(t || "").trim();
  const soft = tidy(orig.replace(/\b(100%\s+)?(true|real)(\s+life)?\s+(?=story|stories|footage|events?|account|case|ghost|haunting|video)/gi, ""));
  const hard = tidy(soft.replace(/\b(caught on (camera|tape|video)|based on a true story|actually happened|really happened|real footage|real video|leaked footage)\b/gi, ""));
  return hard.split(" ").length >= 3 ? hard : soft.length >= 4 ? soft : orig;
}

/** A short, scary, catchy Luganda YouTube title (not a word-for-word translation). */
async function lugandaTitle(enTitle, topic) {
  const res = await sunbirdFetch("/tasks/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "sunflower-9b", temperature: 0.4, messages: [
      { role: "system", content: "You write YouTube titles in natural Luganda for scary village stories. Write ONE short, catchy, scary title (4 to 8 words). Reply with ONLY the Luganda title, no quotes, no English." },
      { role: "user", content: `Story ideas: ${topic}\nEnglish title: ${enTitle}` },
    ] }),
  });
  const t = String((await res.json())?.choices?.[0]?.message?.content ?? "").replace(/["\r\n]+/g, " ").trim();
  if (t.length < 6 || t.length > 90) throw new Error("bad title");
  return t;
}
let sunbirdTextOk = true;
/** English story text -> Luganda. Sunbird Sunflower first (best Luganda); the free Cloudflare translator if Sunbird is not available. */
async function toLuganda(text) {
  const clean = String(text || "").trim();
  if (!clean) return clean;
  if (sunbirdTextOk) {
    try { return await toLugandaSunbird(clean); }
    catch (e) { sunbirdTextOk = false; log("Sunbird translation not available, using the free translator:", String(e.message).slice(0, 160)); }
  }
  return toLugandaFree(clean);
}
async function toLugandaSunbird(clean) {
  const res = await sunbirdFetch("/tasks/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sunflower-9b",
      temperature: 0.15,
      messages: [
        { role: "system", content: "You are an expert Luganda storyteller from Buganda who also translates. Translate the user's English story text into correct, natural, spoken Luganda, the way a grandmother or village storyteller would tell a scary story out loud: short clear sentences, correct noun classes and verb forms, everyday Luganda words (not literal word-for-word English). Keep every name, every event and the scary mood. Do not add or remove story events. Keep the same number of paragraphs, separated by blank lines. Reply with ONLY the Luganda text, no notes, no English, no quotation marks." },
        { role: "user", content: clean },
      ],
    }),
  });
  const out = String((await res.json())?.choices?.[0]?.message?.content ?? "").trim();
  if (out.length < Math.min(20, clean.length / 3)) throw new Error("Sunbird returned an empty translation");
  return out;
}
let sunbirdVoice = null;
async function sunbirdPickVoice() {
  if (sunbirdVoice !== null) return sunbirdVoice;
  sunbirdVoice = process.env.SUNBIRD_VOICE || "";
  if (sunbirdVoice) return sunbirdVoice;
  try {
    const j = await (await sunbirdFetch("/tasks/voice/speakers", { method: "GET" }, 2)).json();
    const list = Array.isArray(j) ? j : j?.speakers ?? j?.voices ?? Object.values(j ?? {});
    log("Sunbird voices:", JSON.stringify(list).slice(0, 400));
  } catch (e) {
    log("Sunbird voice list not available:", String(e.message).slice(0, 120));
  }
  return sunbirdVoice; // empty = Sunbird's default Luganda speaker
}
function chunkText(text, max = 300) {
  const parts = [];
  let cur = "";
  for (const sentence of String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)) {
    if ((cur + " " + sentence).trim().length > max && cur) { parts.push(cur.trim()); cur = ""; }
    cur += " " + sentence;
    while (cur.trim().length > max * 1.5) { parts.push(cur.trim().slice(0, max)); cur = cur.trim().slice(max); }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
async function sunbirdSpeak(text, file) {
  const voice = await sunbirdPickVoice();
  const pieces = chunkText(text);
  const files = [];
  for (let i = 0; i < pieces.length; i++) {
    const res = await sunbirdFetch("/tasks/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: pieces[i], language: "lug", ...(voice ? { voice } : {}), response_mode: "stream" }),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1500) throw new Error("Sunbird voice returned empty audio");
    const f = `${file}.p${i}.audio`;
    await writeFile(f, bytes);
    files.push(f);
  }
  const list = file + ".list.txt";
  await writeFile(list, files.map((f) => `file '${f}'`).join("\n"));
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-ar", "44100", "-ac", "1", "-af", "loudnorm=I=-16:TP=-1.5:LRA=7,volume=1.5", "-f", "mp3", file]);
  const st = await stat(file);
  if (st.size < 2000) throw new Error("empty audio");
}


// Channel 4: Tony's own scary Uganda pictures (scripts/video-bot/ch4-photos/use), chosen to MATCH the scene (who is in it, where, what happens).
const MALE_RE = /\b(he|him|his|himself|man|men|boy|father|dad|husband|brother|uncle|grandfather|son|rider|driver|fisherman|mzee|sir)\b/gi;
const FEMALE_RE = /\b(she|her|hers|herself|woman|women|girl|mother|mum|mama|wife|sister|aunt|auntie|grandmother|daughter|madam)\b/gi;
function genderOf(text) {
  const m = (String(text).match(MALE_RE) || []).length, f = (String(text).match(FEMALE_RE) || []).length;
  return m > f ? "m" : f > m ? "f" : null;
}
const CH4_PHOTOS = {
  "lantern-woman-ghost": { who: "f", must: [/ghost|spirit|figure|shadow|something|haunt|behind|follow|chase|scream|terror/] },
  "woman-ghost-hut": { who: "f", must: [/ghost|spirit|figure|shadow|haunt|door|hut|house|scream/] },
  "boy-ghost-graveyard": { who: "m", must: [/boy|child|son|kid|young/, /grave|cemetery|ghost|spirit|dead|hand|crawl|tomb|bury/] },
  "village-mist-silhouette": { who: "any", must: [/village|mist|fog|field|path|silhouette|figure|huts|homestead|night|moon/] },
  "ghost-crawling": { who: "any", must: [/ghost|spirit|creature|monster|witch|crawl|claw|corpse|hair|demon|evil|grave|dead/] },
  "woman-fallen-ghost": { who: "f", must: [/ghost|spirit|creature|reach|grab|crawl|scream|fell|fall|dead/] },
  "forest-monster": { who: "any", must: [/forest|woods|jungle|trees|bush|swamp|creature|monster|beast|glow|bridge|river/] },
  "village-huts-ghosts": { who: "any", must: [/village|huts|homestead|compound|empty|silent|fog|mist|ghost|figures|houses/] },
  "haunted-forest-spirits": { who: "any", must: [/forest|woods|trees|spirits|lights|whisper|wander|mist|bush/] },
  "elder-lantern-road": { who: "any", must: [/old|elder|grandmother|grandfather|stranger|healer|witch|herbalist|mzee|traveler|traveller|road|path|lantern/] },
  "ghost-over-girl-house": { who: "f", must: [/girl|daughter|young woman/, /ghost|spirit|house|haunt|reach|hand|dead/] },
  "forest-red-eyes-man": { who: "m", must: [/forest|woods|jungle|trees|bush|eyes|watch|fear|terror|frozen/] },
  "lantern-girl-ghost-behind": { who: "f", must: [/girl|woman|lantern|young/, /ghost|spirit|behind|follow|figure|shadow/] },
  "giant-monster-huts": { who: "any", must: [/monster|giant|beast|creature|huge|towering|sky/] },
  "witch-hut-spirit": { who: "any", must: [/witch|healer|herbalist|medicine|hut|spirit|bones|candle|curse|bewitch|ritual/] },
  "old-man-lantern-faceless": { who: "m", must: [/old|elder|man|grandfather|mzee|stranger|traveler|traveller/, /lantern|road|path|faceless|figure|behind|night/] },
  "grave-ghost": { who: "any", must: [/grave|cemetery|tomb|bury|buried|dead|crawl|ghost/] },
  "boy-under-bed-eyes": { who: "m", must: [/boy|child|son|kid|young/, /bed|hide|hiding|dark|eyes|room|hut|night/] },
  "hanging-tree-spirit": { who: "any", must: [/tree|hang|hanged|forest|sacred|branch|misty|spirit/] },
  "woman-window-ghost": { who: "f", must: [/woman|mother|wife|girl|daughter/, /window|scream|hut|house|ghost|face|candle/] },
  "man-running-road": { who: "m", must: [/man|he|him|his|husband|father|boy|driver|boda/, /run|ran|chase|chased|escape|flee|fled|road|path|terror|fear/] },
  "well-ghost-white": { who: "f", must: [/well|water|ghost|dress|white|woman|girl/] },
  "well-ghost-fog": { who: "f", must: [/well|water|ghost|dress|white|woman|girl|fog|mist/] },
  "man-chased-bright": { who: "m", must: [/run|ran|chase|chased|escape|flee|fled|road|path|follow|behind|terror|fear|night/] },
  "fireside-story-ghost": { who: "any", must: [/story|tale|told|tell|grandfather|grandmother|elder|fire|children|kids|legend|village|night|ghost|spirit/] },
  "mother-daughter-ghost-hut": { who: "f", must: [/woman|mother|wife|daughter|girl/, /ghost|spirit|hut|house|lantern|haunt|night|reach|behind/] },
  "boy-graveyard-ghost-bright": { who: "m", must: [/boy|child|son|kid|young/, /grave|cemetery|ghost|spirit|dead|tomb|bury|cross/] },
  "woman-banana-path-spirit": { who: "f", must: [/woman|girl|wife|mother|lady/, /banana|path|garden|dusk|walk|spirit|shadow|follow|trees/] },
  "healer-hut-horned-spirit": { who: "any", must: [/witch|healer|herbalist|herb|medicine|curse|spirit|candle|ritual|hut|bewitch|charm/] },
  "boda-ghost-passenger": { who: "m", must: [/boda|motorcycle|motorbike|rider|driver|passenger|taxi|road|night/, /ghost|spirit|passenger|behind|seat|pale|ride|lift/] },
  "girl-well-reflection": { who: "f", must: [/girl|woman|daughter|student|school/, /well|water|river|pond|reflection|fetch|borehole|ghost/] },
  "man-torch-forest-eyes": { who: "m", must: [/forest|woods|jungle|bush|trees|hunter|torch|eyes|watch/] },
  "mother-cooking-ghost-child": { who: "f", must: [/mother|woman|wife|cook|kitchen|fire|hut|child|baby|doorway|ghost/] },
  "student-candle-window-ghost": { who: "f", must: [/girl|student|pupil|school|study|studying|homework|candle|window|room/] },
  "fisherman-lake-ghost": { who: "m", must: [/fisher|lake|canoe|boat|water|victoria|river|ghost|rising|mist/] },
  "farmer-scarecrow-ghost": { who: "m", must: [/farmer|garden|field|farm|banana|scarecrow|dusk|plantation|digging|hoe|ghost/] },
  "bride-lake-ghost": { who: "m", must: [/bride|wedding|lake|shore|water|jetty|ghost|white|dress|marry|married|love/] },
  "funeral-fire-ghost": { who: "any", must: [/funeral|mourn|burial|buried|death|died|dead|fire|gathering|village|ghost|spirit|elders|crowd/] },
  "child-sleeping-ghost-mother": { who: "any", must: [/child|boy|girl|son|daughter|mother|mum|sleep|bed|room|night|ghost|spirit|watch|lantern/] },
  "taxi-van-ghost-passenger": { who: "m", must: [/taxi|van|bus|driver|passenger|mirror|seat|journey|road|ghost|spirit|pale/] },
  "haunted-tree-ghostly-hands": { who: "f", must: [/tree|mango|branch|hands|girl|water|jerrycan|path|sunset|ghost|spirit|reach/] },
  "empty-market-ghost-vendor": { who: "m", must: [/market|vendor|stall|trader|tomato|dawn|morning|empty|shop|ghost|spirit|woman/] },
  "witch-doctor-ritual-fire": { who: "f", must: [/healer|witch|doctor|ritual|fire|smoke|hut|spirit|herb|charm|curse|ancestor/] },
  "couple-shadow-figure": { who: "any", must: [/husband|wife|couple|marriage|home|table|door|doorway|shadow|figure|stranger|eyes|evening|night/] },
  "women-washing-river-ghost": { who: "f", must: [/river|lake|wash|washing|clothes|women|water|mist|morning|reflection|ghost|spirit|white/] },
  "schoolboy-shadow-monster": { who: "m", must: [/school|boy|student|uniform|home|road|path|shadow|monster|beast|creature|follow/] },
  "maize-seller-spirit-child": { who: "f", must: [/maize|corn|roadside|seller|vendor|woman|grandmother|dusk|roast|road|child|ghost|spirit/] },
  "fisherwoman-lake-tall-spirit": { who: "f", must: [/fisher|lake|net|nets|shore|water|boat|victoria|woman|ghost|spirit|tall/] },
  "sisters-braiding-roof-shadow": { who: "f", must: [/sister|sisters|girl|braid|hair|veranda|roof|evening|shadow|spirit|home/] },
  "adungu-elder-dancing-spirits": { who: "m", must: [/elder|old man|grandfather|mzee|harp|adungu|music|song|sing|mango|tree|dance|dancing|spirits/] },
  "nurse-hospital-ghost-patient": { who: "f", must: [/nurse|hospital|clinic|ward|patient|corridor|doctor|health|ghost|spirit|sick/] },
  "goat-boy-cloud-face": { who: "m", must: [/boy|goat|goats|herd|hill|hills|sky|cloud|clouds|face|grazing|afternoon|spirit/] },
  "firewood-woman-faceless-eucalyptus": { who: "f", must: [/firewood|wood|eucalyptus|grove|trees|forest|woman|faceless|figure|stranger|bush/] },
  "matooke-stall-reaching-hand": { who: "f", must: [/market|stall|matooke|vendor|trader|money|dawn|sack|sacks|hand|reach|woman|ghost/] },
  "church-ghost-congregation": { who: "m", must: [/church|preacher|pastor|prayer|pray|bible|sermon|congregation|pews|service|sunday|ghost|spirit/] },
  "classroom-spirit-teacher": { who: "f", must: [/school|class|classroom|teacher|chalk|chalkboard|pupil|student|uniform|lesson|ghost|spirit/] },
  "bicycle-repair-glowing-child": { who: "m", must: [/bicycle|bike|repair|mechanic|shop|workshop|village|doorway|child|glowing|eyes|watch|ghost|spirit/] },
  "grandmother-story-wall-shadow": { who: "any", must: [/grandmother|grandma|story|tale|told|tell|children|kids|mat|lantern|shadow|wall|legend|night|spirit/] },
  "dishes-woman-basin-spirit": { who: "f", must: [/dish|dishes|wash|washing|basin|water|sunset|evening|hut|woman|mother|hair|ghost|spirit/] },
  "fisherman-lake-spirit-child": { who: "m", must: [/fish|fisherman|lake|net|nets|water|shore|boat|child|spirit|ghost/] },
  "herbalist-market-shadow-twin": { who: "f", must: [/herb|healer|root|market|shadow|horn|stall|sell|woman|witch/] },
  "boda-rider-rainy-road-child": { who: "m", must: [/boda|rider|motorcycle|motorbike|road|rain|passenger|lift|child|ride/] },
  "girl-mango-tree-hanging-legs": { who: "f", must: [/girl|school|mango|tree|legs|hanging|branch|fruit|ghost|spirit/] },
  "pastor-church-faceless-kneeling": { who: "m", must: [/pastor|church|pray|prayer|elder|kneel|faceless|ghost|spirit|old/] },
  "twins-banana-plantation": { who: "m", must: [/twin|twins|boy|boys|banana|plantation|identical|third|play|child|children/] },
  "man-radio-ghost-hand": { who: "m", must: [/radio|voice|hand|shoulder|hut|door|listen|ghost|spirit|man/] },
  "woman-water-pot-lake-reflection": { who: "f", must: [/water|jerrycan|spring|well|reflection|pond|river|woman|mother|hair|ghost|spirit/] },
  "wedding-guests-ghost-bride": { who: "any", must: [/wedding|bride|guest|gomesi|ceremony|marriage|celebration|ghost|spirit/] },
  "shopkeeper-dusk-spirit-doorway": { who: "m", must: [/shop|shopkeeper|dukka|store|dusk|door|doorway|close|night|spirit|ghost|eyes/] },
  "boys-football-ghost-goalkeeper": { who: "m", must: [/football|soccer|boys|goal|goalkeeper|field|game|play|ghost|spirit/] },
  "elder-drummers-spirit-circle": { who: "any", must: [/drum|drummer|drums|elder|dance|dancer|circle|gathering|festival|ghost|spirit|music/] },
  "mother-baby-sling-shadow-hands": { who: "f", must: [/mother|baby|sling|path|bush|bushes|hands|reach|woman|ghost|spirit|shadow/] },
  "80-tailor-woman-mirror-spirit-child": { who: "f", must: [/tailor|seamstress|sewing|machine|mirror|shop|woman|spirit|ghost|child/] },
  "81-maize-roaster-spirit-woman-bicycle": { who: "m", must: [/maize|corn|roadside|roast|seller|vendor|bicycle|old man|spirit|ghost/] },
  "82-schoolgirls-papyrus-swamp-spirit": { who: "f", must: [/schoolgirl|school|girls|uniform|swamp|papyrus|reeds|wetland|spirit|ghost/] },
  "83-fisherman-wife-net-lake-ghost": { who: "f", must: [/net|nets|fisher|lake|shore|wife|woman|mend|ghost|spirit/] },
  "84-borehole-queue-ghost-child": { who: "f", must: [/borehole|water|pump|well|jerrycan|queue|women|village|child|ghost|spirit/] },
  "85-cattle-herder-ghost-cow": { who: "m", must: [/cattle|cow|cows|herd|herder|ankole|hill|boy|pasture|ghost|spirit/] },
  "86-grandfather-mat-weaving-ghost-wife": { who: "m", must: [/grandfather|old man|elder|mzee|mat|weav|papyrus|doorstep|wife|ghost|spirit/] },
  "87-chapati-stall-ghost-customer": { who: "f", must: [/chapati|rolex|stall|street|vendor|customer|queue|food|woman|ghost|spirit/] },
  "88-salon-doorway-ghost-woman": { who: "f", must: [/salon|hair|hairdresser|plait|braid|customer|door|doorway|woman|ghost|spirit/] },
  "89-roof-repair-ghost-face": { who: "m", must: [/roof|iron sheet|repair|house|fix|climb|man|behind|face|ghost|spirit/] },
  "90-skipping-rope-ghost-girl": { who: "f", must: [/skip|rope|school|girls|children|playground|teacher|extra|ghost|spirit/] },
  "91-kite-boy-ghost-cloud-face": { who: "m", must: [/kite|boy|hill|sky|cloud|string|fly|teen|ghost|spirit/] },
  "92-fig-tree-ceremony-ancestors": { who: "any", must: [/fig|tree|ceremony|ritual|elder|priest|ancestor|shrine|spirit|ghost/] },
  "93-hill-path-termite-mound-spirit": { who: "f", must: [/hill|path|termite|mound|jerrycan|mother|woman|behind|long arms|spirit|ghost/] },
  "94-cassava-farm-ghost-digger": { who: "m", must: [/cassava|farm|hoe|dig|digging|garden|field|wife|baby|ghost|spirit/] },
  "95-barber-shop-mirror-ghost": { who: "m", must: [/barber|haircut|shave|salon|mirror|shop|customer|ghost|spirit/] },
  "96-tea-pickers-tall-spirit": { who: "f", must: [/tea|plantation|picker|pickers|leaves|hill|hills|bushes|women|tall|ghost|spirit/] },
  "97-charcoal-seller-smoke-face": { who: "m", must: [/charcoal|smoke|sack|sacks|roadside|seller|fire|face|ghost|spirit/] },
  "98-marbles-ghost-child": { who: "m", must: [/marble|marbles|boys|play|playing|compound|village|child|kids|ghost|spirit/] },
  "99-millet-pounding-ghost-hand": { who: "f", must: [/millet|pound|pounding|mortar|pestle|women|hut|hand|ghost|spirit/] },
  "100-coffee-farmer-drying-beans-ghost": { who: "m", must: [/coffee|beans|farmer|drying|banana|elder|old man|ghost|spirit/] },
  "101-ferry-passenger-ghost": { who: "f", must: [/ferry|boat|lake|victoria|passenger|passengers|crossing|water|ghost|spirit/] },
  "102-blacksmith-forge-shadow": { who: "m", must: [/blacksmith|forge|iron|hammer|anvil|smith|shadow|horn|horned|ghost|spirit/] },
  "103-old-couple-bench-third-figure": { who: "any", must: [/couple|husband|wife|old|elderly|bench|porch|third|figure|between|ghost|spirit/] },
  "104-sugarcane-girl-tall-spirit": { who: "f", must: [/sugarcane|sugar|cane|girl|field|path|tall|behind|ghost|spirit/] },
  "105-taxi-park-window-ghost-face": { who: "any", must: [/taxi|park|minibus|matatu|bus|kampala|window|face|empty|ghost|spirit/] },
  "106-dormitory-bunk-ghost": { who: "f", must: [/dormitory|dorm|boarding|bunk|bed|beds|school|girls|sleep|ghost|spirit/] },
  "107-lullaby-grandmother-crib-spirit": { who: "f", must: [/lullaby|grandmother|grandma|baby|cot|crib|hut|sing|song|ghost|spirit/] },
};
// Photos with blood/claws/gore: never used as thumbnails, and used inside videos only when no gentler photo fits (YouTube age-restriction risk).
const CH4_GORY = ["ghost-crawling", "woman-fallen-ghost", "ghost-over-girl-house", "boy-ghost-graveyard"];
const ch4Gory = (f) => CH4_GORY.some((g) => String(f).includes(g));
let ch4Pool = null;
const ch4Count = new Map();
// Little Hope Tales (channel 2): its own goblin pictures only (scripts/video-bot/thumbs/ch2). Never the Night Tales photos.
let ch2Pool = null;
async function ch2Library() {
  try {
    if (ch2Pool === null) {
      const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "thumbs", "ch2");
      ch2Pool = (await readdir(dir)).filter((f) => /\.jpe?g$/i.test(f)).map((f) => path.join(dir, f));
    }
    return ch2Pool.length ? ch2Pool[Math.floor(Math.random() * ch2Pool.length)] : null;
  } catch {
    return null;
  }
}

async function ch4Photo(text = "", gender = null, loose = false) {
  if (ch4Pool === null) {
    try {
      const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "ch4-photos", "use");
      ch4Pool = (await readdir(dir)).filter((f) => /\.jpe?g$/i.test(f)).map((f) => ({ file: path.join(dir, f), key: Object.keys(CH4_PHOTOS).find((k) => f.includes(k)) }));
    } catch { ch4Pool = []; }
  }
  const t = String(text).toLowerCase();
  const ok = ch4Pool.filter((x) => {
    const tag = x.key && CH4_PHOTOS[x.key];
    if (!tag) return false;
    if (tag.who !== "any" && gender && tag.who !== gender) return false; // never show a woman in a story about a man (or the other way round)
    return loose || tag.must.every((re) => re.test(t));
  });
  if (!ok.length) return null;
  const gentle = ok.filter((x) => !ch4Gory(x.file));
  const use = gentle.length ? gentle : ok;
  const least = Math.min(...use.map((x) => ch4Count.get(x.file) ?? 0));
  const pool = use.filter((x) => (ch4Count.get(x.file) ?? 0) === least);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  ch4Count.set(pick.file, least + 1);
  return pick.file;
}
let ch4Streak = 0;

async function speak(text, file) {
  if (CHANNEL === 4) {
    // Luganda only works with the Luganda voice. Never read Luganda text with an English voice.
    await sunbirdSpeak(text, file);
    return;
  }
  if (kokoroOn() && kokoroFails < 3) {
    try {
      await kokoroSpeak(text, file);
      if (!USED_KOKORO) log("Voice: Kokoro", kokoroVoice().voice);
      USED_KOKORO = true;
      kokoroFails = 0;
      return;
    } catch (e) {
      kokoroFails++;
      if (kokoroFails === 1 || kokoroFails === 3) log("Kokoro voice failed, using the next voice:", String(e.message).slice(-200));
    }
  }
  if (edgeFails < 3) {
    try {
      const txt = file + ".txt";
      await writeFile(txt, text);
      await run("python3", ["-m", "edge_tts", "--voice", EDGE_VOICE, SCARY ? "--rate=-12%" : WONDER ? "--rate=-6%" : "--rate=-4%", ...(SCARY ? ["--pitch=-6Hz"] : []), "--file", txt, "--write-media", file]);
      const st = await stat(file);
      if (st.size > 2000) {
        edgeFails = 0;
        return;
      }
      throw new Error("empty audio");
    } catch (e) {
      edgeFails++;
      if (edgeFails === 1 || edgeFails === 3) log("natural voice failed, using fallback:", String(e.message).slice(-320));
    }
  }
  // Second choice: Google Cloud text-to-speech (works from cloud servers). Only used if a key is set.
  const gKey = process.env.GOOGLE_TTS_API_KEY;
  if (gKey && googleFails < 3) {
    try {
      await googleSpeak(text, file, gKey);
      googleFails = 0;
      return;
    } catch (e) {
      googleFails++;
      if (googleFails === 1 || googleFails === 3) log("google voice failed, using studio voice:", String(e.message).slice(-200));
    }
  }
  await writeFile(file, await studio("/api/media/tts", { text, lang: "en" }, { raw: true }));
}
let googleFails = 0;
const GOOGLE_VOICE = SCARY ? { languageCode: "en-US", name: "en-US-Neural2-J" } : WONDER ? { languageCode: "en-GB", name: "en-GB-Neural2-B" } : { languageCode: "en-US", name: "en-US-Neural2-D" };
async function googleSpeak(text, file, key) {
  // The service accepts up to 5000 characters per call, so long text is cut at sentence ends.
  const parts = [];
  let cur = "";
  for (const sent of text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
    if ((cur + " " + sent).length > 4000 && cur) { parts.push(cur); cur = sent; } else cur = cur ? cur + " " + sent : sent;
  }
  if (cur) parts.push(cur);
  const bufs = [];
  for (const t of parts) {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { text: t.slice(0, 4900) }, voice: GOOGLE_VOICE, audioConfig: { audioEncoding: "MP3", speakingRate: WONDER ? 0.94 : SCARY ? 0.88 : 0.97 } }),
    });
    if (!r.ok) throw new Error(`google tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (!j.audioContent) throw new Error("google tts: no audio");
    bufs.push(Buffer.from(j.audioContent, "base64"));
  }
  const all = Buffer.concat(bufs);
  if (all.length < 2000) throw new Error("google tts: empty audio");
  await writeFile(file, all);
}
// Hand-made goblin picture library (scripts/video-bot/scenes/<theme>-<n>.jpg), matched to the story by keywords.
const SCENE_THEMES = {
  door: /door|knock|cellar|locked|open/i, hallway: /hall|corridor|footstep|walked|creak/i, bedroom: /bed|sleep|pillow|blanket|room|night/i,
  attic: /attic|mirror|reflection|dust/i, forest: /forest|tree|woods|path|fog/i, key: /\bkey|keys/i,
  goblin: /goblin|grin|laugh|giggle|smile|teeth|whisper|creature/i, kitchen: /kitchen|trapdoor|floor|table|basement/i,
  stairs: /stair|step|shadow|candle/i, child: /scream|afraid|scared|fear|cry|tremb|heart|panic|ran/i, graveyard: /grave|moon|bat|gate|cemetery|lantern|dark/i,
};
let SCENE_FILES = null;
const usedScenes = new Set();
async function pickLibraryScene(text, isEnd) {
  if (SCENE_FILES === null) {
    try {
      const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "scenes");
      SCENE_FILES = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => ({ f, dir, theme: f.split("-")[0] }));
    } catch {
      SCENE_FILES = [];
    }
  }
  if (!SCENE_FILES.length) return null;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  let pool = [];
  if (isEnd) pool = SCENE_FILES.filter((x) => x.theme === "sunrise");
  if (!pool.length) {
    const themes = Object.keys(SCENE_THEMES).filter((t) => SCENE_THEMES[t].test(text));
    pool = SCENE_FILES.filter((x) => themes.includes(x.theme));
  }
  if (!pool.length) pool = SCENE_FILES.filter((x) => x.theme !== "sunrise");
  const fresh = pool.filter((x) => !usedScenes.has(x.f));
  const chosen = pick(fresh.length ? fresh : pool);
  usedScenes.add(chosen.f);
  return path.join(chosen.dir, chosen.f);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function studio(pathname, body, { raw = false, meta = false } = {}) {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(STUDIO + pathname, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-channel": String(CHANNEL) },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (meta) return { bytes: Buffer.from(await res.arrayBuffer()), source: res.headers.get("x-clip-source") ?? "" };
        return raw ? Buffer.from(await res.arrayBuffer()) : await res.json();
      }
      const j = await res.json().catch(() => ({}));
      last = j.error ?? `HTTP ${res.status}`;
      if (res.status === 400 && /Daily|limit|not connected|not available|No stock clip|No free clip/i.test(last)) break;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await wait(2500 * (attempt + 1));
  }
  throw new Error(last || "The studio did not answer.");
}

const CHANNEL = process.env.CHANNEL === "4" ? 4 : process.env.CHANNEL === "3" ? 3 : process.env.CHANNEL === "2" ? 2 : 1;
// Links in Telegram ask Google to open the right account for each channel (channel 3: set the repo variable CH3_EMAIL to its Google address).
const AUTH =
  "authuser=" + encodeURIComponent(CHANNEL === 4 ? process.env.CH4_EMAIL || "tonymusigo@gmail.com" : CHANNEL === 3 ? process.env.CH3_EMAIL || "atwookininsiima@gmail.com" : CHANNEL === 2 ? "ninsiimamusigo@gmail.com" : "ninsiimatony@gmail.com");
// Random start so different videos pick different clips from the same search.
const CLIP_OFFSET = Math.floor(Math.random() * 20);

async function notify(text) {
  try {
    await studio("/api/automation/notify", { text: CHANNEL === 4 ? `[Night Tales Uganda - tonymusigo@gmail.com]\n${text}` : CHANNEL === 3 ? `[Ninsiima Atwooki (channel 3) - atwookininsiima@gmail.com]\n${text}` : CHANNEL === 2 ? `[Little Hope Tales - ninsiimamusigo@gmail.com]\n${text}` : `[Tony Ninsiima - ninsiimatony@gmail.com]\n${text}` });
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
  // Since 2026-11-16 the look rotates with the date, so two videos in a row never get the same kind of thumbnail (YouTube: repetitive = not paid).
  const dayNum = Math.floor(Date.now() / 86400000);
  const mode = SCARY || CHANNEL === 3 ? "scene" : CHANNEL === 2 ? (dayNum % 2 ? "person" : "scene") : (["tony", "scene", "person"])[dayNum % 3];
  const sceneLook = pickOne(["warm golden light", "cool blue night light", "soft sunrise glow", "moody dramatic shadows", "rainy window light", "candle light"]);
  let prompt;
  if (SCARY) {
    const place = pickOne(["a lonely wooden cabin in the woods at night", "an old two-storey house with one lit window at night", "an empty motel hallway at night",
      "a dark country road with one street lamp", "a tent by a campfire in a dark forest", "a gas station alone in the dark", "a long empty hospital corridor",
      "a farmhouse under a stormy sky", "a parked van in a dark field", "a snowy cabin with footprints leading to the door"]);
    prompt = `Realistic dark night photograph of ${place}, related to "${title}", eerie, quiet, deep shadows, slightly grainy amateur camera look, high contrast, no people, no text`;
  } else if (mode === "person") {
    const feel = pickOne(["shocked", "heartbroken, eyes full of tears", "worried", "hopeful and smiling softly", "angry and hurt", "surprised"]);
    if (CHANNEL === 2) {
      const who = pickOne(["a cute cartoon mother", "a cute cartoon father", "a cartoon little girl", "a cartoon little boy", "a kind cartoon grandmother", "a cartoon grandfather"]);
      prompt = `Pixar style 3D cartoon close-up of ${who} with a ${feel} expression, placed on the right side of the frame, ${sceneLook}, empty calm space on the left, ultra detailed, no text`;
    } else {
      const who = pickOne(["a middle-aged woman", "a young woman", "a worried father", "an elderly man", "a young man", "an elderly woman", "a mother holding her child"]);
      prompt = `Cinematic close-up photo of ${who} with a ${feel} expression, placed on the right side of the frame, ${sceneLook}, dark empty space on the left, shallow depth of field, ultra detailed, 8k, no text`;
    }
  } else if (CHANNEL === 3) {
    prompt = `Stunning cinematic nature documentary photograph for a video titled "${title}", dramatic natural light, rich colors, ultra detailed, 8k, no text, no logos`;
  } else if (CHANNEL === 2) {
    prompt = `Colorful 3D animated cartoon movie scene for a story titled "${title}", Pixar style, expressive characters, ${sceneLook}, ultra detailed, no text`;
  } else if (TONE === "emotional") {
    prompt = `Cinematic emotional background scene for a story titled "${title}", ${sceneLook}, shallow depth of field, ultra detailed, 8k, no people in foreground, no text`;
  } else {
    prompt = `Eye-catching cinematic background for a YouTube video titled "${title}", vivid colors, dramatic lighting, ultra detailed, 8k, no text`;
  }
  // Hand-picked, attractive pictures (scripts/video-bot/thumbs/ch1 or ch2) are used most of the time; the free AI picture is the backup.
  let img = null;
  let libUsed = false;
  try {
    const dir = CHANNEL === 4 ? path.join(path.dirname(new URL(import.meta.url).pathname), "ch4-photos", "use") : path.join(path.dirname(new URL(import.meta.url).pathname), "thumbs", CHANNEL === 3 ? "ch3" : CHANNEL === 2 ? "ch2" : "ch1");
    const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f) && !(CHANNEL === 4 && ch4Gory(f)));
    if (files.length && mode !== "tony" && (CHANNEL === 4 || !SCARY) && Math.random() < (CHANNEL === 4 ? 1 : 0.85)) {
      files.sort(); img = await readFile(path.join(dir, CHANNEL === 4 ? pickOne(files) : files[(dayNum + CHANNEL * 3) % files.length])); // channels 1-3: next picture each day, no repeat inside the last ~9 days
      libUsed = true;
    }
  } catch {
    img = null;
  }
  if (!img) img = await studio("/api/media/image", { prompt: prompt.slice(0, 900) }, { raw: true });
  const src = path.join(WORK, "thumb-src.jpg");
  await writeFile(src, img);
  const ALL_FACES = ["crying", "pointing", "sad", "shocked", "thinking", "thumbsup"];
  let face = mode === "tony" && !libUsed ? pickFace(title, TOPIC) : "none";
  if (face !== "none" && face === ALL_FACES[(dayNum + 5) % 6]) face = ALL_FACES[dayNum % 6]; // never the same face as the last video
  const here = path.dirname(new URL(import.meta.url).pathname);
  const out = path.join(WORK, "thumb.jpg");
  log("Thumbnail mode:", mode, "face:", face);
  await run("python3", [
    path.join(here, "thumb.py"), src, face === "none" ? "none" : path.join(here, "faces", `${face}.png`),
    face === "pointing" ? "left" : "right", title, out, mode === "person" || (libUsed && CHANNEL !== 4) ? "half" : "full",
  ], CHANNEL === 4 ? { env: { ...process.env, THUMB_BRIGHT: "1" } } : {});
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
    body: JSON.stringify({ id: videoId, status: { privacyStatus: "public", selfDeclaredMadeForKids: st.selfDeclaredMadeForKids ?? false, embeddable: st.embeddable ?? true, license: st.license ?? "youtube", publicStatsViewable: st.publicStatsViewable ?? true, containsSyntheticMedia: USED_AI_PICTURES ? true : (st.containsSyntheticMedia ?? false) } }),
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
        snippet: { title: cleanTitle(title).slice(0, 100), description: description.slice(0, 4900), tags: globalThis.__videoTags ?? [], categoryId: SCARY ? "24" : TONE === "emotional" ? "22" : "28" },
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
  // Channel 4: ask for a Ugandan-village setting and short, plain sentences, so the Luganda translation comes out clean and natural.
  // Channel 4: every story gets its own random hero name, place and twist so stories never repeat names or plots (Tony, 2026-11-14).
  const CH4_MEN = ["Kato","Ssebo","Walusimbi","Kizito","Mugisha","Lubega","Ssemakula","Byaruhanga","Okello","Kasozi","Mutebi","Ssekitoleko","Wasswa","Lwanga","Kiggundu","Tumusiime","Ochieng","Ssentamu","Baguma","Nsubuga","Katumba","Mawanda","Kakooza","Sserwadda","Bbosa","Kyeyune","Muwonge","Ssali","Zziwa","Kaweesi"];
  const CH4_WOMEN = ["Nalongo Babirye","Nabirye","Nansubuga","Nakiyingi","Namatovu","Nankya","Nambi","Namutebi","Nalubega","Nassuna","Nakacwa","Namusoke","Tendo","Nakimuli","Akello","Atuhaire","Nabukalu","Nakawesi","Kemigisha","Nanteza","Nakirya","Nalwoga","Namugga","Nabbosa","Nakyanzi","Akoth","Birungi","Nakitende","Namuddu","Nantongo"];
  const CH4_PLACES = ["Masaka","Mbarara","Gulu","Fort Portal","Entebbe","Kabale","Mbale","Soroti","Hoima","Lira","Kasese","Busia","Masindi","Kyotera","Mpigi","Luweero","Kamuli","Bushenyi","Arua","Tororo","Mityana","Mubende","Jinja","Kibale"];
  const CH4_TWISTS = ["the ghost is not the real danger","the hero finds out he or she is the one who died","a promise to a dead relative is broken","a stranger who knows the hero's name","a sound that repeats every night","a market, school or church at night","a river, lake or swamp","a gift or object that must not be accepted","a taxi, truck or bus journey","a wedding, funeral or birthday","an animal that behaves like a person","a hospital or clinic at night","a borrowed phone or radio","a path through the sugarcane or coffee farm"];
  const rpick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const heroIsMan = Math.random() < 0.5;
  const CH4_SEED = CHANNEL === 4 ? ` Hero: ${heroIsMan ? "a man" : "a woman"} named ${heroIsMan ? rpick(CH4_MEN) : rpick(CH4_WOMEN)}. Place: near ${rpick(CH4_PLACES)}. Twist: ${rpick(CH4_TWISTS)}. Use this name, place and twist; new names only.` : "";
  const STORY_TOPIC = CHANNEL === 4
    ? `${TOPIC.slice(0, 100)} |${CH4_SEED} Original Ugandan horror from folklore (mizimu ghosts, misambwa spirits, night dancers). ONE named hero, same gender all through. Short plain sentences, no idioms.`.slice(0, 500)
    : TOPIC;
  const outline = await studio("/api/media/auto-script", { step: "outline", topic: STORY_TOPIC, minutes: MINUTES, tone: TONE });
  // Keep the outline inside the studio's size limits so the next step never rejects it.
  outline.title = cleanTitle(String(outline.title || TOPIC)).slice(0, 200);
  outline.sections = (outline.sections || []).map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 50);
  if (!outline.sections.length) outline.sections = [outline.title];
  log("Outline:", outline.title, `(${outline.sections.length} parts)`);
  const scenes = [];
  for (let i = 0; i < outline.sections.length; i++) {
    const sec = await studio("/api/media/auto-script", {
      step: "section",
      topic: STORY_TOPIC,
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
        en: narration,
        section: i,
        term: terms[k] || sec.visuals[k % Math.max(1, sec.visuals.length)] || outline.sections[i],
      }),
    );
    log(`Script part ${i + 1}/${outline.sections.length} done`);
  }
  if (CHANNEL === 4) {
    // Stories are written in English by the free AI, then told in Luganda by Sunbird (Sunflower). Pictures keep their English search words.
    log("Translating the story into Luganda...");
    outline.title = (await lugandaTitle(outline.title, TOPIC).catch(() => toLuganda(outline.title)).catch((e) => { log("title kept in English:", String(e.message).slice(0, 100)); return outline.title; })).replace(/[\r\n]+/g, " ").slice(0, 100);
    for (let k = 0; k < scenes.length; k += 2) {
      const group = scenes.slice(k, k + 2);
      const joined = group.map((x) => x.narration).join("\n\n");
      let lug = "";
      try { lug = await toLuganda(joined); } catch (e) { throw new Error(`Luganda translation failed: ${e.message}`); }
      const pieces = lug.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
      if (pieces.length === group.length) group.forEach((x, n) => (x.narration = pieces[n]));
      else { group[0].narration = lug; for (let n = 1; n < group.length; n++) group[n].narration = ""; }
      if ((k / 2) % 12 === 0) log(`Luganda ${Math.min(k + 3, scenes.length)}/${scenes.length}`);
    }
    for (let k = scenes.length - 1; k >= 0; k--) if (!scenes[k].narration) scenes.splice(k, 1);
  }

  // 1.5 Optional upgrade: moving clips from LTX-Video on free Kaggle GPU, instead of the usual
  // still pictures (channel 2) / Pixabay stock clips (channel 1). OFF unless USE_LTX_VIDEO=1 and
  // Kaggle credentials are set; on any failure this just returns null and nothing else changes.
  let kaggleClips = null;
  // Moving clips are opt-in per channel: set repo variable LTX_CHANNELS to e.g. "2" or "1,2". Empty = old style everywhere.
  if (ltx.KAGGLE_ENABLED && (process.env.LTX_CHANNELS || "4").split(",").map((x) => x.trim()).includes(String(CHANNEL))) {
    try {
      kaggleClips = await ltx.generateClipsOnKaggle({
        studio, scenes, channel: CHANNEL, workDir: WORK,
        characterStyle: "",
      });
    } catch (e) {
      log("Kaggle LTX-Video skipped, using normal pictures/clips:", String(e.message).slice(0, 160));
      kaggleClips = null;
    }
  }

  // Who is in each scene (sticky: a scene without "he/she" keeps the person from the scene before), so pictures never show the wrong gender.
  { let last = null; for (const sc of scenes) { const g = genderOf(sc.en ?? sc.narration); if (g) last = g; sc.g = g ?? last; } }

  // 2. One scene at a time: voice, clip, encode.
  const segs = [];
  let curImg = null, curClip = null, curWide = false, imgN = 0, imgT = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const id = String(i).padStart(4, "0");
    const voice = path.join(WORK, `v${id}.bin`);
    await speak(sc.narration, voice);
    const dur = (await duration(voice)) + 0.5;
    if (CHAPTER_AT[sc.section] === undefined) CHAPTER_AT[sc.section] = CHAPTER_T;
    SRT_PARTS.push({ start: CHAPTER_T, dur, narration: sc.narration });
    CHAPTER_T += dur;
    await writeFile(path.join(WORK, "seg.srt"), srtFor(sc.narration, dur));
    if (SCARY) {
      // A new picture every 6 scenes (was 4) to save the free daily AI allowance; each picture slowly zooms.
      if (i % (CHANNEL === 4 ? 3 : 6) === 0) {
        const chunk = scenes.slice(i, i + (CHANNEL === 4 ? 3 : 6)).map((x) => x.en ?? x.narration).join(" ").replace(/\s+/g, " ").slice(0, CHANNEL === 4 ? 180 : 230);
        try {
          if (kaggleClips && kaggleClips[i]) {
            curClip = kaggleClips[i];
            curImg = null;
          } else {
            // Every picture is new: made for this exact part of the story, with a different camera angle and light each time.
            // The saved library pictures are only a backup if the picture maker fails.
            // Channel 4: Tony's own scary Uganda photos (ch4-photos/use) every other picture, and whenever the picture maker fails.
            let lib = null;
            // Channel 2 (Little Hope Tales): about 1 picture in 3 is one of the same scary photos, only when one matches the story and never the bloody ones (Tony, 2026-11-14: more variety, safer for YouTube).
            if (CHANNEL === 2 && imgN % 3 === 2) {
              lib = await ch2Library(); // Little Hope Tales own goblin pictures only (never the Night Tales photos)
            }
            if (CHANNEL === 4 && (ch4Streak < 2 || AI_ALLOWANCE_GONE)) lib = await ch4Photo(scenes.slice(i, i + 3).map((x) => x.en ?? x.narration).join(" "), sc.g);
            if (lib) {
              curImg = lib;
              curWide = true;
              ch4Streak++;
              USED_AI_PICTURES = true;
            } else
            try {
              if (AI_ALLOWANCE_GONE) throw new Error("free AI allowance used up today");
              const img = await studio("/api/media/image", { prompt: nightPrompt(chunk, imgN, sc.g).slice(0, CHANNEL === 4 ? 590 : 1900) }, { raw: true });
              USED_AI_PICTURES = true;
              curImg = path.join(WORK, `img${i}.` + (img[0] === 0x89 ? "png" : "jpg"));
              await writeFile(curImg, img);
              curWide = false;
              ch4Streak = 0;
            } catch (e) {
              if (/allowance|used up/i.test(String(e.message))) AI_ALLOWANCE_GONE = true;
              // The old goblin picture library no longer matches this channel's look: keep the last picture instead.
              if (CHANNEL === 4) {
                const ph = await ch4Photo(scenes.slice(i, i + 3).map((x) => x.en ?? x.narration).join(" "), sc.g);
                if (ph) { curImg = ph; curWide = true; USED_AI_PICTURES = true; }
                else if (!curImg) throw e;
              } else {
                // Channel 2: when the free picture maker is out, use a gentle library photo instead of a black screen (11-16: 66 s of black held a video private).
                let ph2 = null;
                if (CHANNEL === 2) ph2 = await ch2Library(); // own goblin pictures only (never the Night Tales photos)
                if (ph2) { curImg = ph2; curWide = true; USED_AI_PICTURES = true; }
                else {
                  if (!curImg) throw e;
                  throw new Error("picture maker failed: " + String(e.message).slice(0, 60));
                }
              }
            }
            curClip = null;
          }
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
      const vfs = curClip
        ? `scale=2240:1260:force_original_aspect_ratio=increase,crop=2240:1260,fps=30,vignette=PI/4,${CHANNEL === 4 ? "eq=brightness=0.08:gamma=1.22:saturation=1.1," : ""}format=yuv420p,${sub}`
        : curImg
        ? `${curWide ? "scale=2240:1260" : "scale=2240:2240,crop=2240:1260"},zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,vignette=PI/4,${CHANNEL === 4 ? "eq=brightness=0.08:gamma=1.22:saturation=1.1," : ""}format=yuv420p,${sub}`
        : `fps=30,format=yuv420p,${sub}`;
      const segS = path.join(WORK, `seg${id}.mp4`);
      await ffmpeg(
        [
          ...(curClip
            ? ["-stream_loop", "-1", "-i", curClip]
            : curImg
            ? ["-loop", "1", "-framerate", "30", "-i", curImg]
            : ["-f", "lavfi", "-i", `color=c=0x05080f:s=${W}x${H}:r=30`]),
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
    let pic = null; // channel 3: an AI picture used instead of a clip for this scene
    let animated = false;
    let clipIsShared = false; // Kaggle clips are reused across a group of scenes; don't delete after one use
    if (kaggleClips) {
      const groupStart = i - (i % ltx.GROUP_SIZE);
      if (kaggleClips[groupStart]) {
        clip = kaggleClips[groupStart];
        animated = true;
        clipIsShared = true;
      }
    }
    try {
      if (clip) { /* already set from Kaggle above */ }
      else {
      await wait(500);
      clip = path.join(WORK, `c${id}.mp4`);
      let bytes = null;
      // Channel 3 is a hybrid: about one scene in nine is a new AI picture (slow zoom) between the real footage clips.
      if (WONDER && i % 9 === 4) {
        try {
          const img = await studio(
            "/api/media/image",
            { prompt: `Photorealistic documentary photograph: ${sc.term}. Cinematic natural light, rich detail, shot on a professional camera, no text, no logos`.slice(0, 900) },
            { raw: true },
          );
          pic = path.join(WORK, `p${id}.` + (img[0] === 0x89 ? "png" : "jpg"));
          await writeFile(pic, img);
          USED_AI_PICTURES = true;
        } catch (e) {
          log(`Scene ${i + 1}: AI picture failed (${String(e.message).slice(0, 60)}); using footage`);
          pic = null;
        }
      }
      if (pic) { /* picture ready; no clip needed for this scene */ }
      else if (WONDER) {
        try {
          const got = await studio("/api/media/doc-clip", { text: sc.narration.slice(0, 400), query: sc.term, index: i + CLIP_OFFSET }, { meta: true });
          bytes = got.bytes;
          if (got.source) USED_SOURCES.add(got.source);
        } catch (e) {
          // Backup: the plain Pixabay search, so a scene is never left empty.
          log(`Scene ${i + 1}: multi-source search found nothing (${String(e.message).slice(0, 60)}); trying Pixabay`);
          bytes = await studio("/api/media/stock-clip", { text: sc.narration.slice(0, 400), query: sc.term, index: i + CLIP_OFFSET, style: "real" }, { raw: true });
          USED_SOURCES.add("pixabay");
        }
      }
      else if (CHANNEL === 2) {
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
      if (!bytes && !pic && !WONDER) {
        bytes = await studio(
          "/api/media/stock-clip",
          { text: sc.narration.slice(0, 400), query: sc.term, index: i + CLIP_OFFSET, style: CHANNEL === 2 ? "real" : STYLE },
          { raw: true },
        );
      }
      if (bytes) await writeFile(clip, bytes);
      else clip = null;
      }
    } catch (e) {
      log(`Scene ${i + 1}: no clip (${e.message}); using a plain background`);
      clip = null;
    }
    const seg = path.join(WORK, `seg${id}.mp4`);
    const picZoom = i % 2 === 0 ? `min(1.0+0.00025*on,1.35)` : `max(1.35-0.00025*on,1.0)`;
    const vf = pic
      ? `scale=2240:2240,crop=2240:1260,zoompan=z='${picZoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,format=yuv420p,subtitles=seg.srt:force_style='FontName=DejaVu Sans,FontSize=20,Bold=1,Outline=2,Shadow=0,MarginV=36'`
      :
      (clip ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` : "") +
      // Channel 2: turn normal clips into a painted cartoon look (many more clips to choose from, so no repeats).
      (clip && CHANNEL === 2 && !animated
        ? `split[o][e];[e]edgedetect=mode=canny:low=0.10:high=0.30,negate[ed];[o]hqdn3d=8:6:10:8,eq=saturation=1.45:contrast=1.06:brightness=0.02,lutyuv=y='floor(val/16)*16+8'[c];[c][ed]blend=all_mode=multiply:all_opacity=0.75,`
        : "") +
      `fps=30,format=yuv420p,subtitles=seg.srt:force_style='FontName=DejaVu Sans,FontSize=20,Bold=1,Outline=2,Shadow=0,MarginV=36'`;
    const input = pic
      ? ["-loop", "1", "-framerate", "30", "-i", pic]
      : clip
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
    if (clip && !clipIsShared) await rm(clip, { force: true });
    if (pic) await rm(pic, { force: true });
    if ((i + 1) % 20 === 0 || i === scenes.length - 1) log(`Scene ${i + 1}/${scenes.length} done`);
  }

  kokoroStop(); // all voices are made; free the CPU for the video encoding
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
  // Real music tracks (scripts/video-bot/music/ch1 or ch2) when available; otherwise the simple drone.
  let musicIn = ["-f", "lavfi", "-i", music];
  let musicVol = 0.5;
  try {
    const mdir = path.join(path.dirname(new URL(import.meta.url).pathname), "music", CHANNEL === 2 || CHANNEL === 4 ? "ch2" : "ch1");
    const tracks = (await readdir(mdir)).filter((f) => /\.(mp3|m4a|wav)$/i.test(f));
    if (tracks.length) {
      musicIn = ["-stream_loop", "-1", "-ss", String(Math.floor(Math.random() * 90)), "-i", path.join(mdir, tracks[Math.floor(Math.random() * tracks.length)])]; // different track and a different start point each video
      musicVol = CHANNEL === 4 ? 0.07 : 0.22; // Luganda voice must stay clearly above the music
      log("Music: real track");
    }
  } catch {
    /* use the drone */
  }
  let mixed = false;
  if (CHANNEL === 4) {
    // Professional sound for Channel 4: all scary tracks joined with crossfades, night wind and crickets underneath,
    // and the music ducks (gets quieter) whenever the storyteller speaks, so the voice is always clear.
    try {
      const mdir = path.join(path.dirname(new URL(import.meta.url).pathname), "music", "ch2");
      const tracks = (await readdir(mdir)).filter((f) => /\.(mp3|m4a|wav)$/i.test(f)).sort(() => Math.random() - 0.5);
      const bed = path.join(WORK, "bed.mp3");
      if (tracks.length > 1) {
        let chain = "[0:a]", fc = "";
        for (let k = 1; k < tracks.length; k++) { fc += `${chain}[${k}:a]acrossfade=d=4:c1=tri:c2=tri[x${k}];`; chain = `[x${k}]`; }
        await ffmpeg([...tracks.flatMap((f) => ["-i", path.join(mdir, f)]), "-filter_complex", fc.replace(/;$/, "").replace(new RegExp(`\\[x${tracks.length - 1}\\]$`), `[x${tracks.length - 1}]`), "-map", `[x${tracks.length - 1}]`, bed]);
      } else if (tracks.length === 1) await ffmpeg(["-i", path.join(mdir, tracks[0]), bed]);
      else throw new Error("no music files");
      const D = Math.ceil(total);
      const st = "aformat=sample_rates=48000:channel_layouts=stereo";
      await ffmpeg([
        "-i", body, "-stream_loop", "-1", "-i", bed,
        "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.5:sample_rate=48000:d=${D}`,
        "-f", "lavfi", "-i", `anoisesrc=color=white:amplitude=0.4:sample_rate=48000:d=${D}`,
        "-filter_complex",
        `[0:a]${st},asplit=2[v1][v2];` +
        `[1:a]${st},volume=0.20,afade=t=in:d=3,afade=t=out:st=${Math.max(0, total - 5).toFixed(1)}:d=5[mus];` +
        `[2:a]lowpass=f=420,tremolo=f=0.13:d=0.6,volume=0.55,${st}[wind];` +
        `[3:a]highpass=f=4200,lowpass=f=7200,tremolo=f=11:d=0.9,volume=0.10,${st}[cric];` +
        `[mus][wind][cric]amix=inputs=3:duration=first:normalize=0[bg];` +
        `[bg][v2]sidechaincompress=threshold=0.02:ratio=9:attack=20:release=600:makeup=1[bgd];` +
        `[v1][bgd]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1:LRA=11,alimiter=limit=0.89:level=disabled[a]`,
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", final,
      ]);
      mixed = true;
      log("Music: scary tracks + night ambience, ducked under the voice");
    } catch (e) {
      log("Pro sound mix failed, using the simple mix:", String(e.message).slice(0, 200));
    }
  }
  if (!mixed) await ffmpeg([
    "-i", body, ...musicIn,
    "-filter_complex",
    `[1:a]volume=${musicVol},afade=t=in:d=3,afade=t=out:st=${Math.max(0, total - 4).toFixed(1)}:d=4[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1:LRA=11,alimiter=limit=0.89:level=disabled[a]`,
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", final,
  ]);

  const topicTags = TOPIC.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !["about", "their", "with", "from", "that", "this", "until", "every", "after"].includes(w))
    .slice(0, 3).map((w) => `#${w}`);
  const baseTags = CHANNEL === 4
    ? ["#Luganda", "#Uganda", "#EbyafaayoByaLuganda", "#sitoori", "#horror", "#NightTalesUganda"]
    : SCARY
    ? ["#scarystories", "#horrorstories", "#creepystories", "#scarystorytime", "#horrorstory", "#scary"]
    : CHANNEL === 2
    ? ["#animation", "#cartoonstory", "#animatedstory", "#familystory", "#faith", "#hope"]
    : WONDER
    ? ["#nature", "#wildlife", "#space", "#documentary", "#science", "#wonders"]
    : TONE === "emotional"
    ? ["#emotionalstory", "#sadstory", "#lifelessons", "#storytime", "#touchingstory"]
    : ["#explained", "#documentary", "#facts"];
  const hashtags = [...new Set([...baseTags, ...topicTags])].slice(0, 8);
  // YouTube chapters: must start at 0:00, at least 3, each 10+ seconds apart.
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const chapters = [];
  for (let k = 0; k < outline.sections.length; k++) {
    const t = k === 0 ? 0 : CHAPTER_AT[k];
    if (t === undefined) continue;
    if (chapters.length && t - chapters[chapters.length - 1].t < 12) continue;
    chapters.push({ t, name: outline.sections[k].replace(/[\r\n]+/g, " ").slice(0, 80) });
  }
  const chapterText = chapters.length >= 3
    ? chapters.map((c) => `${mmss(c.t)} ${c.name}`).join("\n")
    : outline.sections.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const description = CHANNEL === 4
    ? `${outline.title}\n\nEbigambo bino bya kuyiiya (original fiction) - tebyali bituufu. Ssaamu like, subscribe era otubuulire mu comments ekitontome ekyakutiisa ennyo.\n\n${chapterText}\n\nMade with AI narration (Sunbird AI Luganda voice) and AI-generated pictures. Original fiction, not true stories.\n\n${hashtags.join(" ")}`
    :
    `${outline.title}\n` +
    (SCARY || TONE === "emotional" ? `Original fiction.\n\n` : `\n`) +
    (SCARY
      ? `Three original scary stories on one theme. Which one scared you most? Tell us in the comments, and subscribe for new scary stories every week.\n\n`
      : WONDER
      ? `If you love nature, wildlife and the wonders of space, please like, share and subscribe for new documentaries every week. Which fact surprised you most? Tell us in the comments.\n\n`
      : TONE === "emotional"
      ? `If this story touched your heart, please like, share and subscribe for new emotional stories every week.\n\n`
      : `Like and subscribe for more.\n\n`) +
    `${chapterText}\n\n` +
    (SCARY ? `All stories are original fiction written for entertainment. They are not true stories.\n` : TONE === "emotional" ? `This is a fictional story, written for reflection and inspiration.\n` : "") +
    (SCARY
      ? `Made with AI narration and AI-generated pictures.\n\n`
      : WONDER
      ? `Made with AI narration${USED_AI_PICTURES ? " and a few AI-generated pictures" : ""}. ` +
        (USED_SOURCES.size ? `Footage: ${[...USED_SOURCES].filter((x) => x in SOURCE_NAMES).map((x) => SOURCE_NAMES[x]).join("; ")}.` : "Footage from free licensed sources.") +
        (USED_SOURCES.has("nasa") ? ` This channel is not affiliated with or endorsed by NASA.` : "") +
        ` Script written with AI help; facts are checked against public sources, but mistakes can happen. Tell us in the comments if you spot one.` +
        `\n\n`
      : `Made with AI narration and stock video clips from Pixabay (https://pixabay.com).\n\n`) +
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
    // Black or frozen-empty screens: more than 30 seconds of pure black in total.
    try {
      const bl = await new Promise((resolve) => {
        const p = spawn("ffmpeg", ["-hide_banner", "-i", final, "-vf", "blackdetect=d=1:pix_th=0.04", "-an", "-f", "null", "-"]);
        let o = "";
        p.stderr.on("data", (d) => (o += d));
        p.on("close", () => resolve(o));
        p.on("error", () => resolve(""));
      });
      let black = 0;
      for (const m of String(bl).matchAll(/black_duration:([\d.]+)/g)) black += Number(m[1]);
      if (black > 30) problems.push(`${Math.round(black)} seconds of black screen`); // was 8: short black gaps are ok, do not hold the video back
    } catch { /* optional check */ }
    // Clipping / distortion: the loudest peak must stay below 0 dB.
    try {
      const vd = await new Promise((resolve) => {
        const p = spawn("ffmpeg", ["-hide_banner", "-i", final, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
        let o = "";
        p.stderr.on("data", (d) => (o += d));
        p.on("close", () => resolve(o));
        p.on("error", () => resolve(""));
      });
      const mx = String(vd).match(/max_volume:\s*(-?[\d.]+) dB/);
      if (mx && Number(mx[1]) >= -0.05) log("Note: audio peak is very close to the limit (not held back)");
      const mean = String(vd).match(/mean_volume:\s*(-?[\d.]+) dB/);
      if (mean && Number(mean[1]) < -38) log("Note: audio is a bit quiet (not held back)");
    } catch { /* optional check */ }
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
  // Channel 4 (Luganda) posts automatically (Tony's decision, 2026-11-14) when the quality check is green; a failed check keeps it private.
  const CH4_HOLD = CHANNEL === 4 && process.env.CH4_AUTO_PUBLISH === "0"; // Tony approved auto-post on 2026-11-14; set CH4_AUTO_PUBLISH=0 to hold again
  const AUTO = process.env.AUTO_PUBLISH !== "0" && green && !CH4_HOLD;
  if (CH4_HOLD) pubNote = "HELD";
  else if (process.env.AUTO_PUBLISH !== "0" && !green) pubNote = "HELD";
  if (pubNote === "HELD" && !CH4_HOLD) {
    // Tell the workflow to make a fresh replacement video once (so one held video never leaves a gap).
    try { await writeFile(path.join(process.env.GITHUB_WORKSPACE || os.tmpdir(), "held.flag"), "1"); } catch { /* optional */ }
  }
  let thumbNote = "";
  try {
    log("Making thumbnail...");
    THUMB_FILE = await makeThumbnail(outline.title);
    await setThumbnail(id, THUMB_FILE);
    log("Thumbnail set");
  } catch (e) {
    log("thumbnail skipped:", e.message);
    thumbNote = "\n(Thumbnail could not be set this time.)";
  }
  // Publish only now, after the thumbnail step, so viewers never see a video without its picture.
  if (AUTO) {
    try { await publishVideo(id); log("Published (public)"); pubNote = "PUBLIC"; }
    catch (e) { log("auto-publish failed:", e.message); pubNote = "FAILED"; }
  }
  // Backup "recipe": everything needed to rebuild this video, kept 90 days as a GitHub artifact (see workflow).
  try {
    const dir = path.join(process.env.GITHUB_WORKSPACE || os.tmpdir(), "recipes");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `recipe-ch${CHANNEL}-${id}.json`), JSON.stringify({
      videoId: id, channel: CHANNEL, topic: TOPIC, title: outline.title, minutes: MINUTES, tone: TONE, style: STYLE,
      voice: USED_KOKORO ? `kokoro:${kokoroVoice().voice}` : `edge:${EDGE_VOICE}`, sources: [...USED_SOURCES], aiPictures: USED_AI_PICTURES,
      description, tags: globalThis.__videoTags ?? [], scenes: scenes.map((x) => ({ section: x.section, narration: x.narration, term: x.term })),
      made: new Date().toISOString(),
    }, null, 1));
    log("Recipe backup saved");
  } catch (e) {
    log("recipe backup skipped:", String(e.message).slice(0, 120));
  }
  // Stage-2 extras (never block the video): translated titles, series playlist, full subtitles.
  const extras = makeExtras({ token: async () => (await studio("/api/automation/youtube-token", { channel: CHANNEL })).accessToken, studio, log });
  const hook = (scenes[0]?.narration || outline.title).split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  if (WONDER) await extras.localize(id, outline.title, hook); // only Channel 3, to save the free daily AI allowance
  await extras.addToPlaylist(
    id,
    CHANNEL === 4 ? "Night Tales Uganda - Ebitontome" : CHANNEL === 3 ? "Wild Wonders - Full Documentaries" : CHANNEL === 2 ? "Little Hope Tales - Scary Stories" : "Tony Ninsiima - Full Stories",
    CHANNEL === 4 ? "Every full scary story in Luganda, newest first." : CHANNEL === 3 ? "Every full documentary about nature, space and the old world." : CHANNEL === 2 ? "Every full scary story, newest first." : "Every full emotional story.",
  );
  if (SRT_PARTS.length) await extras.uploadCaptions(id, fullSrt(SRT_PARTS));
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
    // One text file and one drawtext per line: a newline inside a single text file draws as a box character.
    const lines = tl.slice(0, 3).map((x) => x.replace(/[^\x20-\x7E]/g, ""));
    for (let li = 0; li < lines.length; li++) await writeFile(path.join(WORK, `short-title${li}.txt`), lines[li]);
    const titleDraw = lines
      .map((_, li) => `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=short-title${li}.txt:fontsize=58:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=${200 + li * 76}`)
      .join(",");
    await run("ffmpeg", [
      "-y", "-ss", WONDER ? String(Math.round(total * (part === 1 ? 0.3 : 0.6))) : part === 1 ? "0" : String(Math.round(total * 0.45)), "-t", "55", "-i", final,
      "-filter_complex",
      "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[bg];" +
        "[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2," +
        titleDraw + ",format=yuv420p[v]",
      "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k", "-shortest", shortFile,
    ], { cwd: WORK });
    const shortId = await uploadToYouTube(
      shortFile,
      `${outline.title.slice(0, part === 1 ? 85 : 78)}${part === 1 ? "" : " Part 2"} #shorts`,
      `Watch the full ${WONDER ? "video" : "story"}: https://youtu.be/${id}\n\n${hashtags.join(" ")} #shorts`,
    );
    shortNote += `\n\nShort ${part} (1 min): https://www.youtube.com/watch?v=${shortId}&${AUTH}\nPublish it: https://studio.youtube.com/video/${shortId}/edit?${AUTH}`;
    log("Short uploaded:", shortId);
    // Shorts can now have their own picture (Nov 2026): a vertical version of the video's thumbnail.
    if (THUMB_FILE) {
      try {
        const vt = path.join(WORK, `short-thumb${part}.jpg`);
        await run("ffmpeg", ["-y", "-i", THUMB_FILE, "-filter_complex", "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=18:2[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2", "-q:v", "3", vt]);
        await setThumbnail(shortId, vt);
        log("Short thumbnail set");
      } catch (e) {
        log("short thumbnail skipped:", String(e.message).slice(0, 120));
      }
    }
    await extras.commentLink(shortId, `▶ Watch the full ${WONDER ? "documentary" : "story"} here: https://youtu.be/${id}`);
    if (AUTO) { try { await publishVideo(shortId); log("Short published"); } catch (e) { log("short publish failed:", e.message); } }
    // Also send the Short file to Telegram, ready to post on TikTok.
    try {
      const caption =
        `${outline.title} ${SCARY ? "👻" : WONDER ? "🌍" : "💔"}\nFull video on YouTube: ${CHANNEL === 3 ? "our wonders channel" : CHANNEL === 2 ? "Little Hope Tales" : "@TonyNinsiima"}\n\n` +
        `${hashtags.join(" ")} #fyp ${WONDER ? "#nature #learnsomethingnew" : "#storytime"} ${SCARY ? "#scary" : WONDER ? "#wow" : "#emotional"}`;
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
    if (/free daily allowance|allowance may be used up|allowance is used up/i.test(String(e.message ?? e))) {
      // Retrying before the allowance resets (00:00 UTC) would only fail again: pause new videos until 00:10 UTC.
      await studio("/api/automation/pause", { reason: "ai-allowance", channel: CHANNEL }).catch(() => {});
      await notify("⏸️ The free AI allowance is used up for today, so this video is skipped. The robot pauses and starts again by itself after 04:10 Oman time.");
      return;
    }
    await notify(`❌ I could not finish the video (I will try again automatically).\nReason: ${String(e.message ?? e).slice(0, 500)}`);
    process.exitCode = 1;
  })
  .finally(() => rm(WORK, { recursive: true, force: true }).catch(() => {}));
