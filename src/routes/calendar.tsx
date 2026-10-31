import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function Calendar() {
  const { videos, setScheduled, settings } = useStudio();
  const [cursor, setCursor] = useState(() => {
    const t = new Date();
    return { year: t.getFullYear(), month: t.getMonth() };
  });
  const { year, month } = cursor;
  const shift = (delta: number) =>
    setCursor(({ year: y, month: m }) => {
      const d = new Date(y, m + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: first + days }, (_, i) => (i < first ? null : i - first + 1));
  const key = (d: number) =>
    `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return (
    <>
      <PageHeader
        title="Content calendar"
        desc={`${MONTHS[month]} ${year} · Target dates in ${settings.timezone}. Dates are plans only — nothing is auto-published.`}
      >
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => shift(-1)} aria-label="Previous month">
            ←
          </button>
          <button
            className="btn"
            onClick={() => {
              const t = new Date();
              setCursor({ year: t.getFullYear(), month: t.getMonth() });
            }}
          >
            Today
          </button>
          <button className="btn" onClick={() => shift(1)} aria-label="Next month">
            →
          </button>
        </div>
      </PageHeader>
      <div className="panel hidden p-3 md:block">
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => (
            <div key={i} className="min-h-24 rounded-md bg-background/50 p-1.5 text-xs">
              {d && <div className="text-muted-foreground">{d}</div>}
              {d &&
                videos
                  .filter((v) => v.scheduled === key(d))
                  .map((v) => (
                    <div key={v.id} className="mt-1 rounded bg-accent p-1 text-accent-foreground">
                      {v.title}
                    </div>
                  ))}
            </div>
          ))}
        </div>
      </div>
      <h2 className="mb-3 mt-6 font-semibold">Schedule</h2>
      {videos.length === 0 && (
        <p className="panel p-6 text-sm text-muted-foreground">
          No videos yet. Add one from the Production page, then set its target date here.
        </p>
      )}
      <ul className="space-y-2">
        {[...videos]
          .sort((a, b) => a.scheduled.localeCompare(b.scheduled))
          .map((v) => (
            <li
              key={v.id}
              className="panel flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="text-sm font-medium">
                {v.title}{" "}
                <Badge tone={v.approval === "approved" ? "ok" : "off"}>{v.approval}</Badge>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Target date
                <input
                  type="date"
                  className="field w-auto"
                  value={v.scheduled}
                  onChange={(e) => void setScheduled(v.id, e.target.value)}
                />
              </label>
            </li>
          ))}
      </ul>
    </>
  );
}
