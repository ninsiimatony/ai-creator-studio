import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useStudio } from "@/lib/studio-store";
import { AiBox, Badge, PageHeader } from "@/components/ui-bits";
import { getAutomationRuns, runDraftSweep, runIdeaSweep } from "@/lib/ai.functions";
import { aiBlockedReason, useIntegrations } from "@/lib/use-integrations";

export const Route = createFileRoute("/automation")({
  head: () => ({
    meta: [
      { title: "Automation — Tony AI YouTube Studio" },
      {
        name: "description",
        content: "One-click batch drafting of ideas and scripts, always for review.",
      },
    ],
  }),
  component: Automation,
});

const msgOf = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function Automation() {
  const { mode, ideas, reload } = useStudio();
  const qc = useQueryClient();
  const blocked = aiBlockedReason(mode, useIntegrations().data);
  const runs = useQuery({
    queryKey: ["automation-runs"],
    queryFn: () => getAutomationRuns(),
    enabled: mode === "db",
    retry: false,
  });
  const [topics, setTopics] = useState("");
  const [count, setCount] = useState(3);
  const [max, setMax] = useState(2);
  const [busy, setBusy] = useState<"ideas" | "drafts" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const waiting = ideas.filter((i) => i.status === "shortlisted").length;

  async function go(kind: "ideas" | "drafts") {
    setBusy(kind);
    setResult(null);
    try {
      const r =
        kind === "ideas"
          ? await runIdeaSweep({
              data: {
                topics: topics
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                countPerTopic: count,
              },
            })
          : await runDraftSweep({ data: { max } });
      setResult({ ok: r.ok, text: r.summary });
      await reload();
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      void qc.invalidateQueries({ queryKey: ["automation-runs"] });
    } catch (e) {
      setResult({ ok: false, text: msgOf(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Automation"
        desc="One-click batch drafting. Everything it creates is a draft for your review; it never approves, uploads or publishes anything."
      />
      <div className="panel mb-6 flex flex-wrap items-center gap-2 p-4 text-sm">
        <Badge>Unattended scheduling: off</Badge>
        <span className="text-muted-foreground">
          Runs happen only when you press a button. Nothing runs on a timer.
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <AiBox title="Idea sweep" blocked={blocked}>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              Themes (comma separated, up to 3; optional)
            </span>
            <input
              className="field"
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="humanoid robots, AI chips"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Ideas per theme</span>
            <select
              className="field w-auto"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {[1, 3, 5].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => void go("ideas")}
          >
            {busy === "ideas" ? "Working…" : "Run idea sweep"}
          </button>
        </AiBox>

        <AiBox title="Draft scripts for shortlisted ideas" blocked={blocked}>
          <p className="text-sm text-muted-foreground">
            {waiting} shortlisted idea{waiting === 1 ? "" : "s"} in your queue. Ideas that already
            have a script are skipped.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">How many scripts (each ~6 minutes)</span>
            <select
              className="field w-auto"
              value={max}
              onChange={(e) => setMax(Number(e.target.value))}
            >
              {[1, 2, 3].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => void go("drafts")}
          >
            {busy === "drafts" ? "Writing…" : "Draft scripts"}
          </button>
        </AiBox>
      </div>

      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={`mt-4 text-sm ${result.ok ? "text-primary" : "text-destructive"}`}
        >
          {result.text}
        </p>
      )}

      <section className="panel mt-6 p-5">
        <h2 className="mb-3 font-semibold">Recent runs</h2>
        {mode === "demo" && (
          <p className="text-sm text-muted-foreground">Run history needs the database.</p>
        )}
        {runs.data?.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        <ul className="divide-y text-sm">
          {runs.data?.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <Badge tone={r.status === "ok" ? "ok" : "bad"}>{r.status}</Badge>{" "}
                <span className="text-muted-foreground">{r.kind}</span> — {r.summary}
              </span>
              <span className="text-xs text-muted-foreground">{r.createdAt} UTC</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
