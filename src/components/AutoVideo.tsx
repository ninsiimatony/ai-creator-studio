import { useRef, useState } from "react";
import { canvasAsset, makeTitleCard, videoClipAsset } from "@/render/assets";
import { mixAudio } from "@/render/audio";
import { supportsRendering } from "@/render/codecs";
import { getPreset } from "@/render/presets";
import { renderVideo, type RenderResult } from "@/render/renderer";
import { buildSubtitleCues, toSrt } from "@/render/subtitles";
import { autoSplitScenes, buildTimeline } from "@/render/timeline";
import type { Motion, SceneInput, VisualAsset } from "@/render/types";
import { MUSIC_PROVIDERS, decodeAudioFile, findProvider } from "@/render/providers";
import { postForBlob } from "@/render/providers/http";

const MOTIONS: Motion[] = ["zoom-in", "pan-left", "zoom-out", "pan-right"];
const msgOf = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outline = { title: string; sections: string[] };
type Section = { narration: string; visuals: string[] };

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const blob = await postForBlob(url, body, signal);
  return JSON.parse(await blob.text()) as T;
}

/** One prompt in, one finished MP4 out: AI script, free voice, stock clips, music, subtitles, render. */
export function AutoVideo() {
  const [topic, setTopic] = useState("");
  const [minutes, setMinutes] = useState(10);
  const [style, setStyle] = useState<"real" | "cartoon">("real");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<
    (RenderResult & { url: string; srt: string; name: string }) | null
  >(null);
  const abort = useRef<AbortController | null>(null);

  async function make() {
    const ctrl = new AbortController();
    abort.current = ctrl;
    const sig = ctrl.signal;
    setBusy(true);
    setError("");
    setNotes([]);
    setResult((r) => {
      if (r) URL.revokeObjectURL(r.url);
      return null;
    });
    const visuals = new Map<string, VisualAsset>();
    const problems: string[] = [];
    try {
      const preset = getPreset(minutes > 10 ? "720p" : "1080p");

      // 1. Plan and write the script (free AI).
      setProgress("Planning the video…");
      setPct(0);
      const outline = await postJson<Outline>(
        "/api/media/auto-script",
        { step: "outline", topic: topic.trim(), minutes },
        sig,
      );
      const sections: Section[] = [];
      for (let i = 0; i < outline.sections.length; i++) {
        setProgress(`Writing the script: part ${i + 1} of ${outline.sections.length}…`);
        setPct((i / outline.sections.length) * 0.15);
        let got: Section | null = null;
        for (let attempt = 0; attempt < 3 && !got; attempt++) {
          try {
            got = await postJson<Section>(
              "/api/media/auto-script",
              {
                step: "section",
                topic: topic.trim(),
                title: outline.title,
                sections: outline.sections,
                index: i,
                style,
              },
              sig,
            );
          } catch (e) {
            if (sig.aborted || attempt === 2) throw e;
            await wait(2000);
          }
        }
        sections.push(got!);
      }

      // 2. Split into short scenes, each with search words for its clip.
      const scenes: { id: string; narration: string; term: string }[] = [];
      sections.forEach((sec, si) => {
        const parts = autoSplitScenes(sec.narration, 28);
        parts.forEach((narration, pi) => {
          scenes.push({
            id: `s${si}-${pi}`,
            narration,
            term: sec.visuals[pi % Math.max(1, sec.visuals.length)] ?? outline.sections[si] ?? "",
          });
        });
      });

      // 3. Voice (free) and a clip for every scene, one scene at a time.
      const voices = new Map<string, AudioBuffer>();
      const small = minutes > 10;
      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i]!;
        setProgress(`Making scene ${i + 1} of ${scenes.length} (voice and video clip)…`);
        setPct(0.15 + (i / scenes.length) * 0.5);
        const wav = await postForBlob("/api/media/tts", { text: sc.narration, lang: "en" }, sig);
        voices.set(sc.id, await decodeAudioFile(wav));
        let asset: VisualAsset;
        try {
          await wait(1100);
          const clip = await postForBlob(
            "/api/media/stock-clip",
            { text: sc.narration.slice(0, 400), query: sc.term, index: i, style, small },
            sig,
          );
          asset = await videoClipAsset(clip);
        } catch (e) {
          if (sig.aborted) throw e;
          if (problems.length < 5) problems.push(`Scene ${i + 1}: ${msgOf(e)} A title card was used.`);
          asset = canvasAsset(
            makeTitleCard({
              title: sc.term || outline.title,
              width: preset.width,
              height: preset.height,
              index: i,
            }),
          );
        }
        visuals.set(sc.id, asset);
      }

      // 4. Timeline, subtitles, music, render.
      const inputs: SceneInput[] = scenes.map((s, i) => ({
        id: s.id,
        narration: s.narration,
        voiceSeconds: voices.get(s.id)?.duration ?? null,
        transition: "crossfade",
        motion: MOTIONS[i % MOTIONS.length]!,
      }));
      const tl = buildTimeline(inputs, { transitionSec: 0.6 });
      const cues = buildSubtitleCues(tl, { maxChars: 42 });
      setProgress("Mixing audio…");
      setPct(0.66);
      const sr = 48000;
      const mp = findProvider(MUSIC_PROVIDERS, "ambient");
      const buf = mp ? await mp.generate({ sampleRate: sr }) : null;
      const music = buf ? { buffer: buf, volume: 0.15, duck: true } : undefined;
      const voice = tl.scenes.flatMap((s) => {
        const b = voices.get(s.id);
        return b ? [{ buffer: b, start: s.voiceStart }] : [];
      });
      const audio = await mixAudio({ duration: tl.duration, sampleRate: sr, voice, music });
      voices.clear();

      const res = await renderVideo({
        timeline: tl,
        assets: visuals,
        audio,
        cues,
        burnSubtitles: true,
        preset,
        signal: sig,
        onProgress: (p) => {
          setPct(0.67 + (p.phase === "video" ? p.fraction * 0.29 : 0.3));
          setProgress(
            p.phase === "video"
              ? "Rendering the video… keep this tab open."
              : p.phase === "audio"
                ? "Encoding audio…"
                : "Finishing the MP4…",
          );
        },
      });
      const name =
        outline.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "video";
      setResult({ ...res, url: URL.createObjectURL(res.blob), srt: toSrt(cues), name: `${name}.mp4` });
      setNotes(problems);
      setProgress("Done. Your video is ready.");
    } catch (e) {
      setProgress("");
      setError(sig.aborted ? "Cancelled." : msgOf(e));
      setNotes(problems);
    } finally {
      for (const a of visuals.values()) a.dispose();
      setBusy(false);
      setPct(null);
    }
  }

  return (
    <section className="panel space-y-3 p-5" aria-label="Make a video from one prompt">
      <h2 className="font-semibold">Make a video from one prompt</h2>
      <p className="text-sm text-muted-foreground">
        Type your idea once and press the button. The studio writes the script, adds a free voice,
        finds real video clips, adds music and subtitles, and renders the MP4. Keep this tab open.
      </p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Your idea</span>
        <textarea
          aria-label="Your idea"
          className="field min-h-24"
          maxLength={500}
          placeholder="Example: How humanoid robots learn to walk, explained simply"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={busy}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Length</span>
          <select
            aria-label="Length"
            className="field"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            disabled={busy}
          >
            <option value={3}>3 minutes (quick test)</option>
            <option value={10}>10 minutes</option>
            <option value={20}>20 minutes</option>
            <option value={30}>30 minutes (needs a lot of memory)</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Style</span>
          <select
            aria-label="Style"
            className="field"
            value={style}
            onChange={(e) => setStyle(e.target.value as "real" | "cartoon")}
            disabled={busy}
          >
            <option value="real">Real footage</option>
            <option value="cartoon">Cartoon / animation</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary"
          disabled={busy || topic.trim().length < 3 || !supportsRendering()}
          onClick={() => void make()}
        >
          {busy ? "Making your video…" : "Make video"}
        </button>
        {busy && (
          <button className="btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
      </div>
      {(progress || pct !== null) && (
        <div role="status" className="text-sm">
          <div>{progress}</div>
          {pct !== null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full bg-primary" style={{ width: `${Math.round(pct * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notes.length > 0 && (
        <ul className="space-y-1 text-xs text-warning">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {result && (
        <div className="space-y-2">
          <video src={result.url} controls className="w-full max-w-3xl rounded-md border" />
          <p className="text-xs text-muted-foreground">
            {result.info.width}×{result.info.height} · {Math.round(result.info.durationSec / 60)}{" "}
            min · {(result.info.bytes / 1_048_576).toFixed(0)} MB
          </p>
          <a className="btn btn-primary" href={result.url} download={result.name}>
            Download MP4
          </a>
        </div>
      )}
    </section>
  );
}
