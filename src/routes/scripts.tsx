import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useStudio, type Script } from "@/lib/studio-store";
import { NextStep, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/scripts")({
  head: () => ({
    meta: [
      { title: "Script editor — Tony AI YouTube Studio" },
      { name: "description", content: "Write hooks, outlines, narration and calls to action." },
      { property: "og:title", content: "Script editor — Tony AI YouTube Studio" },
      { property: "og:description", content: "Write hooks, outlines, narration and calls to action." },
    ],
  }),
  component: Scripts,
});

function Scripts() {
  const { scripts, setScripts } = useStudio();
  const [sel, setSel] = useState(scripts[0]?.id);
  const s = scripts.find((x) => x.id === sel) ?? scripts[0];
  const upd = (k: keyof Script, v: string) => setScripts((ss) => ss.map((x) => (x.id === s?.id ? { ...x, [k]: v } : x)));
  const words = s ? s.body.trim().split(/\s+/).filter(Boolean).length : 0;
  return (
    <>
      <PageHeader title="Script editor" desc="Changes are kept in this browser session only (demo)." />
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <div>
          <label htmlFor="sel" className="mb-1 block text-xs text-muted-foreground">Script</label>
          <select id="sel" className="field lg:hidden" value={s?.id} onChange={(e) => setSel(e.target.value)}>
            {scripts.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
          <ul className="hidden space-y-1 lg:block">
            {scripts.map((x) => (
              <li key={x.id}><button onClick={() => setSel(x.id)} aria-current={x.id === s?.id}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${x.id === s?.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-secondary"}`}>{x.title}</button></li>
            ))}
          </ul>
        </div>
        {s && (
          <div className="panel space-y-4 p-5">
            <F label="Title"><input className="field" value={s.title} onChange={(e) => upd("title", e.target.value)} /></F>
            <F label="Hook (first 10 seconds)"><textarea rows={2} className="field" value={s.hook} onChange={(e) => upd("hook", e.target.value)} /></F>
            <F label="Outline"><textarea rows={6} className="field font-mono" value={s.outline} onChange={(e) => upd("outline", e.target.value)} /></F>
            <F label={`Narration (${words} words · ~${Math.max(1, Math.round(words / 150))} min)`}><textarea rows={8} className="field" value={s.body} onChange={(e) => upd("body", e.target.value)} /></F>
            <F label="Call to action"><textarea rows={2} className="field" value={s.cta} onChange={(e) => upd("cta", e.target.value)} /></F>
            <button className="btn" disabled title="Requires an AI model connection">Generate draft with AI (not connected)</button>
          </div>
        )}
      </div>
      <div className="mt-6"><NextStep title="AI script generation">A future backend can draft scripts from shortlisted ideas. Drafts will always land here for human review.</NextStep></div>
    </>
  );
}
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block font-medium">{label}</span>{children}</label>;
}
