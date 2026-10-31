// Data access for the studio. Every function takes the D1 handle and the owning user id,
// and every query is scoped by user_id. Approval rules are enforced here, server-side.
import type { D1Database, D1PreparedStatement } from "./db";
import { AppError } from "./errors";
import {
  DEFAULT_SETTINGS,
  STAGES,
  type Idea,
  type IdeaStatus,
  type Script,
  type Settings,
  type Snapshot,
  type Stage,
  type Video,
} from "@/lib/types";
import { sampleIdeas, sampleScripts, sampleVideos } from "@/lib/sample-data";

type IdeaRow = Omit<Idea, "id"> & { id: string };
type VideoRow = {
  id: string;
  title: string;
  stage: Stage;
  done_stages: string;
  scheduled: string;
  approval: Video["approval"];
  note: string | null;
};
type SettingsRow = {
  audience: string;
  format: string;
  approval_required: number;
  timezone: string;
  budget_cap: number;
  currency: string;
};

const ALL_STAGES = STAGES.map((s) => s.key);

function parseDone(json: string): Stage[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v.filter((s) => ALL_STAGES.includes(s as Stage)) as Stage[]) : [];
  } catch {
    return [];
  }
}
/** The first stage not yet done (or "quality" when everything is). */
export function nextStage(done: Stage[]): Stage {
  return STAGES.find((s) => !done.includes(s.key))?.key ?? "quality";
}
const toVideo = (r: VideoRow): Video => ({
  id: r.id,
  title: r.title,
  stage: r.stage,
  done: parseDone(r.done_stages),
  scheduled: r.scheduled,
  approval: r.approval,
  ...(r.note ? { note: r.note } : {}),
});
const toSettings = (r: SettingsRow | null): Settings =>
  r
    ? {
        audience: r.audience,
        format: r.format,
        approvalRequired: r.approval_required === 1,
        timezone: r.timezone,
        budgetCap: r.budget_cap,
        currency: r.currency as Settings["currency"],
      }
    : DEFAULT_SETTINGS;

// ---------- reads ----------

