import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio, type Script } from "@/lib/studio-store";
import { Badge } from "@/components/ui-bits";
import { useIntegrations } from "@/lib/use-integrations";
import { canvasAsset, imageAsset, makeTitleCard, videoClipAsset } from "@/render/assets";
import { mixAudio } from "@/render/audio";
import { supportsRendering } from "@/render/codecs";
import { getPreset, PRESETS } from "@/render/presets";
import { renderVideo, type RenderResult } from "@/render/renderer";
import { buildSubtitleCues, toSrt, toVtt } from "@/render/subtitles";
import { autoSplitScenes, buildTimeline } from "@/render/timeline";
import {
  TRANSITIONS,
  type Motion,
  type SceneInput,
  type TransitionKind,
  type VisualAsset,
} from "@/render/types";
import {
  IMAGE_PROVIDERS,
  MUSIC_PROVIDERS,
  VOICE_PROVIDERS,
  decodeAudioFile,
  describeProviders,
  findProvider,
  titleCardImage,
  type MediaEnv,
} from "@/render/providers";

type Source = "auto" | "upload-image" | "upload-clip";
type UiScene = {
  id: string;
  narration: string;
  prompt: string;
  overlayText: string;
  transition: TransitionKind;
  motion: Motion;
  source: Source;
  file?: File | undefined;
};

const MOTIONS: Motion[] = ["zoom-in", "pan-left", "zoom-out", "pan-right"];
const msgOf = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const shorten = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function scenesFrom(script: Script, transition: TransitionKind): UiScene[] {
  const fromBoard = script.storyboard.length > 0;
  const parts = fromBoard
    ? script.storyboard.map((s) => ({
        narration: s.narration,
        prompt: s.visual,
        overlay: s.onScreenText,
      }))
    : autoSplitScenes(script.body).map((n) => ({ narration: n, prompt: n, overlay: "" }));
  return parts.map((p, i) => ({
    id: `scene-${i}`,
    narration: p.narration,
    prompt: p.prompt,
    overlayText: p.overlay,
    transition,
    motion: MOTIONS[i % MOTIONS.length]!,
    source: "auto" as Source,
  }));
}

