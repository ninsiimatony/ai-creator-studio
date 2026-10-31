import { createFileRoute } from "@tanstack/react-router";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — Tony AI YouTube Studio" },
      {
        name: "description",
        content: "Views, watch time, retention and CTR once the channel is connected.",
      },
      { property: "og:title", content: "Analytics — Tony AI YouTube Studio" },
      {
        property: "og:description",
        content: "Views, watch time, retention and CTR once the channel is connected.",
      },
    ],
  }),
  component: Analytics,
});

const metrics = [
  { k: "Views", d: "Total views in the last 28 days" },
  { k: "Watch time", d: "Hours watched in the last 28 days" },
  { k: "Avg. retention", d: "Average percentage viewed" },
  { k: "Impressions CTR", d: "Click-through rate from thumbnails" },
];

function Analytics() {
  return (
    <>
      <PageHeader
        title="Analytics"
        desc="No data yet. Real numbers appear only after the YouTube channel is connected."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.k} className="panel p-4">
            <div className="text-xs text-muted-foreground">{m.k}</div>
            <div className="mt-1 font-display text-3xl font-semibold text-muted-foreground">—</div>
            <p className="mt-1 text-xs text-muted-foreground">{m.d}</p>
            <div className="mt-2">
              <Badge>No data</Badge>
            </div>
          </div>
        ))}
      </div>
      <section className="panel mt-6 p-5">
        <h2 className="mb-3 font-semibold">Audience retention</h2>
        <div className="grid h-48 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
          Chart placeholder — awaiting YouTube Analytics API
        </div>
      </section>
      <div className="mt-6">
        <NextStep title="YouTube Analytics API">
          Connect the channel to pull real views, watch time, retention and CTR per video.
        </NextStep>
      </div>
    </>
  );
}