export async function loadSnapshot(db: D1Database, uid: string): Promise<Snapshot> {
  const [ideas, scripts, videos, settings] = await db.batch([
    db
      .prepare(
        "SELECT id, title, topic, angle, score, status FROM ideas WHERE user_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .bind(uid),
    db
      .prepare(
        "SELECT id, title, hook, outline, body, cta FROM scripts WHERE user_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .bind(uid),
    db
      .prepare(
        "SELECT id, title, stage, done_stages, scheduled, approval, note FROM videos WHERE user_id = ? ORDER BY scheduled ASC, created_at ASC",
      )
      .bind(uid),
    db
      .prepare(
        "SELECT audience, format, approval_required, timezone, budget_cap, currency FROM settings WHERE user_id = ?",
      )
      .bind(uid),
  ]);
  return {
    ideas: (ideas?.results ?? []) as IdeaRow[],
    scripts: (scripts?.results ?? []) as Script[],
    videos: ((videos?.results ?? []) as VideoRow[]).map(toVideo),
    settings: toSettings(((settings?.results ?? [])[0] as SettingsRow | undefined) ?? null),
  };
}

// ---------- ideas ----------

export async function addIdea(
  db: D1Database,
  uid: string,
  input: { title: string; topic: string },
): Promise<Idea> {
  const idea: Idea = {
    id: crypto.randomUUID(),
    title: input.title,
    topic: input.topic,
    angle: "Manual idea",
    score: 0,
    status: "new",
  };
  await db
    .prepare(
      "INSERT INTO ideas (id, user_id, title, topic, angle, score, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(idea.id, uid, idea.title, idea.topic, idea.angle, idea.score, idea.status)
    .run();
  return idea;
}

export async function setIdeaStatus(
  db: D1Database,
  uid: string,
  id: string,
  status: IdeaStatus,
): Promise<void> {
  const res = await db
    .prepare(
      "UPDATE ideas SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    )
    .bind(status, id, uid)
    .run();
  if (!res.meta.changes) throw new AppError("Idea not found.");
}

// ---------- scripts ----------

export async function startScript(db: D1Database, uid: string, ideaId: string): Promise<Script> {
  const idea = await db
    .prepare("SELECT title FROM ideas WHERE id = ? AND user_id = ?")
    .bind(ideaId, uid)
    .first<{ title: string }>();
  if (!idea) throw new AppError("Idea not found.");
  const script: Script = {
    id: crypto.randomUUID(),
    title: idea.title,
    hook: "",
    outline: "",
    body: "",
    cta: "",
  };
  await db
    .prepare("INSERT INTO scripts (id, user_id, idea_id, title) VALUES (?, ?, ?, ?)")
    .bind(script.id, uid, ideaId, script.title)
    .run();
  return script;
}

export async function updateScript(
  db: D1Database,
  uid: string,
  id: string,
  patch: { [K in keyof Omit<Script, "id">]?: string | undefined },
): Promise<void> {
  const cols = (["title", "hook", "outline", "body", "cta"] as const).filter(
    (k) => patch[k] !== undefined,
  );
  if (cols.length === 0) return;
  const sql = `UPDATE scripts SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`;
  const res = await db
    .prepare(sql)
    .bind(...cols.map((c) => patch[c]), id, uid)
    .run();
  if (!res.meta.changes) throw new AppError("Script not found.");
}

// ---------- videos & approvals ----------

export async function createVideo(
  db: D1Database,
  uid: string,
  input: { title: string; scriptId?: string | undefined; scheduled?: string | undefined },
): Promise<Video> {
  if (input.scriptId) {
    const s = await db
      .prepare("SELECT id FROM scripts WHERE id = ? AND user_id = ?")
      .bind(input.scriptId, uid)
      .first();
    if (!s) throw new AppError("Script not found.");
  }
  const video: Video = {
    id: crypto.randomUUID(),
    title: input.title,
    stage: "script",
    done: [],
    scheduled: input.scheduled ?? "",
    approval: "draft",
  };
  await db
    .prepare("INSERT INTO videos (id, user_id, script_id, title, scheduled) VALUES (?, ?, ?, ?, ?)")
    .bind(video.id, uid, input.scriptId ?? null, video.title, video.scheduled)
    .run();
  return video;
}

async function getVideo(db: D1Database, uid: string, id: string): Promise<Video> {
  const row = await db
    .prepare(
      "SELECT id, title, stage, done_stages, scheduled, approval, note FROM videos WHERE id = ? AND user_id = ?",
    )
    .bind(id, uid)
    .first<VideoRow>();
  if (!row) throw new AppError("Video not found.");
  return toVideo(row);
}

export async function toggleStage(
  db: D1Database,
  uid: string,
  id: string,
  stage: Stage,
): Promise<Video> {
  const v = await getVideo(db, uid, id);
  if (v.approval === "pending" || v.approval === "approved") {
    throw new AppError(
      "This video is in the approval flow. Request changes before editing stages.",
    );
  }
  const done = v.done.includes(stage) ? v.done.filter((d) => d !== stage) : [...v.done, stage];
  const next = nextStage(done);
  await db
    .prepare(
      "UPDATE videos SET done_stages = ?, stage = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    )
    .bind(JSON.stringify(done), next, id, uid)
    .run();
  return { ...v, done, stage: next };
}

export async function setScheduled(
  db: D1Database,
  uid: string,
  id: string,
  scheduled: string,
): Promise<void> {
  const res = await db
    .prepare(
      "UPDATE videos SET scheduled = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    )
    .bind(scheduled, id, uid)
    .run();
  if (!res.meta.changes) throw new AppError("Video not found.");
}

function logApproval(
  db: D1Database,
  uid: string,
  videoId: string,
  action: "submitted" | "approved" | "changes_requested" | "returned",
  note?: string,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO approvals (user_id, video_id, action, note) VALUES (?, ?, ?, ?)")
    .bind(uid, videoId, action, note ?? null);
}

/** draft -> pending. Requires every production stage to be complete. */
export async function submitVideo(db: D1Database, uid: string, id: string): Promise<void> {
  const v = await getVideo(db, uid, id);
  if (v.approval !== "draft") throw new AppError("Only draft videos can be sent for approval.");
  if (v.done.length !== STAGES.length) throw new AppError("Complete all stages first.");
  await db.batch([
    db
      .prepare(
        "UPDATE videos SET approval = 'pending', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND approval = 'draft'",
      )
      .bind(id, uid),
    logApproval(db, uid, id, "submitted"),
  ]);
}

/** pending -> approved | changes. Approving requires explicit confirmation. */
export async function decideVideo(
  db: D1Database,
  uid: string,
  id: string,
  decision: "approved" | "changes",
  note: string,
  confirmed: boolean,
): Promise<void> {
  const v = await getVideo(db, uid, id);
  if (v.approval !== "pending") throw new AppError("This video is not awaiting approval.");
  if (decision === "approved" && !confirmed) {
    throw new AppError("Please confirm you have reviewed the video before approving.");
  }
  await db.batch([
    db
      .prepare(
        "UPDATE videos SET approval = ?, note = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND approval = 'pending'",
      )
      .bind(decision, note || null, id, uid),
    logApproval(db, uid, id, decision === "approved" ? "approved" : "changes_requested", note),
  ]);
}

/** changes -> draft. */
export async function returnVideo(db: D1Database, uid: string, id: string): Promise<void> {
  const v = await getVideo(db, uid, id);
  if (v.approval !== "changes")
    throw new AppError("Only videos with requested changes can be returned.");
  await db.batch([
    db
      .prepare(
        "UPDATE videos SET approval = 'draft', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND approval = 'changes'",
      )
      .bind(id, uid),
    logApproval(db, uid, id, "returned"),
  ]);
}

// ---------- settings ----------

export async function saveSettings(db: D1Database, uid: string, s: Settings): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (user_id, audience, format, approval_required, timezone, budget_cap, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET audience = excluded.audience, format = excluded.format,
         approval_required = excluded.approval_required, timezone = excluded.timezone,
         budget_cap = excluded.budget_cap, currency = excluded.currency, updated_at = datetime('now')`,
    )
    .bind(
      uid,
      s.audience,
      s.format,
      s.approvalRequired ? 1 : 0,
      s.timezone,
      s.budgetCap,
      s.currency,
    )
    .run();
}

// ---------- sample data (explicit opt-in) ----------

/** Loads the original demo content, only into an account that has no ideas, scripts or videos. */
export async function seedSampleData(db: D1Database, uid: string): Promise<void> {
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM ideas WHERE user_id = ?1) +
              (SELECT COUNT(*) FROM scripts WHERE user_id = ?1) +
              (SELECT COUNT(*) FROM videos WHERE user_id = ?1) AS n`,
    )
    .bind(uid)
    .first<{ n: number }>();
  if ((counts?.n ?? 0) > 0)
    throw new AppError("Sample data can only be loaded into an empty workspace.");

  const stmts: D1PreparedStatement[] = [];
  for (const i of sampleIdeas) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO ideas (id, user_id, title, topic, angle, score, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), uid, i.title, i.topic, i.angle, i.score, i.status),
    );
  }
  for (const s of sampleScripts) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO scripts (id, user_id, title, hook, outline, body, cta) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), uid, s.title, s.hook, s.outline, s.body, s.cta),
    );
  }
  for (const v of sampleVideos) {
    const id = crypto.randomUUID();
    // A video in the approval queue must have completed every stage.
    const done = v.approval === "pending" ? ALL_STAGES : v.done;
    stmts.push(
      db
        .prepare(
          "INSERT INTO videos (id, user_id, title, stage, done_stages, scheduled, approval) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id, uid, v.title, nextStage(done), JSON.stringify(done), v.scheduled, v.approval),
    );
    if (v.approval === "pending") stmts.push(logApproval(db, uid, id, "submitted"));
  }
  await db.batch(stmts);
}
