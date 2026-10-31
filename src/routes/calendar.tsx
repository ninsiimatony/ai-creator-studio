import { createFileRoute } from "@tanstack/react-router";
import { useStudio } from "@/lib/studio-store";
import { Badge, PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/calendar")({
  head: () => ({
    meta: [
      { title: "Content calendar — Tony AI YouTube Studio" },
      { name: "description", content: "Planned release dates for upcoming videos." },
      { property: "og:title", content: "Content calendar — Tony AI YouTube Studio" },
      { property: "og:description", content: "Planned release dates for upcoming videos." },
    ],
  }),
  component: Calendar,
});

function Calendar() {
  const { videos, setVideos, settings } = useStudio();
  const year = 2026, month = 10; // November
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: first + days }, (_, i) => (i < first ? null : i - first + 1));
  const key = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;
  return (
    <>
      <PageHeader title="Content calendar" desc={`November 2026 · Target dates in ${settings.timezone}. Dates are plans only — nothing is auto-published.`} />
      <div className="panel hidden p-3 md:block">
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} className="py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => (
            <div key={i} className="min-h-24 rounded-md bg-background/50 p-1.5 text-xs">
              {d && <div className="text-muted-foreground">{d}</div>}
              {d && videos.filter((v) => v.scheduled === key(d)).map((v) => (
                <div key={v.id} className="mt-1 rounded bg-accent p-1 text-accent-foreground">{v.title}</div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <h2 className="mb-3 mt-6 font-semibold">Schedule</h2>
      <ul className="space-y-2">
        {[...videos].sort((a, b) => a.scheduled.localeCompare(b.scheduled)).map((v) => (
          <li key={v.id} className="panel flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-medium">{v.title} <Badge tone={v.approval === "approved" ? "ok" : "off"}>{v.approval}</Badge></div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Target date
              <input type="date" className="field w-auto" value={v.scheduled}
                onChange={(e) => setVideos((vs) => vs.map((x) => (x.id === v.id ? { ...x, scheduled: e.target.value } : x)))} />
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}
