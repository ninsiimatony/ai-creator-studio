import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useStudio, STAGES } from "@/lib/studio-store";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/pipeline")({
  head: () => ({
    meta: [
      { title: "Production pipeline — Tony AI YouTube Studio" },
      {
        name: "description",
        content: "Track script, voiceover, visuals, captions, thumbnail and QA.",
      },
      { property: "og:title", content: "Production pipeline — Tony AI YouTube Studio" },
      {
        property: "og:description",
        content: "Track script, voiceover, visuals, captions, thumbnail and QA.",
      },
    ],
  }),
  component: Pipeline,
});

function Pipeline() {
  const { videos, toggleStage, submitVideo, createVideo } = useStudio();
  const [title, setTitle] = useState("");
  return (
    <>
      <PageHeader
        title="Video production pipeline"
        desc="Mark stages complete manually. No rendering, voice or image services are connected."
      />
      <form
        className="panel mb-6 grid gap-3 p-4 sm:grid-cols-[1fr_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          if (await createVideo({ title: title.trim() })) setTitle("");
        }}
      >
        <label className="sr-only" htmlFor="nv">
          New video title
        </label>
        <input
          id="nv"
          className="field"
          placeholder="Start a new video, e.g. 'Why AI hallucinates'"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button className="btn btn-primary" type="submit">
          Add video
        </button>
      </form>
      {videos.length === 0 && (
        <p className="panel mb-6 p-6 text-sm text-muted-foreground">
          No videos in production yet. Add one above, or use “Send to production” in the Script
          editor.
        </p>
      )}
      <div className="space-y-4">
        {videos.map((v) => {
          const ready = v.done.length === STAGES.length;
          const locked = v.approval === "pending" || v.approval === "approved";
          return (
            <section key={v.id} className="panel p-4" aria-label={v.title}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{v.title}</h2>
                <Badge
                  tone={
                    v.approval === "pending" ? "demo" : v.approval === "approved" ? "ok" : "off"
                  }
                >
                  {v.approval}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {STAGES.map((s) => {
                  const done = v.done.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      onClick={() => void toggleStage(v.id, s.key)}
                      disabled={locked}
                      aria-pressed={done}
                      className={`rounded-md border p-2 text-left text-xs ${done ? "border-primary/40 bg-primary/10 text-primary" : "bg-background/50 text-muted-foreground hover:border-primary/40"}`}
                    >
                      <div className="font-medium">{s.label}</div>
                      <div>{done ? "Done" : "To do"}</div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  className="btn btn-primary"
                  disabled={!ready || v.approval !== "draft"}
                  onClick={() => void submitVideo(v.id)}
                >
                  {v.approval === "draft"
                    ? ready
                      ? "Send to approval queue"
                      : "Complete all stages first"
                    : "In approval flow"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <NextStep title="AI voiceover">
          Connect a text-to-speech provider to generate narration files from approved scripts.
        </NextStep>
        <NextStep title="Visuals & captions">
          Connect stock/AI visual and caption services (a later phase).
        </NextStep>
      </div>
    </>
  );
}
