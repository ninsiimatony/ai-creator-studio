import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useStudio } from "@/lib/studio-store";
import { Badge, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/approvals")({
  head: () => ({
    meta: [
      { title: "Approval queue — Tony AI YouTube Studio" },
      {
        name: "description",
        content: "Tony reviews and explicitly approves every video before publishing.",
      },
      { property: "og:title", content: "Approval queue — Tony AI YouTube Studio" },
      {
        property: "og:description",
        content: "Tony reviews and explicitly approves every video before publishing.",
      },
    ],
  }),
  component: Approvals,
});

function Approvals() {
  const { videos, setVideos } = useStudio();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<Record<string, boolean>>({});
  const list = videos.filter((v) => v.approval !== "draft");
  const act = (id: string, approval: "approved" | "changes") =>
    setVideos((vs) =>
      vs.map((v) =>
        v.id === id
          ? { ...v, approval, note: notes[id], ...(approval === "changes" ? {} : {}) }
          : v,
      ),
    );
  return (
    <>
      <PageHeader
        title="Approval queue"
        desc="Nothing is published without Tony's explicit approval. Approving here marks a video as ready — publishing is not connected."
      />
      {list.length === 0 && (
        <p className="panel p-6 text-sm text-muted-foreground">
          No videos awaiting review. Send one from the production pipeline.
        </p>
      )}
      <ul className="space-y-4">
        {list.map((v) => (
          <li key={v.id} className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">{v.title}</h2>
              <Badge
                tone={v.approval === "approved" ? "ok" : v.approval === "changes" ? "bad" : "demo"}
              >
                {v.approval === "pending"
                  ? "Awaiting Tony"
                  : v.approval === "approved"
                    ? "Approved by Tony — not published"
                    : "Changes requested"}
              </Badge>
            </div>
            <div className="mt-3 grid aspect-video max-w-md place-items-center rounded-md border border-dashed text-xs text-muted-foreground">
              Draft preview unavailable (demo)
            </div>
            {v.approval === "pending" && (
              <div className="mt-4 space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block">Review notes</span>
                  <textarea
                    rows={2}
                    className="field"
                    value={notes[v.id] ?? ""}
                    onChange={(e) => setNotes({ ...notes, [v.id]: e.target.value })}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={!!confirm[v.id]}
                    onChange={(e) => setConfirm({ ...confirm, [v.id]: e.target.checked })}
                  />
                  I, Tony, have reviewed the script, voiceover, visuals and thumbnail.
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-primary"
                    disabled={!confirm[v.id]}
                    onClick={() => act(v.id, "approved")}
                  >
                    Approve
                  </button>
                  <button className="btn" onClick={() => act(v.id, "changes")}>
                    Request changes
                  </button>
                </div>
              </div>
            )}
            {v.note && <p className="mt-3 text-sm text-muted-foreground">Note: {v.note}</p>}
            {v.approval === "changes" && (
              <button
                className="btn mt-3"
                onClick={() =>
                  setVideos((vs) =>
                    vs.map((x) => (x.id === v.id ? { ...x, approval: "draft" } : x)),
                  )
                }
              >
                Return to production
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
