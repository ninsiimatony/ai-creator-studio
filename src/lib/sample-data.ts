import type { Idea, Script, Video } from "./types";

// Optional sample content (the original demo data). Never loaded automatically
// when a database is connected — only via the explicit "Load sample data" button.
export const sampleIdeas: Idea[] = [
  {
    id: "i1",
    title: "How humanoid robots learn to walk",
    topic: "Robotics",
    angle: "Reinforcement learning explained visually",
    score: 82,
    status: "shortlisted",
  },
  {
    id: "i2",
    title: "5 AI tools replacing spreadsheets",
    topic: "AI tools",
    angle: "Practical comparison for small businesses",
    score: 74,
    status: "new",
  },
  {
    id: "i3",
    title: "What happens when AI designs chips?",
    topic: "AI technology",
    angle: "Documentary on AI-assisted hardware",
    score: 69,
    status: "new",
  },
  {
    id: "i4",
    title: "Cities in 2050: autonomous everything",
    topic: "Future",
    angle: "Speculative explainer, grounded in research",
    score: 77,
    status: "new",
  },
  {
    id: "i5",
    title: "Why AI hallucinates",
    topic: "AI technology",
    angle: "Simple analogy-driven explainer",
    score: 88,
    status: "shortlisted",
  },
];

export const sampleScripts: Script[] = [
  {
    id: "s1",
    title: "Why AI hallucinates",
    hook: "Your AI assistant just told you something confidently… and completely wrong. Here's why.",
    outline:
      "1. A real-world hallucination example\n2. How language models predict words\n3. Why confidence ≠ accuracy\n4. How researchers reduce it\n5. What it means for you",
    body: "Draft narration goes here…",
    cta: "If this helped, subscribe for weekly AI explainers — and tell us the strangest AI answer you've seen.",
    storyboard: [],
  },
  {
    id: "s2",
    title: "How humanoid robots learn to walk",
    hook: "",
    outline: "",
    body: "",
    cta: "",
    storyboard: [],
  },
];

export const sampleVideos: Video[] = [
  {
    id: "v1",
    title: "Why AI hallucinates",
    stage: "quality",
    done: ["script", "voiceover", "visuals", "captions", "thumbnail"],
    scheduled: "2026-11-04",
    approval: "pending",
    description: "",
    tags: [],
    thumbnailConcept: "",
    youtubeStatus: "none",
  },
  {
    id: "v2",
    title: "How humanoid robots learn to walk",
    stage: "voiceover",
    done: ["script"],
    scheduled: "2026-11-08",
    approval: "draft",
    description: "",
    tags: [],
    thumbnailConcept: "",
    youtubeStatus: "none",
  },
  {
    id: "v3",
    title: "Cities in 2050: autonomous everything",
    stage: "script",
    done: [],
    scheduled: "2026-11-12",
    approval: "draft",
    description: "",
    tags: [],
    thumbnailConcept: "",
    youtubeStatus: "none",
  },
  {
    id: "v4",
    title: "The race for AI chips, explained",
    stage: "thumbnail",
    done: ["script", "voiceover", "visuals", "captions"],
    scheduled: "2026-11-15",
    approval: "draft",
    description: "",
    tags: [],
    thumbnailConcept: "",
    youtubeStatus: "none",
  },
];
