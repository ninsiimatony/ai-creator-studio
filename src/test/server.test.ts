// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import { hashPassword, verifyPassword, randomToken, sha256Hex } from "@/server/crypto";
import {
  authenticate,
  countUsers,
  createFirstUser,
  createSession,
  destroySession,
  getSessionUser,
} from "@/server/auth";
import * as repo from "@/server/repo";
import { AppError } from "@/server/errors";
import { STAGES } from "@/lib/types";

let db: D1Database;
let dispose: () => Promise<void>;
let alice: { id: string; email: string };
let bob: { id: string; email: string };
const PW = "correct horse battery staple";

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  const a = await createFirstUser(db, "alice@example.com", PW);
  if (!a) throw new Error("setup failed");
  alice = a;
  // A second user inserted directly, to test tenant isolation (the app itself is single-owner).
  bob = { id: crypto.randomUUID(), email: "bob@example.com" };
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)")
    .bind(bob.id, bob.email, await hashPassword(PW))
    .run();
}, 60_000);
afterAll(async () => dispose?.());

describe("crypto", () => {
  it("verifies the right password and rejects wrong or malformed ones", async () => {
    const h = await hashPassword(PW);
    expect(h.startsWith("pbkdf2-sha256$100000$")).toBe(true);
    expect(await verifyPassword(PW, h)).toBe(true);
    expect(await verifyPassword("wrong password!!", h)).toBe(false);
    expect(await verifyPassword(PW, "garbage")).toBe(false);
    expect(await verifyPassword(PW, h.replace("100000", "999999999"))).toBe(false);
  });
  it("salts every hash and produces unpredictable tokens", async () => {
    expect(await hashPassword(PW)).not.toBe(await hashPassword(PW));
    expect(randomToken()).not.toBe(randomToken());
    expect(randomToken().length).toBeGreaterThanOrEqual(43);
    expect(await sha256Hex("a")).toHaveLength(64);
  });
});

describe("auth", () => {
  it("only allows the first account to be created, even concurrently", async () => {
    expect(await countUsers(db)).toBe(2);
    const results = await Promise.all([
      createFirstUser(db, "x@example.com", PW),
      createFirstUser(db, "y@example.com", PW),
    ]);
    expect(results).toEqual([null, null]);
  });

  it("stores only a hash of the session token and honours expiry and logout", async () => {
    const token = await createSession(db, alice.id);
    const stored = await db
      .prepare("SELECT token_hash FROM sessions")
      .all<{ token_hash: string }>();
    expect(stored.results.some((r) => r.token_hash === token)).toBe(false);
    expect(stored.results.some((r) => r.token_hash === (null as never))).toBe(false);
    expect((await getSessionUser(db, token))?.email).toBe("alice@example.com");

    await destroySession(db, token);
    expect(await getSessionUser(db, token)).toBeNull();
    expect(await getSessionUser(db, undefined)).toBeNull();
    expect(await getSessionUser(db, "forged-token")).toBeNull();

    const expired = await createSession(db, alice.id);
    await db
      .prepare("UPDATE sessions SET expires_at = 1 WHERE token_hash = ?")
      .bind(await sha256Hex(expired))
      .run();
    expect(await getSessionUser(db, expired)).toBeNull();
  });

  it("authenticates, gives a generic error, and rate limits repeated failures", async () => {
    expect((await authenticate(db, "alice@example.com", PW, "ip1")).id).toBe(alice.id);
    await expect(authenticate(db, "alice@example.com", "nope", "ip1")).rejects.toThrow(
      "Invalid email or password.",
    );
    // Unknown account gives the identical message (no user enumeration).
    await expect(authenticate(db, "ghost@example.com", PW, "ip1")).rejects.toThrow(
      "Invalid email or password.",
    );
    for (let i = 0; i < 5; i++) {
      await expect(authenticate(db, "bob@example.com", "bad", "ip2")).rejects.toThrow(AppError);
    }
    // Locked out: even the correct password is refused now.
    await expect(authenticate(db, "bob@example.com", PW, "ip2")).rejects.toThrow(/Too many failed/);
    // A different client is unaffected.
    expect((await authenticate(db, "bob@example.com", PW, "ip3")).id).toBe(bob.id);
  });
});

describe("data isolation", () => {
  it("never exposes or modifies one user's data to another", async () => {
    const idea = await repo.addIdea(db, alice.id, { title: "Alice idea", topic: "Robotics" });
    const script = await repo.startScript(db, alice.id, idea.id);
    const video = await repo.createVideo(db, alice.id, {
      title: "Alice video",
      scriptId: script.id,
    });

    const bobView = await repo.loadSnapshot(db, bob.id);
    expect(bobView.ideas).toHaveLength(0);
    expect(bobView.scripts).toHaveLength(0);
    expect(bobView.videos).toHaveLength(0);

    await expect(repo.setIdeaStatus(db, bob.id, idea.id, "rejected")).rejects.toThrow("not found");
    await expect(repo.updateScript(db, bob.id, script.id, { title: "pwn" })).rejects.toThrow();
    await expect(repo.toggleStage(db, bob.id, video.id, "script")).rejects.toThrow("not found");
    await expect(repo.startScript(db, bob.id, idea.id)).rejects.toThrow("not found");
    await expect(
      repo.createVideo(db, bob.id, { title: "x", scriptId: script.id }),
    ).rejects.toThrow();

    const aliceView = await repo.loadSnapshot(db, alice.id);
    expect(aliceView.ideas[0]?.status).toBe("new");
    expect(aliceView.scripts[0]?.title).toBe("Alice idea");
  });
});

