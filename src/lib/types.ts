// Shared (client + server) domain types and constants. No server-only imports here.

export type Stage = "script" | "voiceover" | "visuals" | "captions" | "thumbnail" | "quality";
export const STAGES: { key: Stage; label: string }[] = [
  { key: "script", label: "Script" },
  { key: "voiceover", label: "Voiceover" },
  { key: "visuals", label: "Visuals" },
  { key: "captions", label: "Captions" },
  { key: "thumbnail", label: "Thumbnail" },
  { key: "quality", label: "Quality check" },
];
export const STAGE_KEYS = STAGES.map((s) => s.key) as [Stage, ...Stage[]];

export type IdeaStatus = "new" | "shortlisted" | "rejected";
export type Approval = "draft" | "pending" | "approved" | "changes";

export type Idea = {
  id: string;
  title: string;
  topic: string;
  angle: string;
  score: number;
  status: IdeaStatus;
};
export type Script = {
  id: string;
  title: string;
  hook: string;
  outline: string;
  body: string;
  cta: string;
};
export type Video = {
  id: string;
  title: string;
  stage: Stage;
  done: Stage[];
  scheduled: string;
  approval: Approval;
  note?: string | undefined;
};
export type Settings = {
  audience: string;
  format: string;
  approvalRequired: boolean;
  timezone: string;
  budgetCap: number;
  currency: string;
};

export type Snapshot = {
  ideas: Idea[];
  scripts: Script[];
  videos: Video[];
  settings: Settings;
};

export const DEFAULT_SETTINGS: Settings = {
  audience: "Worldwide (English)",
  format: "Faceless documentary / explainer with AI narration",
  approvalRequired: true,
  timezone: "Asia/Muscat",
  budgetCap: 0,
  currency: "USD",
};

/** What the session endpoint tells the client. */
export type SessionInfo =
  | { mode: "demo" } // no database bound (Lovable preview / plain vite dev)
  | { mode: "db"; user: { email: string } | null; setupOpen: boolean; setupConfigured: boolean };
