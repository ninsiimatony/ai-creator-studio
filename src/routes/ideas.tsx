import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useStudio } from "@/lib/studio-store";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";

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
  const { ideas, addIdea, setIdeaStatus, startScript } = useStudio();
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