describe("ideas, scripts and settings", () => {
  it("persists edits across reloads", async () => {
    const idea = await repo.addIdea(db, bob.id, {
      title: "Why AI hallucinates",
      topic: "AI technology",
    });
    await repo.setIdeaStatus(db, bob.id, idea.id, "shortlisted");
    const script = await repo.startScript(db, bob.id, idea.id);
    await repo.updateScript(db, bob.id, script.id, { hook: "A hook", body: "Some narration" });
    await repo.updateScript(db, bob.id, script.id, {});
    const snap = await repo.loadSnapshot(db, bob.id);
    expect(snap.ideas[0]).toMatchObject({ title: "Why AI hallucinates", status: "shortlisted" });
    expect(snap.scripts[0]).toMatchObject({ hook: "A hook", body: "Some narration", cta: "" });
  });

  it("returns defaults until settings are saved, then upserts", async () => {
    const before = await repo.loadSnapshot(db, bob.id);
    expect(before.settings).toMatchObject({ timezone: "Asia/Muscat", approvalRequired: true });
    await repo.saveSettings(db, bob.id, { ...before.settings, timezone: "UTC", budgetCap: 5.5 });
    await repo.saveSettings(db, bob.id, {
      ...before.settings,
      timezone: "Europe/London",
      budgetCap: 7,
    });
    const after = await repo.loadSnapshot(db, bob.id);
    expect(after.settings).toMatchObject({ timezone: "Europe/London", budgetCap: 7 });
  });
});

describe("video production and approval rules", () => {
  it("enforces the full draft -> pending -> approved flow with an audit trail", async () => {
    const v = await repo.createVideo(db, alice.id, { title: "Flow test", scheduled: "2026-12-01" });

    await expect(repo.submitVideo(db, alice.id, v.id)).rejects.toThrow("Complete all stages");
    await expect(repo.decideVideo(db, alice.id, v.id, "approved", "", true)).rejects.toThrow(
      "not awaiting approval",
    );

    let video = v;
    for (const s of STAGES) video = await repo.toggleStage(db, alice.id, v.id, s.key);
    expect(video.done).toHaveLength(6);
    expect(video.stage).toBe("quality");

    await repo.submitVideo(db, alice.id, v.id);
    await expect(repo.submitVideo(db, alice.id, v.id)).rejects.toThrow("Only draft");
    await expect(repo.toggleStage(db, alice.id, v.id, "script")).rejects.toThrow("approval flow");

    // Approval needs the explicit confirmation flag.
    await expect(repo.decideVideo(db, alice.id, v.id, "approved", "ok", false)).rejects.toThrow(
      "confirm",
    );
    await repo.decideVideo(db, alice.id, v.id, "approved", "Looks good", true);
    const snap = await repo.loadSnapshot(db, alice.id);
    expect(snap.videos.find((x) => x.id === v.id)).toMatchObject({
      approval: "approved",
      note: "Looks good",
    });
    // Already decided: cannot be decided again.
    await expect(repo.decideVideo(db, alice.id, v.id, "changes", "", false)).rejects.toThrow();

    const log = await db
      .prepare("SELECT action FROM approvals WHERE video_id = ? ORDER BY id")
      .bind(v.id)
      .all<{ action: string }>();
    expect(log.results.map((r) => r.action)).toEqual(["submitted", "approved"]);
  });

  it("supports requesting changes and returning to production", async () => {
    const v = await repo.createVideo(db, alice.id, { title: "Changes test" });
    for (const s of STAGES) await repo.toggleStage(db, alice.id, v.id, s.key);
    await repo.submitVideo(db, alice.id, v.id);
    await repo.decideVideo(db, alice.id, v.id, "changes", "Fix the intro", false);
    await expect(repo.submitVideo(db, alice.id, v.id)).rejects.toThrow("Only draft");
    await repo.returnVideo(db, alice.id, v.id);
    await repo.toggleStage(db, alice.id, v.id, "script"); // editable again
    await repo.setScheduled(db, alice.id, v.id, "2026-12-24");
    const row = (await repo.loadSnapshot(db, alice.id)).videos.find((x) => x.id === v.id);
    expect(row).toMatchObject({ approval: "draft", scheduled: "2026-12-24" });
    const log = await db
      .prepare("SELECT action FROM approvals WHERE video_id = ? ORDER BY id")
      .bind(v.id)
      .all<{ action: string }>();
    expect(log.results.map((r) => r.action)).toEqual([
      "submitted",
      "changes_requested",
      "returned",
    ]);
  });

  it("has no way to publish: the schema offers no 'published' state", async () => {
    await expect(
      db.prepare("UPDATE videos SET approval = 'published' WHERE user_id = ?").bind(alice.id).run(),
    ).rejects.toThrow();
  });
});

describe("sample data", () => {
  it("loads only into an empty workspace, and keeps pending videos consistent", async () => {
    const carol = { id: crypto.randomUUID() };
    await db
      .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'carol@example.com', 'x')")
      .bind(carol.id)
      .run();
    await repo.seedSampleData(db, carol.id);
    const snap = await repo.loadSnapshot(db, carol.id);
    expect(snap.ideas).toHaveLength(5);
    expect(snap.scripts).toHaveLength(2);
    expect(snap.videos).toHaveLength(4);
    const pending = snap.videos.find((v) => v.approval === "pending");
    expect(pending?.done).toHaveLength(6);
    await expect(repo.seedSampleData(db, carol.id)).rejects.toThrow("empty workspace");
  });
});
