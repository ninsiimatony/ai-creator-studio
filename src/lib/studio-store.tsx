import { createContext, useContext, useState, type ReactNode } from "react";

export type Stage = "script" | "voiceover" | "visuals" | "captions" | "thumbnail" | "quality";
export const STAGES: { key: Stage; label: string }[] = [
  { key: "script", label: "Script" },
  { key: "voiceover", label: "Voiceover" },
  { key: "visuals", label: "Visuals" },
  { key: "captions", label: "Captions" },
  { key: "thumbnail", label: "Thumbnail" },
  { key: "quality", label: "Quality check" },
];

export type Idea = { id: string; title: string; topic: string; angle: string; score: number; status: "new" | "shortlisted" | "rejected" };
export type Script = { id: string; title: string; hook: string; outline: string; body: string; cta: string };
export type Video = {
  id: string; title: string; stage: Stage; done: Stage[]; scheduled: string;
  approval: "draft" | "pending" | "approved" | "changes"; note?: string | undefined;
};
export type Settings = { audience: string; format: string; approvalRequired: boolean; timezone: string; budgetCap: number; currency: string };

const initialIdeas: Idea[] = [
  { id: "i1", title: "How humanoid robots learn to walk", topic: "Robotics", angle: "Reinforcement learning explained visually", score: 82, status: "shortlisted" },
  { id: "i2", title: "5 AI tools replacing spreadsheets", topic: "AI tools", angle: "Practical comparison for small businesses", score: 74, status: "new" },
  { id: "i3", title: "What happens when AI designs chips?", topic: "AI technology", angle: "Documentary on AI-assisted hardware", score: 69, status: "new" },
  { id: "i4", title: "Cities in 2050: autonomous everything", topic: "Future", angle: "Speculative explainer, grounded in research", score: 77, status: "new" },
  { id: "i5", title: "Why AI hallucinates", topic: "AI technology", angle: "Simple analogy-driven explainer", score: 88, status: "shortlisted" },
];
const initialScripts: Script[] = [
  {
    id: "s1", title: "Why AI hallucinates",
    hook: "Your AI assistant just told you something confidently… and completely wrong. Here's why.",
    outline: "1. A real-world hallucination example\n2. How language models predict words\n3. Why confidence ≠ accuracy\n4. How researchers reduce it\n5. What it means for you",
    body: "Draft narration goes here…",
    cta: "If this helped, subscribe for weekly AI explainers — and tell us the strangest AI answer you've seen.",
  },
  { id: "s2", title: "How humanoid robots learn to walk", hook: "", outline: "", body: "", cta: "" },
];
const initialVideos: Video[] = [
  { id: "v1", title: "Why AI hallucinates", stage: "quality", done: ["script", "voiceover", "visuals", "captions", "thumbnail"], scheduled: "2026-11-04", approval: "pending" },
  { id: "v2", title: "How humanoid robots learn to walk", stage: "voiceover", done: ["script"], scheduled: "2026-11-08", approval: "draft" },
  { id: "v3", title: "Cities in 2050: autonomous everything", stage: "script", done: [], scheduled: "2026-11-12", approval: "draft" },
  { id: "v4", title: "The race for AI chips, explained", stage: "thumbnail", done: ["script", "voiceover", "visuals", "captions"], scheduled: "2026-11-15", approval: "draft" },
];

type Store = {
  ideas: Idea[]; setIdeas: (f: (i: Idea[]) => Idea[]) => void;
  scripts: Script[]; setScripts: (f: (s: Script[]) => Script[]) => void;
  videos: Video[]; setVideos: (f: (v: Video[]) => Video[]) => void;
  settings: Settings; setSettings: (s: Settings) => void;
};
const Ctx = createContext<Store | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  const [ideas, setIdeas] = useState(initialIdeas);
  const [scripts, setScripts] = useState(initialScripts);
  const [videos, setVideos] = useState(initialVideos);
  const [settings, setSettings] = useState<Settings>({
    audience: "Worldwide (English)", format: "Faceless documentary / explainer with AI narration",
    approvalRequired: true, timezone: "Asia/Muscat", budgetCap: 0, currency: "USD",
  });
  return <Ctx.Provider value={{ ideas, setIdeas, scripts, setScripts, videos, setVideos, settings, setSettings }}>{children}</Ctx.Provider>;
}
export function useStudio() {
  const c = useContext(Ctx);
  if (!c) throw new Error("StudioProvider missing");
  return c;
}
