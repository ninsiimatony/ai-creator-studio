import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui-bits";

export const Route = createFileRoute("/go-public")({
  head: () => ({ meta: [{ title: "Make videos public — Tony AI YouTube Studio" }] }),
  component: GoPublic,
});

type V = { id: string; title: string; thumb: string; minutes: number; when: string };
type Ch = { ok: boolean; error?: string; channelTitle?: string; videos?: V[] };
const NAMES: Record<string, string> = { "1": "Main channel (Tony Ninsiima)", "2": "Little Hope Tales" };

function GoPublic() {
  const [data, setData] = useState<Record<string, Ch> | null>(null);
  const [err, setErr] = useState("");
  const [armed, setArmed] = useState("");
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<string[]>([]);

  async function load() {
    setErr("");
    try {
      const r = await fetch("/api/publish/list");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load.");
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function go(channel: string, id: string) {
    const key = channel + ":" + id;
    if (armed !== key) {
      setArmed(key);
      return;
    }
    setBusy(key);
    try {
      const r = await fetch("/api/publish/go", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: Number(channel), id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed.");
      setDone((d) => [...d, id]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy("");
      setArmed("");
    }
  }

  return (
    <>
      <PageHeader title="Make videos public" desc="Your private videos from both channels. Tap Make public, then tap again to confirm." />
      {err && <p className="panel mb-4 p-4 text-sm text-red-400">{err}</p>}
      {!data && !err && <p className="panel p-4 text-sm">Loading…</p>}
      {data &&
        ["1", "2"].map((ch) => {
          const c = data[ch];
          return (
            <section key={ch} className="panel mb-6 p-4">
              <h2 className="mb-1 text-lg font-semibold">{NAMES[ch]}</h2>
              {!c?.ok && (
                <div className="text-sm">
                  <p className="mb-2 text-red-400">{c?.error ?? "Not available."}</p>
                  <a className="underline" href={ch === "1" ? "/channel" : "/api/auth/google2/start"}>
                    Reconnect this channel
                  </a>
                </div>
              )}
              {c?.ok && c.videos?.filter((v) => !done.includes(v.id)).length === 0 && (
                <p className="text-sm text-muted-foreground">No private videos waiting.</p>
              )}
              {c?.ok &&
                c.videos
                  ?.filter((v) => !done.includes(v.id))
                  .map((v) => {
                    const key = ch + ":" + v.id;
                    return (
                      <div key={v.id} className="mt-3 flex items-center gap-3">
                        {v.thumb && <img src={v.thumb} alt="" className="h-16 w-28 rounded object-cover" />}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{v.title}</p>
                          <p className="text-xs text-muted-foreground">{v.minutes} min · private</p>
                        </div>
                        <button
                          onClick={() => go(ch, v.id)}
                          disabled={busy === key}
                          className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                        >
                          {busy === key ? "Publishing…" : armed === key ? "Tap again to confirm" : "Make public"}
                        </button>
                      </div>
                    );
                  })}
            </section>
          );
        })}
      {done.length > 0 && <p className="panel p-4 text-sm">Published {done.length} video(s). ✅</p>}
    </>
  );
}
