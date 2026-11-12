// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import * as repo from "@/server/repo";
import { draftShortlisted, ideaSweep } from "@/server/automation";
import type { AiDeps } from "@/server/ai";

let db: D1Database;
let dispose: () => Promise<void>;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
}, 60_000);
afterAll(async () => dispose?.());

const mkUser = async (email: string) => {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')")
    .bind(id, email)
    .run();
  return id;
};

/** Fake Anthropic transport that answers by what the prompt asks for. */
function fakeApi() {
  const prompts: string[] = [];
  let n = 0;
  const f: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const prompt = body.messages[0].content as string;
    prompts.push(prompt);
    const isScript = prompt.includes("Write a faceless documentary");
    const text = isScript
      ? JSON.stringify({ hook: "H", outline: "1. a", body: "Narration text", cta: "C" })
      : JSON.stringify({ ideas: [{ title: `Idea ${++n}`, topic: "Future", angle: "a" }] });
    return new Response(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: isScript ? 2000 : 100 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { f, prompts };
}
const deps = (userId: string, f: typeof fetch, over: Partial<AiDeps> = {}): AiDeps => ({
  db,
  userId,
  apiKey: "k",
  capUsd: 5,
  context: { audience: "a", format: "f" },
  fetch: f,
  ...over,
});

describe("idea sweep", () => {
  it("adds ideas per theme, passes earlier titles to avoid duplicates, and logs the run", async () => {
    const u = await mkUser("s1@x.co");
    const api = fakeApi();
    const r = await ideaSweep(deps(u, api.f), ["robots", "chips"], 1);
    expect(r).toMatchObject({ ok: true, added: 2 });
    expect((await repo.loadSnapshot(db, u)).ideas.map((i) => i.title).sort()).toEqual([
      "Idea 1",
      "Idea 2",
    ]);
    expect(api.prompts[1]).toContain("Idea 1"); // second theme was told to avoid the first result
    expect((await repo.listAutomationRuns(db, u))[0]).toMatchObject({
      kind: "idea-sweep",
      status: "ok",
    });
  });

  it("stops cleanly when AI is unavailable, creating nothing and logging the error", async () => {
    const u = await mkUser("s2@x.co");
    const api = fakeApi();
    const r = await ideaSweep(deps(u, api.f, { apiKey: undefined }), [], 3);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/not connected/);
    expect((await repo.loadSnapshot(db, u)).ideas).toHaveLength(0);
    expect((await repo.listAutomationRuns(db, u))[0]).toMatchObject({ status: "error" });
    expect(api.prompts).toHaveLength(0);
  });
});

describe("draft sweep", () => {
  it("drafts scripts only for shortlisted ideas without one, respecting the max", async () => {
    const u = await mkUser("d1@x.co");
    const ideas = await repo.addIdeasBulk(db, u, [
      { title: "A", topic: "Future", angle: "" },
      { title: "B", topic: "Future", angle: "" },
      { title: "C", topic: "Future", angle: "" },
      { title: "D (not shortlisted)", topic: "Future", angle: "" },
    ]);
    for (const i of ideas.slice(0, 3)) await repo.setIdeaStatus(db, u, i.id, "shortlisted");
    await repo.startScript(db, u, ideas[0]!.id); // A already has a script

    const api = fakeApi();
    const r = await draftShortlisted(deps(u, api.f), 1);
    expect(r).toMatchObject({ ok: true, added: 1 });
    const snap = await repo.loadSnapshot(db, u);
    expect(snap.scripts).toHaveLength(2); // A's existing + one new (B)
    const drafted = snap.scripts.find((s) => s.body === "Narration text")!;
    expect(drafted).toMatchObject({ title: "B", hook: "H", cta: "C" });
    expect(await repo.shortlistedWithoutScript(db, u, 10)).toHaveLength(1); // only C remains
  });

  it("never touches videos or approvals", async () => {
    const u = await mkUser("d2@x.co");
    const [idea] = await repo.addIdeasBulk(db, u, [{ title: "Solo", topic: "Future", angle: "" }]);
    await repo.setIdeaStatus(db, u, idea!.id, "shortlisted");
    await draftShortlisted(deps(u, fakeApi().f), 3);
    expect((await repo.loadSnapshot(db, u)).videos).toHaveLength(0);
    const n = await db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE user_id = ?")
      .bind(u)
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("reports when there is nothing to do, and stops (keeping partial work) when the budget runs out", async () => {
    const u = await mkUser("d3@x.co");
    expect((await draftShortlisted(deps(u, fakeApi().f), 2)).summary).toMatch(/No shortlisted/);

    const items = await repo.addIdeasBulk(db, u, [
      { title: "X", topic: "Future", angle: "" },
      { title: "Y", topic: "Future", angle: "" },
    ]);
    for (const i of items) await repo.setIdeaStatus(db, u, i.id, "shortlisted");
    // One script costs ~$0.02 actual; the cap admits the first request but not a second worst-case.
    const r = await draftShortlisted(deps(u, fakeApi().f, { capUsd: 0.05 }), 2);
    expect(r.ok).toBe(false);
    expect(r.added).toBe(1);
    expect(r.summary).toMatch(/Stopped after 1 of 2/);
    expect((await repo.loadSnapshot(db, u)).scripts).toHaveLength(1);
  });
});

import { videoMinutes } from "@/server/catchup";
describe("video length variation", () => {
  it("stays inside each channel's range and changes from day to day", () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-12-${String(i + 1).padStart(2, "0")}`);
    for (const [slot, lo, hi] of [[2, 8, 12], [3, 22, 28], [4, 9, 14]] as const) {
      const vals = days.map((d) => videoMinutes(slot, d));
      expect(Math.min(...vals)).toBeGreaterThanOrEqual(lo);
      expect(Math.max(...vals)).toBeLessThanOrEqual(hi);
      expect(new Set(vals).size).toBeGreaterThan(2);
      expect(videoMinutes(slot, days[0]!)).toBe(vals[0]);
    }
  });
});

import { nextResetIso } from "@/routes/api/automation/pause";
describe("AI allowance pause", () => {
  it("pauses until 00:10 UTC the next day", () => {
    expect(nextResetIso(new Date("2026-11-12T19:30:00Z"))).toBe("2026-11-13T00:10:00.000Z");
    expect(nextResetIso(new Date("2026-12-31T23:59:00Z"))).toBe("2027-01-01T00:10:00.000Z");
  });
});
