import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";
import { useStudio } from "@/lib/studio-store";
import { useIntegrations } from "@/lib/use-integrations";
import { getAnalytics, getRetention } from "@/lib/youtube.functions";

export const Route = createFileRoute("/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — Tony AI YouTube Studio" },
      {
        name: "description",
        content: "Real views, watch time and retention from your connected YouTube channel.",
      },
    ],
  }),
  component: Analytics,
});

const msgOf = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function Line({ values, label, max }: { values: number[]; label: string; max?: number }) {
  const top = max ?? Math.max(1, ...values);
  const w = 600;
  const h = 120;
  const pts = values
    .map(
      (v, i) =>
        `${values.length < 2 ? 0 : (i / (values.length - 1)) * w},${h - (v / top) * (h - 6) - 3}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-32 w-full"
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Analytics() {
  const { mode, videos } = useStudio();
  const integ = useIntegrations();
  const connected = mode === "db" && !!integ.data?.youtube.connected;
  const [days, setDays] = useState<7 | 28 | 90>(28);
  const [videoId, setVideoId] = useState("");
  const uploaded = videos.filter((v) => v.youtubeVideoId);

  const data = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => getAnalytics({ data: { days } }),
    enabled: connected,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const retention = useQuery({
    queryKey: ["retention", videoId],
    queryFn: () => getRetention({ data: { videoId } }),
    enabled: connected && !!videoId,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const t = data.data?.totals;
  const tiles = [
    { k: "Views", v: t ? t.views.toLocaleString() : "—", d: `Last ${days} days` },
    { k: "Watch time", v: t ? `${(t.minutesWatched / 60).toFixed(1)} h` : "—", d: "Hours watched" },
    { k: "Avg. view duration", v: t ? mmss(t.avgViewDurationSec) : "—", d: "Per view" },
    {
      k: "Avg. % viewed",
      v: t ? `${t.avgViewPercentage.toFixed(0)}%` : "—",
      d: "Average percentage viewed",
    },
  ];

  return (
    <>
      <PageHeader
        title="Analytics"
        desc={
          connected
            ? "Real data from your connected YouTube channel. YouTube reports with a delay of a day or two."
            : "No data yet. Real numbers appear only after the YouTube channel is connected."
        }
      >
        {connected && (
          <label className="text-sm">
            <span className="sr-only">Date range</span>
            <select
              className="field w-auto"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as 7 | 28 | 90)}
            >
              <option value={7}>Last 7 days</option>
              <option value={28}>Last 28 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
        )}
      </PageHeader>

      {data.isError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {msgOf(data.error)}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((m) => (
          <div key={m.k} className="panel p-4">
            <div className="text-xs text-muted-foreground">{m.k}</div>
            <div
              className={`mt-1 font-display text-3xl font-semibold ${t ? "" : "text-muted-foreground"}`}
            >
              {m.v}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{m.d}</p>
            <div className="mt-2">
              {t ? <Badge tone="ok">From YouTube</Badge> : <Badge>No data</Badge>}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Impressions click-through rate is not shown: it is not requested from the API here. Find it
        in YouTube Studio.
      </p>

      {connected && (
        <>
          <section className="panel mt-6 p-5">
            <h2 className="mb-3 font-semibold">Views per day</h2>
            {data.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
            {data.data && data.data.daily.length === 0 && (
              <p className="text-sm text-muted-foreground">
                YouTube has no data for this range yet.
              </p>
            )}
            {data.data && data.data.daily.length > 0 && (
              <Line values={data.data.daily.map((d) => d.views)} label="Views per day" />
            )}
            {t && (
              <p className="mt-2 text-xs text-muted-foreground">
                Subscribers gained: {t.subscribersGained.toLocaleString()}
              </p>
            )}
          </section>

          <section className="panel mt-6 p-5">
            <h2 className="mb-3 font-semibold">Top videos</h2>
            {data.data?.topVideos.length === 0 && (
              <p className="text-sm text-muted-foreground">No video data yet.</p>
            )}
            <ul className="divide-y text-sm">
              {data.data?.topVideos.map((v) => (
                <li key={v.videoId} className="flex justify-between gap-3 py-2">
                  <span className="truncate">{v.title}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {v.views.toLocaleString()} views
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel mt-6 p-5">
            <h2 className="mb-3 font-semibold">Audience retention</h2>
            {uploaded.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Upload a video from the Publishing page to see its retention curve.
              </p>
            ) : (
              <>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block font-medium">Video</span>
                  <select
                    className="field w-auto max-w-full"
                    value={videoId}
                    onChange={(e) => setVideoId(e.target.value)}
                  >
                    <option value="">Choose a video…</option>
                    {uploaded.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.title}
                      </option>
                    ))}
                  </select>
                </label>
                {retention.isPending && videoId && (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                )}
                {retention.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    {msgOf(retention.error)}
                  </p>
                )}
                {retention.data && retention.data.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    YouTube has no retention data for this video yet.
                  </p>
                )}
                {retention.data && retention.data.length > 0 && (
                  <>
                    <Line
                      values={retention.data.map((p) => p.watch)}
                      label="Audience retention"
                      max={Math.max(1, ...retention.data.map((p) => p.watch))}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Share of the audience still watching, from start to end of the video.
                    </p>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}

      {!connected && (
        <div className="mt-6">
          <NextStep title="YouTube Analytics API">
            {mode === "demo"
              ? "Analytics needs the database and a connected channel."
              : "Connect your channel on the YouTube channel page to see real views, watch time and retention."}
          </NextStep>
        </div>
      )}
    </>
  );
}