export function RenderStudio() {
  const { scripts, mode } = useStudio();
  const integ = useIntegrations();
  const env: MediaEnv = {
    server: mode === "db",
    elevenlabs: !!integ.data?.voiceover.configured,
    workersAi: !!integ.data?.mediaAi.configured,
  };
  const usable = scripts.filter((s) => s.body.trim().length > 20);

  const [scriptId, setScriptId] = useState("");
  const script = scripts.find((s) => s.id === scriptId);
  const [scenes, setScenes] = useState<UiScene[]>([]);
  const [presetId, setPresetId] = useState("1080p");
  const preset = getPreset(presetId);
  const [transition, setTransition] = useState<TransitionKind>("crossfade");
  const [burn, setBurn] = useState(true);
  const [voiceId, setVoiceProvider] = useState("none");
  const [voiceName, setVoiceName] = useState("");
  const [imageId, setImageProvider] = useState("title-card");
  const [musicId, setMusicId] = useState("ambient");
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [musicVol, setMusicVol] = useState(0.18);
  const [duck, setDuck] = useState(true);

  const [voices, setVoices] = useState<Map<string, AudioBuffer>>(new Map());
  const visuals = useRef<Map<string, VisualAsset>>(new Map());
  const [visualCount, setVisualCount] = useState(0);
  const [busy, setBusy] = useState<null | "voice" | "visuals" | "render">(null);
  const [progress, setProgress] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<
    (RenderResult & { url: string; srt: string; vtt: string; ms: number; mp4Name: string }) | null
  >(null);
  const abort = useRef<AbortController | null>(null);

  const voiceRows = describeProviders(VOICE_PROVIDERS, env);
  const imageRows = describeProviders(IMAGE_PROVIDERS, env);
  const musicRows = describeProviders(MUSIC_PROVIDERS, env);

  // Release media when leaving the page or switching scripts.
  const clearMedia = () => {
    for (const a of visuals.current.values()) a.dispose();
    visuals.current = new Map();
    setVisualCount(0);
    setVoices(new Map());
    setResult((r) => {
      if (r) URL.revokeObjectURL(r.url);
      return null;
    });
  };
  useEffect(() => () => clearMedia(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function chooseScript(id: string) {
    clearMedia();
    setErrors([]);
    setScriptId(id);
    const s = scripts.find((x) => x.id === id);
    setScenes(s ? scenesFrom(s, transition) : []);
  }
  const patchScene = (id: string, p: Partial<UiScene>) => {
    setScenes((ss) => ss.map((s) => (s.id === id ? { ...s, ...p } : s)));
    // A changed narration or visual invalidates what was generated for that scene.
    if (p.narration !== undefined)
      setVoices((v) => {
        const n = new Map(v);
        n.delete(id);
        return n;
      });
    if (p.prompt !== undefined || p.source !== undefined || p.file !== undefined) {
      visuals.current.get(id)?.dispose();
      visuals.current.delete(id);
      setVisualCount(visuals.current.size);
    }
  };

  const voiced = scenes.filter((s) => voices.has(s.id)).length;
  const totalChars = scenes.reduce((a, s) => a + s.narration.length, 0);

  async function generateVoice() {
    const provider = findProvider(VOICE_PROVIDERS, voiceId);
    if (!provider) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy("voice");
    setErrors([]);
    const next = new Map(voices);
    try {
      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i]!;
        if (next.has(sc.id)) continue;
        setProgress(`Voicing scene ${i + 1} of ${scenes.length}…`);
        setPct(i / scenes.length);
        const bytes = await provider.synthesize(sc.narration, {
          ...(voiceName.trim() ? { voiceId: voiceName.trim() } : {}),
          signal: ctrl.signal,
        });
        next.set(sc.id, await decodeAudioFile(new Blob([bytes])));
        setVoices(new Map(next));
      }
      setProgress(`Voiceover ready for all ${scenes.length} scenes.`);
    } catch (e) {
      setErrors([ctrl.signal.aborted ? "Cancelled." : msgOf(e)]);
      setProgress(
        `Stopped after voicing ${next.size} of ${scenes.length} scenes. What is done is kept.`,
      );
    } finally {
      setBusy(null);
      setPct(null);
    }
  }

  async function buildVisual(
    sc: UiScene,
    index: number,
    ctrl?: AbortController,
  ): Promise<{ asset: VisualAsset; problem?: string }> {
    const title = sc.overlayText || shorten(sc.narration, 80);
    const fallback = () =>
      canvasAsset(makeTitleCard({ title, width: preset.width, height: preset.height, index }));
    try {
      if (sc.source === "upload-image" && sc.file) return { asset: await imageAsset(sc.file) };
      if (sc.source === "upload-clip" && sc.file) return { asset: await videoClipAsset(sc.file) };
      const provider = findProvider(IMAGE_PROVIDERS, imageId) ?? titleCardImage;
      if (!provider.availability(env).ok)
        return {
          asset: fallback(),
          problem: `Scene ${index + 1}: ${provider.label} is not available, so a title card was used.`,
        };
      const prompt =
        provider === titleCardImage
          ? sc.prompt
          : `${sc.prompt}. Cinematic, high quality, no text, no watermark.`;
      return {
        asset: await provider.generate({
          prompt,
          title,
          width: preset.width,
          height: preset.height,
          index,
          ...(ctrl ? { signal: ctrl.signal } : {}),
        }),
      };
    } catch (e) {
      if (ctrl?.signal.aborted) throw e;
      return {
        asset: fallback(),
        problem: `Scene ${index + 1}: ${msgOf(e)} A title card was used instead.`,
      };
    }
  }

  async function generateVisuals() {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy("visuals");
    setErrors([]);
    const problems: string[] = [];
    try {
      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i]!;
        if (visuals.current.has(sc.id)) continue;
        setProgress(`Making visual ${i + 1} of ${scenes.length}…`);
        setPct(i / scenes.length);
        const { asset, problem } = await buildVisual(sc, i, ctrl);
        visuals.current.set(sc.id, asset);
        setVisualCount(visuals.current.size);
        if (problem) problems.push(problem);
      }
      setProgress(`Visuals ready for all ${scenes.length} scenes.`);
    } catch (e) {
      setProgress("Cancelled. What is done is kept.");
      if (!ctrl.signal.aborted) problems.push(msgOf(e));
    } finally {
      setErrors(problems);
      setBusy(null);
      setPct(null);
    }
  }

  async function render() {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy("render");
    setErrors([]);
    setResult((r) => {
      if (r) URL.revokeObjectURL(r.url);
      return null;
    });
    const t0 = performance.now();
    try {
      const problems: string[] = [];
      // Visuals not generated yet fall back to title cards (so Render always works).
      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i]!;
        if (!visuals.current.has(sc.id)) {
          setProgress(`Preparing visual ${i + 1}…`);
          const { asset, problem } = await buildVisual(sc, i, ctrl);
          visuals.current.set(sc.id, asset);
          if (problem) problems.push(problem);
        }
      }
      setVisualCount(visuals.current.size);

      const inputs: SceneInput[] = scenes.map((s) => ({
        id: s.id,
        narration: s.narration,
        voiceSeconds: voices.get(s.id)?.duration ?? null,
        transition: s.transition,
        motion: s.motion,
        overlayText: s.overlayText || undefined,
      }));
      const tl = buildTimeline(inputs, { transitionSec: 0.6 });
      const portrait = preset.height > preset.width;
      const cues = buildSubtitleCues(tl, { maxChars: portrait ? 26 : 42 });

      setProgress("Mixing audio…");
      const sr = 48000;
      let music: { buffer: AudioBuffer; volume: number; duck: boolean } | undefined;
      if (musicId === "upload" && musicFile)
        music = { buffer: await decodeAudioFile(musicFile, sr), volume: musicVol, duck };
      else {
        const mp = findProvider(MUSIC_PROVIDERS, musicId);
        const buf = mp ? await mp.generate({ sampleRate: sr }) : null;
        if (buf) music = { buffer: buf, volume: musicVol, duck };
      }
      const voice = tl.scenes.flatMap((s) => {
        const b = voices.get(s.id);
        return b ? [{ buffer: b, start: s.voiceStart }] : [];
      });
      const audio =
        voice.length || music
          ? await mixAudio({ duration: tl.duration, sampleRate: sr, voice, music })
          : null;

      const res = await renderVideo({
        timeline: tl,
        assets: visuals.current,
        audio,
        cues,
        burnSubtitles: burn,
        preset,
        signal: ctrl.signal,
        onProgress: (p) => {
          setPct(
            p.phase === "video"
              ? p.fraction * 0.9
              : p.phase === "audio"
                ? 0.9 + p.fraction * 0.08
                : 0.99,
          );
          setProgress(
            p.phase === "video"
              ? "Rendering video…"
              : p.phase === "audio"
                ? "Encoding audio…"
                : "Finishing the MP4…",
          );
        },
      });
      const base =
        (script?.title || "video")
          .replace(/[^\w\- ]+/g, "")
          .trim()
          .replace(/\s+/g, "-")
          .slice(0, 60) || "video";
      setResult({
        ...res,
        url: URL.createObjectURL(res.blob),
        srt: toSrt(cues),
        vtt: toVtt(cues),
        ms: Math.round(performance.now() - t0),
        mp4Name: `${base}.mp4`,
      });
      setErrors(problems);
      setProgress("Done.");
    } catch (e) {
      setProgress("");
      setErrors([ctrl.signal.aborted ? "Rendering was cancelled." : msgOf(e)]);
    } finally {
      setBusy(null);
      setPct(null);
    }
  }

  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const canRender = supportsRendering() && scenes.length > 0 && busy === null;
  const baseName = useMemo(() => result?.mp4Name.replace(/\.mp4$/, "") ?? "video", [result]);

  return (
    <div className="space-y-6">
      {!supportsRendering() && (
        <p role="alert" className="panel border-warning/40 p-4 text-sm text-warning">
          This browser cannot render video (it needs WebCodecs). Use a current Chrome, Edge or
          Safari on a computer.
        </p>
      )}

      <section className="panel space-y-3 p-5">
        <h2 className="font-semibold">1. Choose a script</h2>
        {usable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No script has narration yet. Write or generate one in the Script editor first.
          </p>
        ) : (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Script</span>
            <select
              aria-label="Script"
              className="field"
              value={scriptId}
              onChange={(e) => chooseScript(e.target.value)}
            >
              <option value="">Select a script…</option>
              {usable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {script && (
          <p className="text-xs text-muted-foreground">
            {scenes.length} scenes, {totalChars.toLocaleString()} characters of narration
            {script.storyboard.length > 0
              ? " (taken from your storyboard)."
              : " (split automatically — generate a storyboard on the Script page for better visuals)."}
          </p>
        )}
      </section>

      {script && (
        <>
          <section className="panel space-y-3 p-5">
            <h2 className="font-semibold">2. Scenes</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Transition between scenes</span>
              <select
                aria-label="Transition between scenes"
                className="field w-auto"
                value={transition}
                onChange={(e) => {
                  const t = e.target.value as TransitionKind;
                  setTransition(t);
                  setScenes((ss) => ss.map((s) => ({ ...s, transition: t })));
                }}
              >
                {TRANSITIONS.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <ol className="space-y-3">
              {scenes.map((s, i) => (
                <li key={s.id} className="rounded-md border p-3 text-sm">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-medium">Scene {i + 1}</span>
                    {voices.has(s.id) && (
                      <Badge tone="ok">Voiced {voices.get(s.id)!.duration.toFixed(1)}s</Badge>
                    )}
                    {visuals.current.has(s.id) && <Badge tone="teal">Visual ready</Badge>}
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-xs text-muted-foreground">
                      Narration (spoken and subtitled)
                    </span>
                    <textarea
                      aria-label={`Narration for scene ${i + 1}`}
                      className="field"
                      rows={2}
                      value={s.narration}
                      onChange={(e) => patchScene(s.id, { narration: e.target.value })}
                    />
                  </label>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">
                        Image prompt (for AI images)
                      </span>
                      <input
                        className="field"
                        value={s.prompt}
                        maxLength={500}
                        onChange={(e) => patchScene(s.id, { prompt: e.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-muted-foreground">
                        On-screen text (optional)
                      </span>
                      <input
                        className="field"
                        value={s.overlayText}
                        maxLength={120}
                        onChange={(e) => patchScene(s.id, { overlayText: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="text-xs text-muted-foreground">
                      Visual{" "}
                      <select
                        aria-label={`Visual source for scene ${i + 1}`}
                        className="field inline-block w-auto"
                        value={s.source}
                        onChange={(e) =>
                          patchScene(s.id, { source: e.target.value as Source, file: undefined })
                        }
                      >
                        <option value="auto">Generated (provider below)</option>
                        <option value="upload-image">My own image</option>
                        <option value="upload-clip">My own video clip</option>
                      </select>
                    </label>
                    {s.source !== "auto" && (
                      <input
                        type="file"
                        aria-label={`File for scene ${i + 1}`}
                        accept={s.source === "upload-image" ? "image/*" : "video/*"}
                        onChange={(e) => patchScene(s.id, { file: e.target.files?.[0] })}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel space-y-3 p-5">
            <h2 className="font-semibold">3. Voiceover</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Voice provider</span>
              <select
                aria-label="Voice provider"
                className="field"
                value={voiceId}
                onChange={(e) => setVoiceProvider(e.target.value)}
              >
                <option value="none">No voiceover (scenes timed by reading pace)</option>
                {voiceRows.map((r) => (
                  <option key={r.id} value={r.id} disabled={!r.availability.ok}>
                    {r.label}
                    {r.availability.ok ? "" : " — not available"}
                  </option>
                ))}
              </select>
            </label>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {voiceRows.map((r) => (
                <li key={r.id}>
                  <strong className="text-foreground">{r.label}:</strong>{" "}
                  {r.availability.ok ? r.cost : r.availability.reason}
                </li>
              ))}
            </ul>
            {voiceId === "elevenlabs" && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium">
                  ElevenLabs voice ID (optional if a default is configured)
                </span>
                <input
                  aria-label="ElevenLabs voice ID"
                  className="field"
                  maxLength={64}
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                />
              </label>
            )}
            {voiceId !== "none" && (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="btn"
                  disabled={busy !== null || scenes.length === 0}
                  onClick={() => void generateVoice()}
                >
                  {busy === "voice"
                    ? "Generating…"
                    : voiced > 0
                      ? "Generate missing voiceover"
                      : "Generate voiceover"}
                </button>
                <span className="text-xs text-muted-foreground">
                  {voiced} of {scenes.length} scenes voiced. Each scene is voiced separately so
                  voice and picture stay exactly in sync.
                </span>
              </div>
            )}
          </section>

          <section className="panel space-y-3 p-5">
            <h2 className="font-semibold">4. Visuals</h2>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">
                Image provider (for scenes that use generated visuals)
              </span>
              <select
                aria-label="Image provider"
                className="field"
                value={imageId}
                onChange={(e) => {
                  setImageProvider(e.target.value);
                  clearVisualsOnly();
                }}
              >
                {imageRows.map((r) => (
                  <option key={r.id} value={r.id} disabled={!r.availability.ok}>
                    {r.label}
                    {r.availability.ok ? "" : " — not available"}
                  </option>
                ))}
              </select>
            </label>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {imageRows.map((r) => (
                <li key={r.id}>
                  <strong className="text-foreground">{r.label}:</strong>{" "}
                  {r.availability.ok ? r.cost : r.availability.reason}
                </li>
              ))}
              <li>
                <strong className="text-foreground">AI video clips:</strong> not connected (paid per
                second). Use “My own video clip” on any scene, or connect a provider in code.
              </li>
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="btn"
                disabled={busy !== null || scenes.length === 0}
                onClick={() => void generateVisuals()}
              >
                {busy === "visuals" ? "Generating…" : "Generate visuals"}
              </button>
              <span className="text-xs text-muted-foreground">
                {visualCount} of {scenes.length} visuals ready (Render fills any gaps with title
                cards).
              </span>
            </div>
          </section>

          <section className="panel space-y-3 p-5">
            <h2 className="font-semibold">5. Music, subtitles and export</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Background music</span>
                <select
                  aria-label="Background music"
                  className="field"
                  value={musicId}
                  onChange={(e) => setMusicId(e.target.value)}
                >
                  {musicRows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                  <option value="upload">My own track (you must have the rights)</option>
                </select>
              </label>
              {musicId === "upload" && (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Music file</span>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(e) => setMusicFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              )}
              {musicId !== "none" && (
                <>
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">
                      Music volume ({Math.round(musicVol * 100)}%)
                    </span>
                    <input
                      type="range"
                      aria-label="Music volume"
                      min={0.05}
                      max={0.5}
                      step={0.01}
                      value={musicVol}
                      onChange={(e) => setMusicVol(Number(e.target.value))}
                      className="w-full"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={duck}
                      onChange={(e) => setDuck(e.target.checked)}
                    />
                    Lower the music while the voice is speaking
                  </label>
                </>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
              Burn subtitles into the video (SRT and VTT files are always provided to download)
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Format</span>
              <select
                aria-label="Format"
                className="field w-auto"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} — {p.width}×{p.height}, {p.fps} fps
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted-foreground">
                {preset.note} Rendering happens in your browser and takes roughly 1–3× the video's
                length.
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn btn-primary"
                disabled={!canRender}
                onClick={() => void render()}
              >
                {busy === "render" ? "Rendering…" : "Render MP4"}
              </button>
              {busy !== null && (
                <button className="btn" onClick={() => abort.current?.abort()}>
                  Cancel
                </button>
              )}
            </div>
          </section>
        </>
      )}

      {(progress || pct !== null) && (
        <div role="status" className="panel p-4 text-sm">
          <div>{progress}</div>
          {pct !== null && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full bg-primary" style={{ width: `${Math.round(pct * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {errors.length > 0 && (
        <ul
          role="alert"
          className="panel space-y-1 border-destructive/40 p-4 text-sm text-destructive"
        >
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      {result && (
        <section className="panel space-y-3 p-5" aria-label="Rendered video">
          <h2 className="font-semibold">Your video</h2>
          <video
            src={result.url}
            controls
            className="w-full max-w-3xl rounded-md border"
            data-testid="result-video"
          />
          <p className="text-xs text-muted-foreground">
            {result.info.width}×{result.info.height} · {result.info.fps} fps ·{" "}
            {result.info.durationSec.toFixed(1)} s · {(result.info.bytes / 1_048_576).toFixed(1)} MB
            · {result.info.videoCodec}
            {result.info.audioCodec ? ` + ${result.info.audioCodec}` : " (no audio)"} · rendered in{" "}
            {(result.ms / 1000).toFixed(1)} s
          </p>
          {result.info.youtubeRecommended ? (
            <Badge tone="ok">H.264 + AAC — YouTube's recommended format</Badge>
          ) : (
            <p className="text-xs text-warning">
              {result.info.warnings[0] ??
                "Silent video: YouTube accepts it, but most videos need narration or music."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <a className="btn btn-primary" href={result.url} download={result.mp4Name}>
              Download MP4
            </a>
            <button
              className="btn"
              onClick={() => download(`${baseName}.srt`, result.srt, "application/x-subrip")}
            >
              Download subtitles (.srt)
            </button>
            <button
              className="btn"
              onClick={() => download(`${baseName}.vtt`, result.vtt, "text/vtt")}
            >
              Download subtitles (.vtt)
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Upload the MP4 from the Publishing page after approval. This video is kept in your
            browser only — download it to keep it. Disclose AI narration and generated imagery as
            YouTube's altered or synthetic content rules require.
          </p>
        </section>
      )}
    </div>
  );

  function clearVisualsOnly() {
    for (const a of visuals.current.values()) a.dispose();
    visuals.current = new Map();
    setVisualCount(0);
  }
}
