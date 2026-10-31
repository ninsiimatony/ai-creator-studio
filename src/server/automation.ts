// One-click batch drafting. These runs only create DRAFTS inside the user's AI budget:
// they never change approvals, never upload and never publish. Scheduling is not enabled.
import { AppError } from "./errors";
import { runAi, type AiDeps } from "./ai";
import * as repo from "./repo";

export type RunResult = { ok: boolean; summary: string; added: number };

async function finish(
  deps: AiDeps,
  kind: string,
  ok: boolean,
  summary: string,
  added: number,
): Promise<RunResult> {
  await repo.logAutomation(deps.db, deps.userId, kind, ok ? "ok" : "error", summary);
  return { ok, summary, added };
}

/** Brainstorm ideas for each theme (or one open-ended batch when none are given). */
export async function ideaSweep(
  deps: AiDeps,
  topics: string[],
  countPerTopic: number,
): Promise<RunResult> {
  const themes = topics
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);
  const batches: (string | undefined)[] = themes.length ? themes : [undefined];
  const avoid = (await repo.loadSnapshot(deps.db, deps.userId)).ideas
    .slice(0, 40)
    .map((i) => i.title);
  let added = 0;
  try {
    for (const topic of batches) {
      const out = await runAi(deps, "ideas", { topic, count: countPerTopic, avoid });
      const saved = await repo.addIdeasBulk(
        deps.db,
        deps.userId,
        (out.data as { ideas: { title: string; topic: string; angle: string }[] }).ideas,
      );
      added += saved.length;
      avoid.push(...saved.map((i) => i.title));
    }
    return await finish(
      deps,
      "idea-sweep",
      true,
      `Added ${added} idea${added === 1 ? "" : "s"}.`,
      added,
    );
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return finish(deps, "idea-sweep", false, `Stopped after adding ${added}: ${e.message}`, added);
  }
}

/** Write a first-draft script for shortlisted ideas that have none. The AI runs before anything is created. */
export async function draftShortlisted(deps: AiDeps, max: number): Promise<RunResult> {
  const todo = await repo.shortlistedWithoutScript(deps.db, deps.userId, max);
  if (todo.length === 0) {
    return finish(deps, "draft-sweep", true, "No shortlisted ideas without a script.", 0);
  }
  let drafted = 0;
  try {
    for (const idea of todo) {
      const out = await runAi(deps, "script", { title: idea.title, minutes: 6 });
      const d = out.data as { hook: string; outline: string; body: string; cta: string };
      const script = await repo.startScript(deps.db, deps.userId, idea.id);
      await repo.updateScript(deps.db, deps.userId, script.id, d);
      drafted++;
    }
    return await finish(
      deps,
      "draft-sweep",
      true,
      `Drafted ${drafted} script${drafted === 1 ? "" : "s"} for review.`,
      drafted,
    );
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return finish(
      deps,
      "draft-sweep",
      false,
      `Stopped after ${drafted} of ${todo.length}: ${e.message}`,
      drafted,
    );
  }
}
