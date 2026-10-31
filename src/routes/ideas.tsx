import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useStudio, type Idea } from "@/lib/studio-store";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/ideas")({
  head: () => ({
    meta: [
      { title: "Idea research — Tony AI YouTube Studio" },
      { name: "description", content: "Research queue of video ideas on AI, robotics and the future." },
      { property: "og:title", content: "Idea research — Tony AI YouTube Studio" },
      { property: "og:description", content: "Research queue of video ideas on AI, robotics and the future." },
    ],
  }),
  component: Ideas,
});

function Ideas() {
  const { ideas, setIdeas, setScripts } = useStudio();
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("AI technology");
  const [msg, setMsg] = useState("");
  const set = (id: string, status: Idea["status"]) => setIdeas((is) => is.map((i) => (i.id === id ? { ...i, status } : i)));
  return (
    <>
      <PageHeader title="Idea research queue" desc="Scores are illustrative demo values, not real search or trend data." />
      <form className="panel mb-6 grid gap-3 p-4 sm:grid-cols-[1fr_180px_auto]"
        onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return;
          setIdeas((is) => [{ id: crypto.randomUUID(), title: title.trim(), topic, angle: "Manual idea", score: 0, status: "new" }, ...is]); setTitle(""); }}>
        <label className="sr-only" htmlFor="it">Idea title</label>
        <input id="it" className="field" placeholder="Add an idea, e.g. 'Can robots feel?'" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="sr-only" htmlFor="tp">Topic</label>
        <select id="tp" className="field" value={topic} onChange={(e) => setTopic(e.target.value)}>
          {["AI technology", "AI tools", "Robotics", "Future"].map((t) => <option key={t}>{t}</option>)}
        </select>
        <button className="btn btn-primary" type="submit">Add idea</button>
      </form>
      {msg && <p role="status" className="mb-4 text-sm text-primary">{msg}</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {ideas.map((i) => (
          <li key={i.id} className={`panel p-4 ${i.status === "rejected" ? "opacity-50" : ""}`}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-medium">{i.title}</h3>
              <Badge tone={i.status === "shortlisted" ? "teal" : "off"}>{i.status}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{i.topic} · {i.angle}</p>
            <p className="mt-1 text-xs text-muted-foreground">Demo score: {i.score || "—"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn" onClick={() => set(i.id, "shortlisted")}>Shortlist</button>
              <button className="btn" onClick={() => set(i.id, "rejected")}>Reject</button>
              <button className="btn" onClick={() => { setScripts((s) => [...s, { id: crypto.randomUUID(), title: i.title, hook: "", outline: "", body: "", cta: "" }]); setMsg(`Script draft created for "${i.title}".`); }}>Start script</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-6"><NextStep title="AI research assistant">Once a cloud backend and AI model are connected, this queue can suggest ideas from trends. For now, ideas are entered manually.</NextStep></div>
    </>
  );
}
