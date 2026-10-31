import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as api from "@/lib/api.functions";
import { sampleIdeas, sampleScripts, sampleVideos } from "./sample-data";
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
} from "./types";

// Re-exported so pages keep importing everything from one place.
export { STAGES };
export type { Idea, IdeaStatus, Script, Settings, Stage, Video };
export type { Approval } from "./types";

export type SaveState = "idle" | "saving" | "saved" | "error";
type Mode = "demo" | "db";

export const demoSnapshot: Snapshot = {
  ideas: sampleIdeas,
  scripts: sampleScripts,
  videos: sampleVideos,
  settings: DEFAULT_SETTINGS,
};

type Store = {
  mode: Mode;
  userEmail: string | null;
  signOut: () => Promise<void>;
  /** Last error to show the user (cleared by dismissNotice). */
  notice: string | null;
  dismissNotice: () => void;
  saveState: SaveState;

  ideas: Idea[];
  scripts: Script[];
  videos: Video[];
  settings: Settings;

  addIdea: (title: string, topic: string) => Promise<void>;
  setIdeaStatus: (id: string, status: IdeaStatus) => Promise<void>;
  startScript: (ideaId: string) => Promise<boolean>;
  updateScript: (id: string, patch: Partial<Omit<Script, "id">>) => void;
  createVideo: (input: {
    title: string;
    scriptId?: string;
    scheduled?: string;
  }) => Promise<boolean>;
  toggleStage: (id: string, stage: Stage) => Promise<void>;
  setScheduled: (id: string, scheduled: string) => Promise<void>;
  submitVideo: (id: string) => Promise<void>;
  decideVideo: (
    id: string,
    decision: "approved" | "changes",
    note: string,
    confirmed: boolean,
  ) => Promise<void>;
  returnVideo: (id: string) => Promise<void>;
  updateVideoMeta: (
    id: string,
    patch: Partial<Pick<Video, "title" | "description" | "tags" | "thumbnailConcept">>,
  ) => Promise<boolean>;
  /** Re-reads everything from the server (after server-side generation). No-op in demo mode. */
  reload: () => Promise<void>;
  saveSettings: (s: Settings) => Promise<boolean>;
  loadSampleData: () => Promise<void>;
};

const Ctx = createContext<Store | null>(null);

const nextStage = (done: Stage[]): Stage =>
  STAGES.find((s) => !done.includes(s.key))?.key ?? "quality";
const errText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";

