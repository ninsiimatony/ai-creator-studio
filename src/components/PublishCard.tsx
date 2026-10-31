import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStudio, type Video } from "@/lib/studio-store";
import { AiBox, Badge } from "@/components/ui-bits";
import {
  aiMetadata,
  aiThumbnails,
  type MetadataSuggestion,
  type ThumbnailConcepts,
} from "@/lib/ai.functions";
import {
  confirmYoutubeUpload,
  setYoutubeVisibility,
  startYoutubeUpload,
} from "@/lib/youtube.functions";
import { aiBlockedReason, useIntegrations } from "@/lib/use-integrations";

const msgOf = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");
const PHRASE = "PUBLISH";

const ytTone = {
  none: "off",
  uploading: "demo",
  private: "teal",
  unlisted: "teal",
  scheduled: "teal",
  public: "ok",
} as const;
const ytLabel = {
  none: "Not on YouTube",
  uploading: "Upload not confirmed",
  private: "On YouTube · private",
  unlisted: "On YouTube · unlisted",
  scheduled: "On YouTube · scheduled",
  public: "On YouTube · public",
} as const;

export function PublishCard({ video: v }: { video: Video }) {
  const { mode, updateVideoMeta, reload } = useStudio();
  const qc = useQueryClient();
  const integ = useIntegrations();
  const aiBlocked = aiBlockedReason(mode, integ.data);
  const editable =
    (v.approval === "draft" || v.approval === "changes") && v.youtubeStatus === "none";

  const [title, setTitle] = useState(v.title);
  const [description, setDescription] = useState(v.description);
  const [tags, setTags] = useState(v.tags.join(", "));
  const [concept, setConcept] = useState(v.thumbnailConcept);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [meta, setMeta] = useState<MetadataSuggestion | null>(null);
  const [thumbs, setThumbs] = useState<ThumbnailConcepts | null>(null);

  const parsedTags = () =>
    tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setErr(msgOf(e));
    } finally {
      setBusy(null);
    }
  };
  const spent = () => void qc.invalidateQueries({ queryKey: ["integrations"] });

  return (
    <section className="panel space-y-4 p-5" aria-label={v.title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{v.title}</h2>
        <div className="flex flex-wrap gap-2">
          <Badge
            tone={v.approval === "approved" ? "ok" : v.approval === "pending" ? "demo" : "off"}
          >
            {v.approval === "approved" ? "Approved by Tony" : v.approval}
          </Badge>
          <Badge tone={ytTone[v.youtubeStatus]}>{ytLabel[v.youtubeStatus]}</Badge>
        </div>
      </div>

      {editable ? (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">YouTube title ({title.length}/100)</span>
            <input
              className="field"
              maxLength={100}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Description</span>
            <textarea
              className="field"
              rows={5}
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Tags (comma separated)</span>
            <input className="field" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Thumbnail concept</span>
            <textarea
              className="field"
              rows={2}
              maxLength={2000}
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy !== null || !title.trim()}
            onClick={() =>
              void run("save", async () => {
                const ok = await updateVideoMeta(v.id, {
                  title: title.trim(),
                  description,
                  tags: parsedTags(),
                  thumbnailConcept: concept,
                });
                if (ok) setNote("Details saved.");
              })
            }
          >
            Save details
          </button>

          <AiBox title="SEO suggestions (title, description, tags)" blocked={aiBlocked}>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                void run("meta", async () => {
                  // Save first so the AI sees the latest text.
                  await updateVideoMeta(v.id, {
                    title: title.trim() || v.title,
                    description,
                    tags: parsedTags(),
                  });
                  const r = await aiMetadata({ data: { videoId: v.id } });
                  setMeta(r.data);
                  spent();
                  setNote(`Suggestions ready · cost $${r.usage.costUsd.toFixed(4)}.`);
                })
              }
            >
              {busy === "meta" ? "Thinking…" : "Suggest / improve"}
            </button>
            {meta && (
              <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                <div>
                  <div className="mb-1 font-medium">Title options</div>
                  <ul className="space-y-1">
                    {meta.titles.map((t) => (
                      <li key={t}>
                        <button
                          type="button"
                          className="btn text-left"
                          onClick={() => setTitle(t.slice(0, 100))}
                        >
                          Use
                        </button>{" "}
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="mb-1 font-medium">Description</div>
                  <p className="max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">
                    {meta.description}
                  </p>
                  <button
                    type="button"
                    className="btn mt-1"
                    onClick={() => setDescription(meta.description.slice(0, 5000))}
                  >
                    Use description
                  </button>
                </div>
                <div>
                  <div className="mb-1 font-medium">Tags</div>
                  <p className="text-muted-foreground">{meta.tags.join(", ")}</p>
                  <button
                    type="button"
                    className="btn mt-1"
                    onClick={() => setTags(meta.tags.join(", "))}
                  >
                    Use tags
                  </button>
                </div>
                {meta.seoNotes.length > 0 && (
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {meta.seoNotes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">
                  Suggestions only — review before saving. Remember to save details after choosing.
                </p>
              </div>
            )}
          </AiBox>

          <AiBox title="Thumbnail concepts" blocked={aiBlocked}>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() =>
                void run("thumbs", async () => {
                  const r = await aiThumbnails({ data: { videoId: v.id } });
                  setThumbs(r.data);
                  spent();
                })
              }
            >
              {busy === "thumbs" ? "Thinking…" : "Suggest concepts"}
            </button>
            {thumbs && (
              <ul className="space-y-2 text-sm">
                {thumbs.concepts.map((c, i) => (
                  <li key={i} className="rounded-md border p-2">
                    <div className="font-medium">“{c.headline}”</div>
                    <div className="text-muted-foreground">
                      {c.visual} · {c.colors} · {c.emotion}
                    </div>
                    <button
                      type="button"
                      className="btn mt-1"
                      onClick={() =>
                        setConcept(`“${c.headline}” — ${c.visual}. ${c.colors}. ${c.emotion}.`)
                      }
                    >
                      Use this concept
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Concepts only — no image is generated. Make the image yourself and upload it after the
              video is on YouTube.
            </p>
          </AiBox>
        </div>
      ) : (
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Title</dt>
            <dd>{v.title}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Description</dt>
            <dd className="whitespace-pre-wrap">{v.description || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Tags</dt>
            <dd>{v.tags.join(", ") || "—"}</dd>
          </div>
          {(v.approval === "pending" || v.approval === "approved") &&
            v.youtubeStatus === "none" && (
              <p className="text-xs text-muted-foreground">
                Details are locked while the video is in the approval flow. Request changes in
                Approvals to edit.
              </p>
            )}
        </dl>
      )}

      {v.approval === "approved" && (
        <YoutubePanel video={v} onDone={reload} setErr={setErr} setNote={setNote} />
      )}
      {v.approval !== "approved" && v.youtubeStatus === "none" && (
        <p className="text-sm text-muted-foreground">
          Uploading to YouTube unlocks only after you approve this video in the Approvals queue.
        </p>
      )}

      {note && (
        <p role="status" className="text-sm text-primary">
          {note}
        </p>
      )}
      {err && (
        <p role="alert" className="text-sm text-destructive">
          {err}
        </p>
      )}
    </section>
  );
}

function YoutubePanel({
  video: v,
  onDone,
  setErr,
  setNote,
}: {
  video: Video;
  onDone: () => Promise<void>;
  setErr: (s: string) => void;
  setNote: (s: string) => void;
}) {
  const { mode } = useStudio();
  const integ = useIntegrations();
  const [file, setFile] = useState<File | null>(null);
  const [privacy, setPrivacy] = useState<"private" | "unlisted" | "public">("private");
  const [when, setWhen] = useState("");
  const [phrase, setPhrase] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualId, setManualId] = useState("");
  const [vis, setVis] = useState<"private" | "unlisted" | "public">("unlisted");
  const [visPhrase, setVisPhrase] = useState("");
  const [thumb, setThumb] = useState<File | null>(null);

  const connected = integ.data?.youtube.connected;
  const needsPhrase = privacy === "public" || !!when;
  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    setNote("");
    try {
      await fn();
    } catch (e) {
      setErr(msgOf(e));
    } finally {
      setBusy(false);
      setPct(null);
    }
  };

  if (mode === "demo") {
    return (
      <p className="text-sm text-muted-foreground">
        YouTube upload needs the database (unavailable in demo mode).
      </p>
    );
  }
  if (!connected) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect your YouTube channel on the YouTube channel page to upload this approved video.
      </p>
    );
  }

  const confirm = (id: string) =>
    confirmYoutubeUpload({ data: { videoId: v.id, youtubeVideoId: id } }).then(async (r) => {
      await onDone();
      setNote(`Uploaded. YouTube status: ${r.status}.`);
    });

  function upload() {
    if (!file) return;
    return wrap(async () => {
      const { uploadUrl } = await startYoutubeUpload({
        data: {
          videoId: v.id,
          privacy,
          ...(when ? { publishAt: new Date(when).toISOString() } : {}),
          ...(needsPhrase ? { confirmPublic: phrase } : {}),
          fileSize: file.size,
          mimeType: file.type || "video/mp4",
        },
      });
      const id = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
        xhr.upload.onprogress = (e) =>
          e.lengthComputable && setPct(Math.round((e.loaded / e.total) * 100));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve((JSON.parse(xhr.responseText) as { id: string }).id);
            } catch {
              reject(
                new Error(
                  "The upload finished but YouTube's reply was unreadable. Paste the video ID below to confirm.",
                ),
              );
            }
          } else
            reject(new Error(`The upload to YouTube failed (${xhr.status}). You can try again.`));
        };
        xhr.onerror = () =>
          reject(
            new Error(
              "The upload was interrupted or blocked by the browser. Check your connection and try again.",
            ),
          );
        xhr.send(file);
      });
      await confirm(id);
    });
  }

  // 1) Not uploaded yet (or an upload that was never confirmed).
  if (v.youtubeStatus === "none" || v.youtubeStatus === "uploading") {
    return (
      <div className="space-y-3 rounded-md border p-3 text-sm">
        <div className="font-medium">Upload to YouTube</div>
        {v.youtubeStatus === "uploading" && (
          <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-2">
            <p>
              An upload was started but not confirmed. If the video is already in YouTube Studio,
              paste its ID to link it, or upload again below.
            </p>
            <div className="flex gap-2">
              <input
                className="field"
                placeholder="YouTube video ID"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
              />
              <button
                className="btn"
                disabled={busy || manualId.trim().length < 6}
                onClick={() => void wrap(() => confirm(manualId.trim()))}
              >
                Link
              </button>
            </div>
          </div>
        )}
        <label className="block">
          <span className="mb-1 block font-medium">Video file</span>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="font-medium">Visibility</legend>
          {(
            [
              ["private", "Private (recommended) — only you can see it"],
              ["unlisted", "Unlisted — anyone with the link"],
              ["public", "Public — visible to everyone"],
            ] as const
          ).map(([val, label]) => (
            <label key={val} className="flex items-center gap-2">
              <input
                type="radio"
                name={`pv-${v.id}`}
                checked={privacy === val}
                onChange={() => setPrivacy(val)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="block">
          <span className="mb-1 block font-medium">Schedule (optional)</span>
          <input
            type="datetime-local"
            className="field w-auto"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Uploads privately and goes public at this time. Your browser's local time zone is used.
          </span>
        </label>
        {needsPhrase && (
          <label className="block">
            <span className="mb-1 block font-medium">
              This will make the video public{when ? " at the scheduled time" : ""}. Type {PHRASE}{" "}
              to confirm.
            </span>
            <input
              className="field"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        <button
          className="btn btn-primary"
          disabled={busy || !file || (needsPhrase && phrase !== PHRASE)}
          onClick={() => void upload()}
        >
          {busy ? (pct !== null ? `Uploading… ${pct}%` : "Preparing…") : "Upload to YouTube"}
        </button>
        {pct !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The file goes straight from your browser to YouTube; nothing is stored here. Keep this tab
          open until it finishes. Review YouTube Studio's “altered or synthetic content” disclosure
          for AI narration.
        </p>
      </div>
    );
  }

  // 2) Already on YouTube: visibility + thumbnail.
  const link = v.youtubeVideoId;
  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <div className="font-medium">On YouTube</div>
      {link && (
        <p>
          <a
            className="text-primary underline"
            href={`https://studio.youtube.com/video/${link}/edit`}
            target="_blank"
            rel="noreferrer"
          >
            Open in YouTube Studio
          </a>
          {v.publishAt && (
            <span className="text-muted-foreground">
              {" "}
              · scheduled for {new Date(v.publishAt).toLocaleString()}
            </span>
          )}
        </p>
      )}
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block font-medium">Change visibility</span>
          <select
            className="field w-auto"
            value={vis}
            onChange={(e) => setVis(e.target.value as typeof vis)}
          >
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>
        </label>
        {vis === "public" && (
          <label className="block">
            <span className="mb-1 block font-medium">Type {PHRASE} to make this video public.</span>
            <input
              className="field"
              value={visPhrase}
              onChange={(e) => setVisPhrase(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        <button
          className="btn"
          disabled={busy || vis === v.youtubeStatus || (vis === "public" && visPhrase !== PHRASE)}
          onClick={() =>
            void wrap(async () => {
              const r = await setYoutubeVisibility({
                data: {
                  videoId: v.id,
                  privacy: vis,
                  ...(vis === "public" ? { confirmPublic: visPhrase } : {}),
                },
              });
              await onDone();
              setVisPhrase("");
              setNote(`Visibility is now ${r.status}.`);
            })
          }
        >
          Apply visibility
        </button>
      </div>
      <div className="space-y-2">
        <label className="block">
          <span className="mb-1 block font-medium">Custom thumbnail (PNG or JPEG, up to 2 MB)</span>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => setThumb(e.target.files?.[0] ?? null)}
          />
        </label>
        <button
          className="btn"
          disabled={busy || !thumb}
          onClick={() =>
            void wrap(async () => {
              const res = await fetch(
                `/api/youtube/thumbnail?videoId=${encodeURIComponent(v.id)}`,
                {
                  method: "POST",
                  headers: { "content-type": thumb!.type },
                  body: thumb,
                },
              );
              const j = (await res.json().catch(() => ({}))) as { error?: string };
              if (!res.ok) throw new Error(j.error ?? "The thumbnail upload failed.");
              setNote("Thumbnail uploaded.");
            })
          }
        >
          Upload thumbnail
        </button>
      </div>
    </div>
  );
}
