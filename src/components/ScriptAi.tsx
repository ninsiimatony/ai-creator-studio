import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStudio, type Script } from "@/lib/studio-store";
import { AiBox } from "@/components/ui-bits";
import { aiScriptDraft, aiStoryboard, type ScriptDraft } from "@/lib/ai.functions";
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
