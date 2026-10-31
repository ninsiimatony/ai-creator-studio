// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import * as repo from "@/server/repo";
import { STAGES } from "@/lib/types";

let db: D1Database;
let dispose: () => Promise<void>;
let a: string;
let b: string;

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  a = crypto.randomUUID();
  b = crypto.randomUUID();
  for (const [id, email] of [
    [a, "a@x.co"],
    [b, "b@x.co"],
  ] as const) {
    await db
      .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')")
      .bind(id, email)
      .run();
  }
}, 60_000);
afterAll(async () => dispose?.());

describe("AI-created content", () => {
  it("saves generated ideas as unscored 'new' ideas for the right user only", async () => {
    const saved = await repo.addIdeasBulk(db, a, [
      { title: "Idea one", topic: "Robotics", angle: "angle one" },
      { title: "Idea two", topic: "Future", angle: "angle two" },
    ]);
    expect(saved).toHaveLength(2);
    expect(saved.every((i) => i.score === 0 && i.status === "new")).toBe(true);
    expect((await repo.loadSnapshot(db, a)).ideas).toHaveLength(2);
    expect((await repo.loadSnapshot(db, b)).ideas).toHaveLength(0);
    expect(await repo.addIdeasBulk(db, a, [])).toEqual([]);
  });

  it("stores a storyboard on a script, scoped to its owner", async () => {
    const idea = (await repo.loadSnapshot(db, a)).ideas[0]!;
    const script = await repo.startScript(db, a, idea.id);
    const scenes = [
      { narration: "n", visual: "v", keywords: ["k1", "k2"], onScreenText: "", seconds: 12 },
    ];
    await repo.setStoryboard(db, a, script.id, scenes);
    expect((await repo.getScript(db, a, script.id)).storyboard).toEqual(scenes);
    await expect(repo.setStoryboard(db, b, script.id, scenes)).rejects.toThrow("not found");
    await expect(repo.getScript(db, b, script.id)).rejects.toThrow("not found");
  });
});

describe("video publishing metadata", () => {
  it("round-trips description, tags and thumbnail concept, and links the script", async () => {
    const script = (await repo.loadSnapshot(db, a)).scripts[0]!;
    await repo.updateScript(db, a, script.id, { body: "Full narration", hook: "A hook" });
    const v = await repo.createVideo(db, a, { title: "Meta video", scriptId: script.id });
    const updated = await repo.updateVideoMeta(db, a, v.id, {
      description: "Desc",
      tags: ["ai", "robots"],
      thumbnailConcept: "Big robot",
    });
    expect(updated).toMatchObject({
      description: "Desc",
      tags: ["ai", "robots"],
      thumbnailConcept: "Big robot",
    });
    const snap = (await repo.loadSnapshot(db, a)).videos.find((x) => x.id === v.id)!;
    expect(snap).toMatchObject({
      tags: ["ai", "robots"],
      youtubeStatus: "none",
      scriptId: script.id,
    });
    const ctx = await repo.getVideoWithScript(db, a, v.id);
    expect(ctx).toMatchObject({ scriptBody: "Full narration", scriptHook: "A hook" });
    await expect(repo.updateVideoMeta(db, b, v.id, { title: "x" })).rejects.toThrow("not found");
  });

  it("locks metadata while awaiting/after approval and after sending to YouTube", async () => {
    const v = await repo.createVideo(db, a, { title: "Locked video" });
    for (const s of STAGES) await repo.toggleStage(db, a, v.id, s.key);
    await repo.submitVideo(db, a, v.id);
    await expect(repo.updateVideoMeta(db, a, v.id, { description: "sneaky" })).rejects.toThrow(
      "approval flow",
    );
    await repo.decideVideo(db, a, v.id, "approved", "", true);
    await expect(
      repo.updateVideoMeta(db, a, v.id, { title: "changed after approval" }),
    ).rejects.toThrow("approval flow");
    const w = await repo.createVideo(db, a, { title: "Sent video" });
    await db.prepare("UPDATE videos SET youtube_status = 'private' WHERE id = ?").bind(w.id).run();
    await expect(repo.updateVideoMeta(db, a, w.id, { title: "x" })).rejects.toThrow("already sent");
  });

  it("persists the AI budget setting and the automation log", async () => {
    const s = (await repo.loadSnapshot(db, a)).settings;
    expect(s.aiDailyCapUsd).toBe(0); // AI starts switched off
    await repo.saveSettings(db, a, { ...s, aiDailyCapUsd: 2.5 });
    expect((await repo.getSettingsFor(db, a)).aiDailyCapUsd).toBe(2.5);
    await repo.logAutomation(db, a, "ideas", "ok", "Added 3 ideas");
    expect((await repo.listAutomationRuns(db, a))[0]).toMatchObject({
      kind: "ideas",
      status: "ok",
    });
    expect(await repo.listAutomationRuns(db, b)).toEqual([]);
  });
});
