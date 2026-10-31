import { createFileRoute } from "@tanstack/react-router";
import { useStudio, STAGES, type Stage } from "@/lib/studio-store";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/pipeline")({
  head: () => ({
    meta: [
      { title: "Production pipeline — Tony AI YouTube Studio" },
      { name: "description", content: "Track script, voiceover, visuals, captions, thumbnail and QA." },
      { property: "og:title", content: "Production pipeline — Tony AI YouTube Studio" },
      { property: "og:description", content: "Track script, voiceover, visuals, captions, thumbnail and QA." },
    ],
  }),
  component: Pipeline,
});

function Pipeline() {
  const { videos, setVideos } = useStudio();
  const toggle = (id: string, st: Stage) => setVideos((vs) => vs.map((v) => {
    if (v.id !== id) return v;
    const done = v.done.includes(st) ? v.done.filter((d) => d !== st) : [...v.done, st];
    const next = STAGES.find((s) => !done.includes(s.key))?.key ?? "quality";
    return { ...v, done, stage: next };
  }));
  const submit = (id: string) => setVideos((vs) => vs.map((v) => (v.id === id ? { ...v, approval: "pending" } : v)));
  return (
    <>
      <PageHeader title="Video production pipeline" desc="Mark stages complete manually. No rendering, voice or image services are connected." />
      <div className="space-y-4">
        {videos.map((v) => {
          const ready = v.done.length === STAGES.length;
          return (
            <section key={v.id} className="panel p-4" aria-label={v.title}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{v.title}</h2>
                <Badge tone={v.approval === "pending" ? "demo" : v.approval === "approved" ? "ok" : "off"}>{v.approval}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {STAGES.map((s) => {
                  const done = v.done.includes(s.key);
                  return (
                    <button key={s.key} onClick={() => toggle(v.id, s.key)} aria-pressed={done}
                      className={`rounded-md border p-2 text-left text-xs ${done ? "border-primary/40 bg-primary/10 text-primary" : "bg-background/50 text-muted-foreground hover:border-primary/40"}`}>
                      <div className="font-medium">{s.label}</div><div>{done ? "Done" : "To do"}</div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex justify-end">
                <button className="btn btn-primary" disabled={!ready || v.approval !== "draft"} onClick={() => submit(v.id)}>
                  {v.approval === "draft" ? (ready ? "Send to approval queue" : "Complete all stages first") : "In approval flow"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <NextStep title="AI voiceover">Connect a text-to-speech provider to generate narration files from approved scripts.</NextStep>
        <NextStep title="Visuals & captions">Connect stock/AI visual and caption services through the cloud backend.</NextStep>
      </div>
    </>
  );
}
