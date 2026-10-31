import { createFileRoute, Link } from "@tanstack/react-router";
import { useStudio, STAGES } from "@/lib/studio-store";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — Tony AI YouTube Studio" },
      {
        name: "description",
        content: "Dashboard for Tony's AI, robotics and future-tech YouTube channel.",
      },
      { property: "og:title", content: "Overview — Tony AI YouTube Studio" },
      {
        property: "og:description",
        content: "Dashboard for Tony's AI, robotics and future-tech YouTube channel.",
      },
    ],
  }),
  component: Overview,
});

function Overview() {
  const { ideas, videos, settings, mode, loadSampleData } = useStudio();
  const demo = mode === "demo";
  const empty = ideas.length === 0 && videos.length === 0;
  const pending = videos.filter((v) => v.approval === "pending").length;
  const stats = [
    {
      label: "Ideas in queue",
      value: ideas.filter((i) => i.status !== "rejected").length,
      to: "/ideas",
    },
    { label: "In production", value: videos.length, to: "/pipeline" },
    { label: "Awaiting Tony's approval", value: pending, to: "/approvals" },
    { label: "Published", value: 0, to: "/analytics" },
  ] as const;
  return (
    <>
      <PageHeader
        title="Overview"
        desc="Faceless documentary & explainer videos on AI, robotics and the future — for a worldwide audience."
      />
      {!demo && empty && (
        <div className="panel mb-6 p-5">
          <h2 className="font-semibold">Your workspace is empty</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add your first idea, or load the original sample content to explore the app. Sample data
            is clearly sample — it can only be loaded into an empty workspace.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to="/ideas" className="btn btn-primary">
              Add an idea
            </Link>
            <button className="btn" onClick={() => void loadSampleData()}>
              Load sample data
            </button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} to={s.to} className="panel p-4 hover:border-primary/50">
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="mt-1 font-display text-3xl font-semibold">{s.value}</div>
            {demo && (
              <div className="mt-1">
                <Badge tone="demo">Demo</Badge>
              </div>
            )}
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="panel p-5 lg:col-span-2" aria-labelledby="up">
          <h2 id="up" className="mb-4 font-semibold">
            Upcoming videos
          </h2>
          {videos.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No videos yet. Start one from the Production page.
            </p>
          )}
          <ul className="divide-y">
            {videos.map((v) => (
              <li
                key={v.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="text-sm font-medium">{v.title}</div>
                  <div className="text-xs text-muted-foreground">
                    Target {v.scheduled || "not set"} · Stage:{" "}
                    {STAGES.find((s) => s.key === v.stage)?.label}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <div className="flex gap-0.5" aria-label={`${v.done.length} of 6 stages done`}>
                    {STAGES.map((s) => (
                      <span
                        key={s.key}
                        className={`h-1.5 w-5 rounded-full ${v.done.includes(s.key) ? "bg-primary" : "bg-muted"}`}
                      />
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-3" aria-labelledby="sys">
          <h2 id="sys" className="font-semibold">
            System status
          </h2>
          <div className="panel space-y-2 p-4 text-sm">
            <Row
              k="Database"
              v={
                demo ? (
                  <Badge tone="demo">Demo (not saved)</Badge>
                ) : (
                  <Badge tone="ok">Connected</Badge>
                )
              }
            />
            <Row k="YouTube channel" v={<Badge>Not connected</Badge>} />
            <Row k="Cloud automation" v={<Badge>Not connected</Badge>} />
            <Row k="AI narration" v={<Badge>Not connected</Badge>} />
            <Row
              k="Publishing approval"
              v={
                <Badge tone={settings.approvalRequired ? "ok" : "bad"}>
                  {settings.approvalRequired ? "Required" : "Off"}
                </Badge>
              }
            />
            <Row k="Unattended automation" v={<Badge>Inactive</Badge>} />
          </div>
          <NextStep title="Next step">
            Connect a cloud backend to save work and run scheduled drafting jobs — still gated by
            Tony's approval.
          </NextStep>
        </section>
      </div>
    </>
  );
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      {v}
    </div>
  );
}
