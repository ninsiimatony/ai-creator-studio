import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useStudio } from "@/lib/studio-store";
import { PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Tony AI YouTube Studio" },
      { name: "description", content: "Audience, format, approval, timezone and budget settings." },
      { property: "og:title", content: "Settings — Tony AI YouTube Studio" },
      { property: "og:description", content: "Audience, format, approval, timezone and budget settings." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { settings, setSettings } = useStudio();
  const [s, setS] = useState(settings);
  const [saved, setSaved] = useState(false);
  return (
    <>
      <PageHeader title="Settings" desc="Saved for this browser session only (demo). No money is spent — budget caps apply once paid services are connected." />
      <form className="panel max-w-2xl space-y-5 p-5" onSubmit={(e) => { e.preventDefault(); setSettings(s); setSaved(true); }}>
        <L label="Target audience"><input className="field" value={s.audience} onChange={(e) => { setS({ ...s, audience: e.target.value }); setSaved(false); }} /></L>
        <L label="Preferred format">
          <select className="field" value={s.format} onChange={(e) => { setS({ ...s, format: e.target.value }); setSaved(false); }}>
            <option>Faceless documentary / explainer with AI narration</option>
            <option>Short-form (Shorts) explainer</option>
          </select>
        </L>
        <L label="Timezone">
          <select className="field" value={s.timezone} onChange={(e) => { setS({ ...s, timezone: e.target.value }); setSaved(false); }}>
            {["Asia/Muscat", "Asia/Dubai", "UTC", "Europe/London", "America/New_York"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </L>
        <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
          <L label="Daily budget cap"><input type="number" min={0} step="0.01" className="field" value={s.budgetCap} onChange={(e) => { setS({ ...s, budgetCap: Number(e.target.value) }); setSaved(false); }} /></L>
          <L label="Currency"><select className="field" value={s.currency} onChange={(e) => { setS({ ...s, currency: e.target.value }); setSaved(false); }}>{["USD", "OMR", "EUR"].map((c) => <option key={c}>{c}</option>)}</select></L>
        </div>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={s.approvalRequired} onChange={(e) => { setS({ ...s, approvalRequired: e.target.checked }); setSaved(false); }} />
          <span><span className="font-medium">Publishing approval required</span><br /><span className="text-muted-foreground">Every video needs Tony's explicit approval. Strongly recommended to keep on.</span></span>
        </label>
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" type="submit">Save settings</button>
          {saved && <span role="status" className="text-sm text-primary">Saved for this session.</span>}
        </div>
      </form>
    </>
  );
}
function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block font-medium">{label}</span>{children}</label>;
}
