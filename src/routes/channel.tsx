import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, PageHeader } from "@/components/ui-bits";
import { useStudio } from "@/lib/studio-store";
import { useIntegrations } from "@/lib/use-integrations";
import { disconnectYoutube, getChannelStats, startGoogleConnect } from "@/lib/youtube.functions";

export const Route = createFileRoute("/channel")({
  head: () => ({
    meta: [
      { title: "YouTube channel connection — Tony AI YouTube Studio" },
      { name: "description", content: "How the channel will connect securely via Google OAuth." },
      { property: "og:title", content: "YouTube channel connection — Tony AI YouTube Studio" },
      {
        property: "og:description",
        content: "How the channel will connect securely via Google OAuth.",
      },
    ],
  }),
  component: Channel,
});

const steps = [
  "Tony clicks “Connect with Google” and is sent to Google's own sign-in page.",
  "Google shows exactly which YouTube permissions are requested; Tony approves or declines.",
  "Google returns a revocable token to the secure backend — never to this page. It is stored encrypted.",
  "Access can be revoked anytime here or at myaccount.google.com/permissions.",
];

const msgOf = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const fmt = (n: number | null) => (n === null ? "Hidden" : n.toLocaleString());

function Channel() {
  const { mode } = useStudio();
  const qc = useQueryClient();
  const integ = useIntegrations();
  const yt = integ.data?.youtube;
  const [flash, setFlash] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");

  // Read the result Google's callback left in the URL, then clean it.
  useEffect(() => {
    setOrigin(window.location.origin);
    const q = new URLSearchParams(window.location.search);
    const r = q.get("youtube");
    if (r === "connected") setFlash({ tone: "ok", text: "YouTube channel connected." });
    else if (r === "denied")
      setFlash({ tone: "bad", text: "Permission was declined, so nothing was connected." });
    else if (r === "error")
      setFlash({ tone: "bad", text: q.get("reason") ?? "Could not connect YouTube." });
    if (r) {
      window.history.replaceState(null, "", window.location.pathname);
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    }
  }, [qc]);

  const stats = useQuery({
    queryKey: ["channel-stats"],
    queryFn: () => getChannelStats(),
    enabled: mode === "db" && !!yt?.connected,
    retry: false,
    staleTime: 60_000,
  });

  async function connect() {
    setBusy(true);
    setFlash(null);
    try {
      const { url } = await startGoogleConnect();
      window.location.href = url;
    } catch (e) {
      setFlash({ tone: "bad", text: msgOf(e) });
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!window.confirm("Disconnect this YouTube channel? You can reconnect later.")) return;
    setBusy(true);
    try {
      await disconnectYoutube();
      await qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.removeQueries({ queryKey: ["channel-stats"] });
      setFlash({ tone: "ok", text: "Disconnected. The stored token was deleted." });
    } catch (e) {
      setFlash({ tone: "bad", text: msgOf(e) });
    } finally {
      setBusy(false);
    }
  }

  const state =
    mode === "demo"
      ? "demo"
      : !yt
        ? "loading"
        : yt.connected
          ? "connected"
          : yt.configured
            ? "ready"
            : "unconfigured";

  return (
    <>
      <PageHeader
        title="YouTube channel"
        desc={
          state === "connected"
            ? "Connected through Google OAuth. This app never sees your Google password."
            : "This app will never ask for your Google password."
        }
      />
      {flash && (
        <p
          role={flash.tone === "bad" ? "alert" : "status"}
          className={`mb-4 text-sm ${flash.tone === "bad" ? "text-destructive" : "text-primary"}`}
        >
          {flash.text}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Connection</h2>
            {state === "connected" ? (
              <Badge tone="ok">Connected</Badge>
            ) : (
              <Badge>Not connected</Badge>
            )}
          </div>

          {state === "connected" && (
            <div className="mb-4 space-y-2 text-sm">
              <div className="font-medium">{yt?.channelTitle}</div>
              {stats.isPending && <p className="text-muted-foreground">Loading channel details…</p>}
              {stats.isError && (
                <p role="alert" className="text-destructive">
                  {msgOf(stats.error)}
                </p>
              )}
              {stats.data && (
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ["Subscribers", fmt(stats.data.subscribers)],
                    ["Views", fmt(stats.data.views)],
                    ["Videos", fmt(stats.data.videos)],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-md border p-2">
                      <dt className="text-xs text-muted-foreground">{k}</dt>
                      <dd className="font-display text-lg font-semibold">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}

          <h3 className="mb-2 text-sm font-medium">How secure Google OAuth works</h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <h3 className="mb-2 mt-5 text-sm font-medium">Permissions requested</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>• Read channel details and analytics (views, watch time, retention)</li>
            <li>
              • Upload videos — <strong className="text-foreground">private by default</strong>, and
              only after Tony approves each one
            </li>
          </ul>

          {state === "connected" ? (
            <button className="btn mt-5 w-full" disabled={busy} onClick={() => void disconnect()}>
              Disconnect channel
            </button>
          ) : (
            <button
              className="btn btn-primary mt-5 w-full"
              disabled={busy || state !== "ready"}
              onClick={() => void connect()}
            >
              {state === "demo"
                ? "Connect with Google (needs the database)"
                : state === "unconfigured"
                  ? "Connect with Google (credentials not added yet)"
                  : state === "loading"
                    ? "Checking…"
                    : busy
                      ? "Opening Google…"
                      : "Connect with Google"}
            </button>
          )}
        </section>

        <section className="panel space-y-3 p-5 text-sm">
          <h2 className="font-semibold">One-time Google setup</h2>
          <p className="text-muted-foreground">
            Required once, by you, in Google Cloud Console (free). Never paste secrets into this
            page — add them as server secrets.
          </p>
          <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
            <li>
              Create a Google Cloud project and enable the YouTube Data API v3 and the YouTube
              Analytics API.
            </li>
            <li>
              Configure the OAuth consent screen (External). Publish it to <em>In production</em> —
              in <em>Testing</em> mode Google expires the connection every 7 days.
            </li>
            <li>Create an OAuth client of type “Web application”.</li>
            <li>
              Add this authorised redirect URI:
              <code className="mt-1 block break-all rounded bg-secondary px-2 py-1 font-mono text-xs text-foreground">
                {origin || "https://your-site"}/api/auth/google/callback
              </code>
            </li>
            <li>
              Add the secrets <code className="font-mono">GOOGLE_CLIENT_ID</code>,{" "}
              <code className="font-mono">GOOGLE_CLIENT_SECRET</code> and{" "}
              <code className="font-mono">TOKEN_ENC_KEY</code> (base64 of 32 random bytes) to the
              server.
            </li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Note: Google may restrict videos uploaded by an app that has not passed Google's API
            audit to private visibility. Tony can still publish them from YouTube Studio.
          </p>
          {yt && (
            <p className="text-xs text-muted-foreground">
              Server credentials: {yt.configured ? "present" : "missing"}.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
