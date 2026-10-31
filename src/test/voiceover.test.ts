// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import {
  DAILY_CHAR_CAP,
  MAX_CHARS_PER_PART,
  chunkNarration,
  synthesizePart,
  voiceCharsToday,
} from "@/server/voiceover";

let db: D1Database;
let dispose: () => Promise<void>;
let uid: string;
beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
  uid = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'v@x.co', 'x')")
    .bind(uid)
    .run();
}, 60_000);
afterAll(async () => dispose?.());

function fakeEleven(status = 200, bytes = 1200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const f: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return status === 200
      ? new Response(new Uint8Array(bytes), { status, headers: { "content-type": "audio/mpeg" } })
      : new Response("{}", { status });
  };
  return { f, calls };
}
const base = (over: Record<string, unknown> = {}) => ({
  db,
  userId: uid,
  apiKey: "xi-key",
  voiceId: "voice_abc123",
  text: "Hello world.",
  ...over,
});

describe("chunkNarration", () => {
  it("returns nothing for empty text and one part for short text", () => {
    expect(chunkNarration("   ")).toEqual([]);
    expect(chunkNarration("Short narration.")).toEqual(["Short narration."]);
  });
  it("splits on paragraph boundaries and never exceeds the limit", () => {
    const para = "A sentence here. ".repeat(100).trim(); // ~1700 chars
    const parts = chunkNarration([para, para, para, para].join("\n\n"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= MAX_CHARS_PER_PART)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toContain("A sentence here.");
  });
  it("splits one huge paragraph at sentence ends, and hard-splits an unbroken run as a last resort", () => {
    const longPara = "Word ".repeat(3000).trim() + ".";
    expect(chunkNarration(longPara).every((p) => p.length <= MAX_CHARS_PER_PART)).toBe(true);
    const noBreaks = "x".repeat(MAX_CHARS_PER_PART * 2 + 10);
    const parts = chunkNarration(noBreaks);
    expect(parts.every((p) => p.length <= MAX_CHARS_PER_PART)).toBe(true);
    expect(parts.join("")).toBe(noBreaks);
  });
  it("loses no text when splitting", () => {
    const text = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i}. ${"Detail. ".repeat(60)}`,
    ).join("\n\n");
    const joined = chunkNarration(text).join(" ").replace(/\s+/g, "");
    expect(joined).toBe(text.replace(/\s+/g, ""));
  });
});

describe("synthesizePart", () => {
  it("calls ElevenLabs with the key in a header (not the URL), returns audio and logs characters", async () => {
    const g = fakeEleven();
    const out = await synthesizePart(base({ fetch: g.f }));
    expect(out.audio.byteLength).toBe(1200);
    expect(out.chars).toBe("Hello world.".length);
    const c = g.calls[0]!;
    expect(c.url).toContain("/v1/text-to-speech/voice_abc123");
    expect(c.url).not.toContain("xi-key");
    expect(c.headers.get("xi-api-key")).toBe("xi-key");
    expect(c.body["text"]).toBe("Hello world.");
    expect(await voiceCharsToday(db, uid)).toBe(12);
  });

  it("refuses without a key, voice, or text — and never calls the network", async () => {
    const g = fakeEleven();
    await expect(synthesizePart(base({ apiKey: undefined, fetch: g.f }))).rejects.toThrow(
      /not connected/,
    );
    await expect(synthesizePart(base({ voiceId: undefined, fetch: g.f }))).rejects.toThrow(
      /Choose a voice/,
    );
    await expect(synthesizePart(base({ voiceId: "../etc/passwd", fetch: g.f }))).rejects.toThrow(
      /invalid/,
    );
    await expect(synthesizePart(base({ text: "", fetch: g.f }))).rejects.toThrow(/no narration/);
    await expect(
      synthesizePart(base({ text: "x".repeat(MAX_CHARS_PER_PART + 1), fetch: g.f })),
    ).rejects.toThrow(/too long/);
    expect(g.calls).toHaveLength(0);
  });

  it("enforces the daily character cap before calling the provider", async () => {
    const u2 = crypto.randomUUID();
    await db
      .prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'cap@x.co', 'x')")
      .bind(u2)
      .run();
    await db
      .prepare(
        "INSERT INTO ai_usage (user_id, kind, model, input_tokens) VALUES (?, 'voiceover', 'elevenlabs', ?)",
      )
      .bind(u2, DAILY_CHAR_CAP - 5)
      .run();
    const g = fakeEleven();
    await expect(
      synthesizePart(base({ userId: u2, text: "x".repeat(50), fetch: g.f })),
    ).rejects.toThrow(/Daily voiceover limit/);
    expect(g.calls).toHaveLength(0);
  });

  it("maps provider errors to safe messages and does not log usage for failures", async () => {
    const before = await voiceCharsToday(db, uid);
    await expect(synthesizePart(base({ fetch: fakeEleven(401).f }))).rejects.toThrow(
      /key was rejected/,
    );
    await expect(synthesizePart(base({ fetch: fakeEleven(429).f }))).rejects.toThrow(
      /rate limited or out of credits/,
    );
    await expect(synthesizePart(base({ fetch: fakeEleven(500).f }))).rejects.toThrow(
      /failed \(500\)/,
    );
    await expect(synthesizePart(base({ fetch: fakeEleven(200, 0).f }))).rejects.toThrow(/no audio/);
    expect(await voiceCharsToday(db, uid)).toBe(before);
  });
});
