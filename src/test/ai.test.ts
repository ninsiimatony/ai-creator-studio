// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import { costUsd, runAi, spentTodayUsd, type AiDeps } from "@/server/ai";
import { AppError } from "@/server/errors";

let db: D1Database;
let dispose: () => Promise<void>;
const ctx = { audience: "Worldwide (English)", format: "Faceless documentary" };

async function mkUser(email: string) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')")
    .bind(id, email)
    .run();
  return id;
}

/** A fake Anthropic HTTP transport returning a genuine Messages API response shape. */
function fakeApi(opts: {
  text?: string;
  stop?: string;
  status?: number;
  inTok?: number;
  outTok?: number;
}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    if (opts.status && opts.status >= 400) {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }),
        { status: opts.status, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "test",
        content: [{ type: "text", text: opts.text ?? "{}" }],
        stop_reason: opts.stop ?? "end_turn",
        stop_sequence: null,
        usage: { input_tokens: opts.inTok ?? 1000, output_tokens: opts.outTok ?? 500 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { impl, calls };
}

const IDEAS = JSON.stringify({
  ideas: [{ title: "How robots learn", topic: "Robotics", angle: "RL explained" }],
});

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
}, 60_000);
afterAll(async () => dispose?.());

const deps = (userId: string, over: Partial<AiDeps> = {}): AiDeps => ({
  db,
  userId,
  apiKey: "sk-ant-test",
  capUsd: 1,
  context: ctx,
  ...over,
});

describe("pricing", () => {
  it("computes cost from token usage", () => {
    expect(costUsd("claude-haiku-5-5", 1000, 500)).toBeCloseTo(0.00035, 8);
    expect(costUsd("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBe(12);
    // Unknown models are priced conservatively (most expensive known).
    expect(costUsd("mystery", 1_000_000, 0)).toBe(4);
  });
});

describe("runAi guards", () => {
  it("refuses without an API key, and never calls the network", async () => {
    const u = await mkUser("a@x.co");
    const api = fakeApi({ text: IDEAS });
    await expect(
      runAi(deps(u, { apiKey: undefined, fetch: api.impl }), "ideas", {}),
    ).rejects.toThrow(/not connected/);
    expect(api.calls).toHaveLength(0);
  });

  it("is off until a daily budget is set", async () => {
    const u = await mkUser("b@x.co");
    const api = fakeApi({ text: IDEAS });
    await expect(runAi(deps(u, { capUsd: 0, fetch: api.impl }), "ideas", {})).rejects.toThrow(
      /budget/i,
    );
    expect(api.calls).toHaveLength(0);
  });

  it("blocks a request whose worst case would exceed the cap, before spending anything", async () => {
    const u = await mkUser("c@x.co");
    const api = fakeApi({ text: "{}" });
    // A 6-minute script on Sonnet can cost several cents; a 1-cent cap must refuse.
    await expect(
      runAi(deps(u, { capUsd: 0.01, fetch: api.impl }), "script", { title: "T" }),
    ).rejects.toThrow(/Daily AI budget reached/);
    expect(api.calls).toHaveLength(0);
    expect(await spentTodayUsd(db, u)).toBe(0);
  });
});

describe("runAi success and metering", () => {
  it("returns validated data, uses the cheap model for ideas, and records exact usage", async () => {
    const u = await mkUser("d@x.co");
    const api = fakeApi({ text: IDEAS, inTok: 1000, outTok: 500 });
    const out = await runAi(deps(u, { fetch: api.impl }), "ideas", { topic: "robots", count: 1 });
    expect(out.data).toEqual(JSON.parse(IDEAS));
    expect(out.usage).toMatchObject({
      model: "claude-haiku-5-5",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(out.usage.costUsd).toBeCloseTo(0.00035, 8);
    expect(api.calls[0]?.body["model"]).toBe("claude-haiku-5-5");
    expect(JSON.stringify(api.calls[0]?.body)).toContain("robots");
    expect(await spentTodayUsd(db, u)).toBeCloseTo(0.00035, 8);

    await runAi(deps(u, { fetch: api.impl }), "ideas", {});
    expect(await spentTodayUsd(db, u)).toBeCloseTo(0.0007, 8); // accumulates
  });

  it("uses the writer model for scripts, honours model overrides, and sends the channel context", async () => {
    const u = await mkUser("e@x.co");
    const body = JSON.stringify({
      hook: "h",
      outline: "1. a",
      body: "narration",
      cta: "subscribe",
    });
    const api = fakeApi({ text: body });
    const out = await runAi(deps(u, { fetch: api.impl }), "script", {
      title: "Why AI hallucinates",
    });
    expect(out.data).toEqual(JSON.parse(body));
    expect(api.calls[0]?.body["model"]).toBe("claude-sonnet-5-5");
    expect(JSON.stringify(api.calls[0]?.body)).toContain("Faceless documentary");

    const api2 = fakeApi({ text: body });
    await runAi(deps(u, { fetch: api2.impl, models: { writer: "claude-opus-5-5" } }), "script", {
      title: "x",
    });
    expect(api2.calls[0]?.body["model"]).toBe("claude-opus-5-5");
  });

  it("keeps each user's spend separate", async () => {
    const u1 = await mkUser("f1@x.co");
    const u2 = await mkUser("f2@x.co");
    await runAi(deps(u1, { fetch: fakeApi({ text: IDEAS }).impl }), "ideas", {});
    expect(await spentTodayUsd(db, u1)).toBeGreaterThan(0);
    expect(await spentTodayUsd(db, u2)).toBe(0);
  });

  it("rejects invalid input before calling the API", async () => {
    const u = await mkUser("g@x.co");
    const api = fakeApi({ text: IDEAS });
    await expect(runAi(deps(u, { fetch: api.impl }), "script", { title: "" })).rejects.toThrow();
    await expect(
      runAi(deps(u, { fetch: api.impl }), "storyboard", { title: "t", body: "short" }),
    ).rejects.toThrow();
    expect(api.calls).toHaveLength(0);
  });
});

describe("runAi failure handling", () => {
  it("bills but reports a refusal; reports truncation; rejects malformed output", async () => {
    const u = await mkUser("h@x.co");
    await expect(
      runAi(deps(u, { fetch: fakeApi({ text: IDEAS, stop: "refusal" }).impl }), "ideas", {}),
    ).rejects.toThrow(/declined/);
    await expect(
      runAi(deps(u, { fetch: fakeApi({ text: IDEAS, stop: "max_tokens" }).impl }), "ideas", {}),
    ).rejects.toThrow(/cut off/);
    await expect(
      runAi(deps(u, { fetch: fakeApi({ text: '{"nope":1}' }).impl }), "ideas", {}),
    ).rejects.toBeInstanceOf(Error);
    expect(await spentTodayUsd(db, u)).toBeGreaterThan(0);
  });

  it("maps API errors to safe messages without leaking details", async () => {
    const u = await mkUser("i@x.co");
    await expect(
      runAi(deps(u, { fetch: fakeApi({ status: 401 }).impl }), "ideas", {}),
    ).rejects.toThrow(/key was rejected/);
    const err = await runAi(deps(u, { fetch: fakeApi({ status: 500 }).impl }), "ideas", {}).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(String(err.message)).not.toContain("boom");
  }, 20_000);
});
