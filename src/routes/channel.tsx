import { createFileRoute } from "@tanstack/react-router";
import { Badge, NextStep, PageHeader } from "@/components/ui-bits";

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
  "Google returns a revocable access token to the secure backend — never to this page.",
  "Access can be revoked anytime from myaccount.google.com/permissions.",
];

function Channel() {
  return (
    <>
      <PageHeader
        title="YouTube channel"
        desc="The channel is not connected. This app will never ask for your Google password."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Connection</h2>
            <Badge>Not connected</Badge>
          </div>
          <h3 className="mb-2 text-sm font-medium">How secure Google OAuth works</h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <h3 className="mb-2 mt-5 text-sm font-medium">Planned permissions</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li>• Read channel analytics (views, watch time, retention, CTR)</li>
            <li>
              • Upload videos as <strong className="text-foreground">private drafts</strong> only
              after Tony approves
            </li>
          </ul>
          <button className="btn mt-5 w-full" disabled>
            Connect with Google (available after backend setup)
          </button>
        </section>
        <section className="space-y-3">
          <NextStep title="1. Cloud automation backend">
            Stores scripts, assets and approval records, and holds OAuth tokens securely
            server-side.
          </NextStep>
          <NextStep title="2. Google Cloud project + OAuth consent">
            Create OAuth credentials for the YouTube Data API v3 and YouTube Analytics API.
          </NextStep>
          <NextStep title="3. YouTube Data API">
            Enable uploads (private by default) and metadata updates, gated by the approval queue.
          </NextStep>
          <NextStep title="4. YouTube Analytics API">
            Replace analytics placeholders with real channel data.
          </NextStep>
        </section>
      </div>
    </>
  );
}
