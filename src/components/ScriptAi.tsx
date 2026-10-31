import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStudio, type Script } from "@/lib/studio-store";
import { AiBox } from "@/components/ui-bits";
import {
  aiScriptDraft,
  aiStoryboard,
  getVoiceoverPlan,
  type ScriptDraft,
  type VoiceoverPlan,
} from "@/lib/ai.functions";
import { aiBlockedReason, useIntegrations } from "@/lib/use-integrations";

const msgOf = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

/** AI drafting and storyboarding for one script. Drafts are reviewed before they are applied. */
export function ScriptAi({ script }: { script: Script }) {
  const { mode, reload, updateScript } = useStudio();
  const qc = useQueryClient();
  const blocked = aiBlockedReason(mode, useIntegrations().data);
  const [minutes, setMinutes] = useState(6);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"draft" | "board" | null>(null);
  const [draft, setDraft] = useState<ScriptDraft | null>(null);
  const [info, setInfo] = useState("");
  const [err, setErr] = useState("");

  const finish = (usage: { costUsd: number; model: string }) => {
    void qc.invalidateQueries({ queryKey: ["integrations"] });
    setInfo(`Done · cost $${usage.costUsd.toFixed(4)} (${usage.model}).`);
  };

  async function makeDraft() {
    setBusy("draft");
    setErr("");
    setInfo("");
    try {
      const r = await aiScriptDraft({ data: { scriptId: script.id, minutes, notes } });
      setDraft(r.data);
      finish(r.usage);
    } catch (e) {
      setErr(msgOf(e));
    } finally {
      setBusy(null);
    }
  }

  function applyDraft() {
    if (!draft) return;
    const hasText = script.hook || script.outline || script.body || script.cta;
    if (
      hasText &&
      !window.confirm("Replace your current hook, outline, narration and CTA with this draft?")
    ) {
      return;
    }
    updateScript(script.id, draft);
    setDraft(null);
    setInfo("Draft applied. Review and edit it above — it is saved automatically.");
  }

  async function makeStoryboard() {
    setBusy("board");
    setErr("");
    setInfo("");
    try {
      const r = await aiStoryboard({ data: { scriptId: script.id } });
      await reload();
      finish(r.usage);
    } catch (e) {
      setErr(msgOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <AiBox title="Draft this script with AI" blocked={blocked}>
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Length</span>
            <select
              className="field"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              {[3, 6, 8, 10, 12].map((m) => (
                <option key={m} value={m}>
                  ~{m} min
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Notes for the AI (optional)</span>
            <input
              className="field"
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Angle, tone, points to include…"
            />
          </label>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => void makeDraft()}
        >
          {busy === "draft" ? "Writing…" : "Generate draft"}
        </button>
        <p className="text-xs text-muted-foreground">
          The draft is shown for review first and never overwrites your script until you apply it.
          Fact-check anything it states — it can be wrong and has no web access.
        </p>
        {draft && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
            <div className="mb-2 font-medium">Draft for review</div>
            <p>
              <span className="text-muted-foreground">Hook: </span>
              {draft.hook}
            </p>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
              {draft.outline}
            </pre>
            <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{draft.body}</p>
            <p className="mt-2">
              <span className="text-muted-foreground">CTA: </span>
              {draft.cta}
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn btn-primary" onClick={applyDraft}>
                Apply to script
              </button>
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
      </AiBox>

      <AiBox title="Storyboard (shot list for a faceless video)" blocked={blocked}>
        <button
          className="btn"
          disabled={busy !== null || !script.body.trim()}
          onClick={() => void makeStoryboard()}
        >
          {busy === "board"
            ? "Planning scenes…"
            : script.storyboard.length
              ? "Regenerate storyboard"
              : "Generate storyboard"}
        </button>
        {!script.body.trim() && (
          <p className="text-xs text-muted-foreground">Write or generate the narration first.</p>
        )}
        {script.storyboard.length > 0 && (
          <ol className="space-y-2 text-sm">
            {script.storyboard.map((sc, i) => (
              <li key={i} className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">
                  Scene {i + 1} · ~{Math.round(sc.seconds)}s
                </div>
                <div>{sc.visual}</div>
                <div className="text-xs text-muted-foreground">
                  Search: {sc.keywords.join(", ")}
                  {sc.onScreenText ? ` · On-screen: “${sc.onScreenText}”` : ""}
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted-foreground">
          This plans the visuals. Rendering video is not connected.
        </p>
      </AiBox>
      <Voiceover script={script} />
      {info && (
        <p role="status" className="text-sm text-primary">
          {info}
        </p>
      )}
      {err && (
        <p role="alert" className="text-sm text-destructive">
          {err}
        </p>
      )}
    </div>
  );
}

type Clip = { part: number; url: string };

/** ElevenLabs voiceover, one part at a time. Audio is played/downloaded, never stored. */
function Voiceover({ script }: { script: Script }) {
  const { mode } = useStudio();
  const integ = useIntegrations();
  const [plan, setPlan] = useState<VoiceoverPlan | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [err, setErr] = useState("");

  const configured = integ.data?.voiceover.configured;
  const blocked =
    mode === "demo"
      ? "Voiceover needs the database. It is unavailable in demo mode."
      : !integ.data
        ? "Checking voiceover status…"
        : !configured
          ? "Not connected — the ELEVENLABS_API_KEY secret has not been added."
          : null;

  useEffect(() => {
    if (mode !== "db" || !script.body.trim()) return setPlan(null);
    let live = true;
    getVoiceoverPlan({ data: { scriptId: script.id } })
      .then((p) => live && setPlan(p))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [mode, script.id, script.body]);
  useEffect(() => () => clips.forEach((c) => URL.revokeObjectURL(c.url)), [clips]);

  async function generate(part: number) {
    setBusy(part);
    setErr("");
    try {
      const res = await fetch("/api/voiceover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scriptId: script.id, part, voiceId: voiceId.trim() || undefined }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "The voiceover request failed.");
      }
      const url = URL.createObjectURL(await res.blob());
      setClips((cs) =>
        [...cs.filter((c) => c.part !== part), { part, url }].sort((a, b) => a.part - b.part),
      );
      setPlan(await getVoiceoverPlan({ data: { scriptId: script.id } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AiBox title="Voiceover (ElevenLabs)" blocked={blocked}>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">
          Voice ID (optional if a default is configured)
        </span>
        <input
          className="field"
          maxLength={64}
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          placeholder="From your ElevenLabs voice library"
        />
      </label>
      {!plan && <p className="text-sm text-muted-foreground">Write the narration first.</p>}
      {plan && (
        <>
          <p className="text-xs text-muted-foreground">
            {plan.chars.toLocaleString()} characters in {plan.parts} part
            {plan.parts === 1 ? "" : "s"}. Each generation uses ElevenLabs credits from{" "}
            <em>your</em> ElevenLabs plan. Today: {plan.usedToday.toLocaleString()} /{" "}
            {plan.dailyCap.toLocaleString()} characters.
          </p>
          <ul className="space-y-2">
            {Array.from({ length: plan.parts }, (_, i) => {
              const clip = clips.find((c) => c.part === i);
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <button className="btn" disabled={busy !== null} onClick={() => void generate(i)}>
                    {busy === i
                      ? "Generating…"
                      : clip
                        ? `Regenerate part ${i + 1}`
                        : `Generate part ${i + 1}`}
                  </button>
                  {clip && (
                    <>
                      <audio controls src={clip.url} className="h-9 max-w-full" />
                      <a
                        className="btn"
                        href={clip.url}
                        download={`${script.title || "voiceover"}-part-${i + 1}.mp3`}
                      >
                        Download
                      </a>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Audio is not stored on the server — download each part to keep it. Disclose AI narration to
        your audience as YouTube requires.
      </p>
      {err && (
        <p role="alert" className="text-sm text-destructive">
          {err}
        </p>
      )}
    </AiBox>
  );
}