export function StudioProvider({
  mode,
  initial,
  userEmail = null,
  onSignOut,
  onSessionExpired,
  children,
}: {
  mode: Mode;
  initial: Snapshot;
  userEmail?: string | null;
  onSignOut?: () => void;
  onSessionExpired?: () => void;
  children: ReactNode;
}) {
  const [ideas, setIdeas] = useState(initial.ideas);
  const [scripts, setScripts] = useState(initial.scripts);
  const [videos, setVideos] = useState(initial.videos);
  const [settings, setSettings] = useState(initial.settings);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const persisted = mode === "db";

  const applySnapshot = useCallback((s: Snapshot) => {
    setIdeas(s.ideas);
    setScripts(s.scripts);
    setVideos(s.videos);
    setSettings(s.settings);
  }, []);

  /** Re-sync from the server after a failed action so the screen never lies about saved state. */
  const resync = useCallback(async () => {
    try {
      applySnapshot(await api.loadData());
    } catch {
      /* the original error is already shown */
    }
  }, [applySnapshot]);

  const fail = useCallback(
    (e: unknown) => {
      const msg = errText(e);
      setSaveState("error");
      setNotice(msg);
      if (msg === "Please sign in.") onSessionExpired?.();
      else void resync();
    },
    [onSessionExpired, resync],
  );

  /** Runs a server call and tracks the save indicator. Returns undefined on failure. */
  const call = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setSaveState("saving");
      try {
        const out = await fn();
        setSaveState("saved");
        return out;
      } catch (e) {
        fail(e);
        return undefined;
      }
    },
    [fail],
  );

  // ---- debounced script persistence ----
  const pendingScript = useRef(new Map<string, Partial<Omit<Script, "id">>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flushScript = useCallback(
    async (id: string) => {
      const patch = pendingScript.current.get(id);
      pendingScript.current.delete(id);
      timers.current.delete(id);
      if (!patch) return;
      await call(() => api.updateScript({ data: { id, ...patch } }));
    },
    [call],
  );
  const flushAll = useCallback(() => {
    for (const [id, t] of timers.current) {
      clearTimeout(t);
      void flushScript(id);
    }
  }, [flushScript]);
  useEffect(() => {
    if (!persisted) return;
    const onHide = () => document.visibilityState === "hidden" && flushAll();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      flushAll();
    };
  }, [persisted, flushAll]);

  const store = useMemo<Store>(() => {
    const patchVideo = (id: string, f: (v: Video) => Video) =>
      setVideos((vs) => vs.map((v) => (v.id === id ? f(v) : v)));

    return {
      mode,
      userEmail,
      signOut: async () => {
        flushAll();
        if (persisted) await api.logout().catch(() => undefined);
        onSignOut?.();
      },
      notice,
      dismissNotice: () => setNotice(null),
      saveState,
      ideas,
      scripts,
      videos,
      settings,

      addIdea: async (title, topic) => {
        if (!persisted) {
          setIdeas((is) => [
            {
              id: crypto.randomUUID(),
              title,
              topic,
              angle: "Manual idea",
              score: 0,
              status: "new",
            },
            ...is,
          ]);
          return;
        }
        const idea = await call(() => api.addIdea({ data: { title, topic } }));
        if (idea) setIdeas((is) => [idea, ...is]);
      },

      setIdeaStatus: async (id, status) => {
        setIdeas((is) => is.map((i) => (i.id === id ? { ...i, status } : i)));
        if (persisted) await call(() => api.setIdeaStatus({ data: { id, status } }));
      },

      startScript: async (ideaId) => {
        if (!persisted) {
          const idea = ideas.find((i) => i.id === ideaId);
          if (!idea) return false;
          setScripts((s) => [
            ...s,
            {
              id: crypto.randomUUID(),
              title: idea.title,
              hook: "",
              outline: "",
              body: "",
              cta: "",
              storyboard: [],
            },
          ]);
          return true;
        }
        const script = await call(() => api.startScript({ data: { ideaId } }));
        if (script) setScripts((s) => [...s, script]);
        return !!script;
      },

      updateScript: (id, patch) => {
        setScripts((ss) => ss.map((x) => (x.id === id ? { ...x, ...patch } : x)));
        if (!persisted) return;
        // A blank title is a transient state while typing; never send it to the server.
        const { title, ...rest } = patch;
        const persistPatch = title !== undefined && !title.trim() ? rest : patch;
        if (Object.keys(persistPatch).length === 0) return;
        pendingScript.current.set(id, { ...pendingScript.current.get(id), ...persistPatch });
        setSaveState("saving");
        clearTimeout(timers.current.get(id));
        timers.current.set(
          id,
          setTimeout(() => void flushScript(id), 700),
        );
      },

      createVideo: async (input) => {
        if (!persisted) {
          setVideos((vs) => [
            ...vs,
            {
              id: crypto.randomUUID(),
              title: input.title,
              stage: "script",
              done: [],
              scheduled: input.scheduled ?? "",
              approval: "draft",
              description: "",
              tags: [],
              thumbnailConcept: "",
              youtubeStatus: "none",
            },
          ]);
          return true;
        }
        const video = await call(() => api.createVideo({ data: input }));
        if (video) setVideos((vs) => [...vs, video]);
        return !!video;
      },

      toggleStage: async (id, stage) => {
        if (!persisted) {
          patchVideo(id, (v) => {
            const done = v.done.includes(stage)
              ? v.done.filter((d) => d !== stage)
              : [...v.done, stage];
            return { ...v, done, stage: nextStage(done) };
          });
          return;
        }
        const updated = await call(() => api.toggleStage({ data: { id, stage } }));
        if (updated) patchVideo(id, () => updated);
      },

      setScheduled: async (id, scheduled) => {
        patchVideo(id, (v) => ({ ...v, scheduled }));
        if (persisted) await call(() => api.setScheduled({ data: { id, scheduled } }));
      },

      submitVideo: async (id) => {
        if (!persisted) return patchVideo(id, (v) => ({ ...v, approval: "pending" }));
        const ok = await call(() => api.submitVideo({ data: { id } }));
        if (ok) patchVideo(id, (v) => ({ ...v, approval: "pending" }));
      },

      decideVideo: async (id, decision, note, confirmed) => {
        if (!persisted) {
          return patchVideo(id, (v) => ({ ...v, approval: decision, ...(note ? { note } : {}) }));
        }
        const ok = await call(() => api.decideVideo({ data: { id, decision, note, confirmed } }));
        if (ok) patchVideo(id, (v) => ({ ...v, approval: decision, ...(note ? { note } : {}) }));
      },

      returnVideo: async (id) => {
        if (!persisted) return patchVideo(id, (v) => ({ ...v, approval: "draft" }));
        const ok = await call(() => api.returnVideo({ data: { id } }));
        if (ok) patchVideo(id, (v) => ({ ...v, approval: "draft" }));
      },

      updateVideoMeta: async (id, patch) => {
        if (!persisted) {
          patchVideo(id, (v) => ({ ...v, ...patch }));
          return true;
        }
        const updated = await call(() => api.updateVideoMeta({ data: { id, ...patch } }));
        if (updated) patchVideo(id, () => updated);
        return !!updated;
      },

      reload: async () => {
        if (persisted) await resync();
      },

      saveSettings: async (s) => {
        if (!persisted) {
          setSettings(s);
          return true;
        }
        const ok = await call(() => api.saveSettings({ data: s }));
        if (ok) setSettings(s);
        return !!ok;
      },

      loadSampleData: async () => {
        if (!persisted) return;
        const snap = await call(() => api.seedSampleData());
        if (snap) applySnapshot(snap);
      },
    };
  }, [
    mode,
    userEmail,
    persisted,
    notice,
    saveState,
    ideas,
    scripts,
    videos,
    settings,
    call,
    resync,
    flushAll,
    flushScript,
    onSignOut,
    applySnapshot,
  ]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStudio() {
  const c = useContext(Ctx);
  if (!c) throw new Error("StudioProvider missing");
  return c;
}
