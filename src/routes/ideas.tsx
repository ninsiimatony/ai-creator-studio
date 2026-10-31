import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStudio } from "@/lib/studio-store";
import { AiBox, Badge, NextStep, PageHeader } from "@/components/ui-bits";
import { aiIdeas } from "@/lib/ai.functions";
import { aiBlockedReason, useIntegrations } from "@/lib/use-integrations";

export const Route = createFileRoute("/ideas")({
  head: () => ({
    meta: [
      { title: "Idea research — Tony AI YouTube Studio" },
      {
        name: "description",
        content: "Research queue of video ideas on AI, robotics and the future.",
      },
      { property: "og:title", content: "Idea research — Tony AI YouTube Studio" },
      {
        property: "og:description",
        content: "Research queue of video ideas on AI, robotics and the future.",
      },
    ],
  }),
  component: Ideas,
});

function Ideas() {
  const { ideas, addIdea, setIdeaStatus, startScript, mode, reload } = useStudio();
  const qc = useQueryClient();
  const integ = useIntegrations();
  const blocked = aiBlockedReason(mode, integ.data);
  const [aiTopic, setAiTopic] = useState("");
  const [aiCount, setAiCount] = useState(5);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const [aiErr, setAiErr] = useState("");
  async function generateIdeas() {
    setAiBusy(true);
    setAiMsg("");
    setAiErr("");
    try {
      const r = await aiIdeas({ data: { topic: aiTopic.trim() || undefined, count: aiCount } });
      await reload();
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      setAiMsg(
        `Added ${r.ideas.length} ideas · cost $${r.usage.costUsd.toFixed(4)} (${r.usage.model}).`,
      );
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setAiBusy(false);
    }
  }
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("AI technology");
  const [msg, setMsg] = useState("");
  return (
    <>
      <PageHeader
        title="Idea research queue"
        desc="Scores are illustrative demo values, not real search or trend data."
      />
      <form
        className="panel mb-6 grid gap-3 p-4 sm:grid-cols-[1fr_180px_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          await addIdea(title.trim(), topic);
          setTitle("");
        }}
      >
        <label className="sr-only" htmlFor="it">
          Idea title
        </label>
        <input
          id="it"
          className="field"
          placeholder="Add an idea, e.g. 'Can robots feel?'"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="sr-only" htmlFor="tp">
          Topic
        </label>
        <select id="tp" className="field" value={topic} onChange={(e) => setTopic(e.target.value)}>
          {["AI technology", "AI tools", "Robotics", "Future"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <button className="btn btn-primary" type="submit">
          Add idea
        </button>
      </form>
      <div className="mb-6">
        <AiBox title="Generate ideas with AI" blocked={blocked}>
          <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto]">
            <label className="sr-only" htmlFor="ai-topic">
              Topic or theme (optional)
            </label>
            <input
              id="ai-topic"
              className="field"
              placeholder="Optional theme, e.g. 'robots in healthcare'"
              maxLength={120}
              value={aiTopic}
              onChange={(e) => setAiTopic(e.target.value)}
            />
            <label className="sr-only" htmlFor="ai-count">
              How many ideas
            </label>
            <select
              id="ai-count"
              className="field"
              value={aiCount}
              onChange={(e) => setAiCount(Number(e.target.value))}
            >
              {[3, 5, 8].map((n) => (
                <option key={n} value={n}>
                  {n} ideas
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={aiBusy}
              onClick={() => void generateIdeas()}
            >
              {aiBusy ? "Thinking…" : "Generate"}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Brainstorms only — Claude has no web access, so these are not trend or search data. Cost
            is metered against your daily AI budget.
          </p>
          {aiMsg && (
            <p role="status" className="text-sm text-primary">
              {aiMsg}
            </p>
          )}
          {aiErr && (
            <p role="alert" className="text-sm text-destructive">
              {aiErr}
            </p>
          )}
        </AiBox>
      </div>
      {msg && (
        <p role="status" className="mb-4 text-sm text-primary">
          {msg}
        </p>
      )}
      {ideas.length === 0 && (
        <p className="panel p-6 text-sm text-muted-foreground">
          No ideas yet. Add your first idea above.
        </p>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {ideas.map((i) => (
          <li key={i.id} className={`panel p-4 ${i.status === "rejected" ? "opacity-50" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-medium">{i.title}</h3>
              <Badge tone={i.status === "shortlisted" ? "teal" : "off"}>{i.status}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {i.topic} · {i.angle}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Demo score: {i.score || "—"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn" onClick={() => void setIdeaStatus(i.id, "shortlisted")}>
                Shortlist
              </button>
              <button className="btn" onClick={() => void setIdeaStatus(i.id, "rejected")}>
                Reject
              </button>
              <button
                className="btn"
                onClick={async () => {
                  if (await startScript(i.id)) setMsg(`Script draft created for "${i.title}".`);
                }}
              >
                Start script
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <NextStep title="AI research assistant">
          Once an AI model is connected (a later phase), this queue can suggest ideas from trends.
          For now, ideas are entered manually.
        </NextStep>
      </div>
    </>
  );
}
