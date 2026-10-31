// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiBinding, D1Database } from "@/server/db";
import { createTestDb } from "./d1";
import {
  DAILY_IMAGE_CAP,
  DAILY_TTS_CHAR_CAP,
  IMAGE_MODEL,
  MAX_TTS_CHARS,
  TTS_MODEL,
  generateImage,
  imagesToday,
  synthesizeSpeech,
  ttsCharsToday,
} from "@/server/media";

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
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
const MP3 = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0x21, 0xff, 0xfb, 0x90, 0x00];

/** A fake Workers AI binding that records calls. */
function fakeAi(reply: unknown | (() => unknown)) {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const ai: AiBinding = {
    run: async (model, input) => {
      calls.push({ model, input });
      const r = typeof reply === "function" ? (reply as () => unknown)() : reply;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { ai, calls };
}

describe("AI images (FLUX-1-schnell)", () => {
  it("refuses without the Workers AI binding, and validates the prompt, before any call", async () => {
    const u = await mkUser("img0@x.co");
    const g = fakeAi({ image: b64(JPEG) });
    await expect(
      generateImage({ db, userId: u, ai: undefined, prompt: "a robot" }),
    ).rejects.toThrow(/not configured/);
    await expect(generateImage({ db, userId: u, ai: g.ai, prompt: "   " })).rejects.toThrow(
      /Describe the image/,
    );
    await expect(
      generateImage({ db, userId: u, ai: g.ai, prompt: "x".repeat(601) }),
    ).rejects.toThrow(/under 600/);
    expect(g.calls).toHaveLength(0);
  });

  it("calls the documented model with {prompt, steps}, returns the decoded image, and logs usage", async () => {
    const u = await mkUser("img1@x.co");
    const g = fakeAi({ image: b64(JPEG) });
    const out = await generateImage({
      db,
      userId: u,
      ai: g.ai,
      prompt: "  a humanoid\n robot  walking ",
    });
    expect(out.mime).toBe("image/jpeg");
    expect([...out.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(g.calls[0]).toEqual({
      model: IMAGE_MODEL,
      input: { prompt: "a humanoid robot walking", steps: 4 },
    });
    expect(IMAGE_MODEL).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(await imagesToday(db, u)).toBe(1);
  });

  it("accepts a data-URI/PNG reply and rejects replies that are not images", async () => {
    const u = await mkUser("img2@x.co");
    expect(
      (
        await generateImage({
          db,
          userId: u,
          ai: fakeAi({ image: "data:image/png;base64," + b64(PNG) }).ai,
          prompt: "p",
        })
      ).mime,
    ).toBe("image/png");
    await expect(
      generateImage({
        db,
        userId: u,
        ai: fakeAi({ image: b64([1, 2, 3, 4, 5, 6]) }).ai,
        prompt: "p",
      }),
    ).rejects.toThrow(/not an image/);
    await expect(generateImage({ db, userId: u, ai: fakeAi({}).ai, prompt: "p" })).rejects.toThrow(
      /no image/,
    );
    await expect(
      generateImage({ db, userId: u, ai: fakeAi(null).ai, prompt: "p" }),
    ).rejects.toThrow(/no image/);
  });

  it("turns service errors into a safe message and does not log failed calls", async () => {
    const u = await mkUser("img3@x.co");
    const err = await generateImage({
      db,
      userId: u,
      ai: fakeAi(new Error("3040: Out of capacity secret-detail")).ai,
      prompt: "p",
    }).catch((e) => e);
    expect(String(err.message)).toMatch(/free daily allowance/);
    expect(String(err.message)).not.toContain("secret-detail");
    expect(await imagesToday(db, u)).toBe(0);
  });

  it("enforces the daily image cap before calling the service", async () => {
    const u = await mkUser("img4@x.co");
    for (let i = 0; i < DAILY_IMAGE_CAP; i++) {
      await db
        .prepare(
          "INSERT INTO ai_usage (user_id, kind, model, input_tokens) VALUES (?, 'image', 'flux-1-schnell', 10)",
        )
        .bind(u)
        .run();
    }
    const g = fakeAi({ image: b64(JPEG) });
    await expect(generateImage({ db, userId: u, ai: g.ai, prompt: "p" })).rejects.toThrow(
      /Daily AI image limit/,
    );
    expect(g.calls).toHaveLength(0);
    // Another user is unaffected.
    const other = await mkUser("img5@x.co");
    await generateImage({ db, userId: other, ai: g.ai, prompt: "p" });
    expect(g.calls).toHaveLength(1);
  });
});

describe("free voiceover (MeloTTS)", () => {
  it("refuses without the binding and validates text, before any call", async () => {
    const u = await mkUser("tts0@x.co");
    const g = fakeAi({ audio: b64(MP3) });
    await expect(synthesizeSpeech({ db, userId: u, ai: undefined, text: "hi" })).rejects.toThrow(
      /not configured/,
    );
    await expect(synthesizeSpeech({ db, userId: u, ai: g.ai, text: " " })).rejects.toThrow(
      /no text/,
    );
    await expect(
      synthesizeSpeech({ db, userId: u, ai: g.ai, text: "x".repeat(MAX_TTS_CHARS + 1) }),
    ).rejects.toThrow(/under/);
    expect(g.calls).toHaveLength(0);
  });

  it("calls the documented model with {prompt, lang} and logs the characters", async () => {
    const u = await mkUser("tts1@x.co");
    const g = fakeAi({ audio: b64(MP3) });
    const out = await synthesizeSpeech({
      db,
      userId: u,
      ai: g.ai,
      text: "Hello world.",
      lang: "fr",
    });
    expect(out.mime).toBe("audio/mpeg");
    expect(g.calls[0]).toEqual({ model: TTS_MODEL, input: { prompt: "Hello world.", lang: "fr" } });
    expect(TTS_MODEL).toBe("@cf/myshell-ai/melotts");
    expect(await ttsCharsToday(db, u)).toBe("Hello world.".length);
    // Unsafe language codes fall back to English.
    await synthesizeSpeech({ db, userId: u, ai: g.ai, text: "x", lang: "../../etc" });
    expect(g.calls[1]!.input["lang"]).toBe("en");
  });

  it("understands every audio reply shape Workers AI documents or may use", async () => {
    const u = await mkUser("tts2@x.co");
    const bytes = Uint8Array.from(MP3);
    const shapes: Record<string, unknown> = {
      "base64 in {audio}": { audio: b64(MP3) },
      Uint8Array: bytes,
      ArrayBuffer: bytes.buffer.slice(0),
      "base64 string": b64(MP3),
      "Response-like": new Response(bytes),
      ReadableStream: new Response(bytes).body,
      "{audio: Uint8Array}": { audio: bytes },
    };
    for (const [name, reply] of Object.entries(shapes)) {
      const out = await synthesizeSpeech({ db, userId: u, ai: fakeAi(reply).ai, text: "t" });
      expect(out.bytes.length, name).toBe(MP3.length);
    }
  });

  it("rejects empty or non-audio replies, maps errors safely, and enforces the daily cap", async () => {
    const u = await mkUser("tts3@x.co");
    await expect(synthesizeSpeech({ db, userId: u, ai: fakeAi({}).ai, text: "t" })).rejects.toThrow(
      /no usable audio/,
    );
    await expect(
      synthesizeSpeech({ db, userId: u, ai: fakeAi({ audio: "" }).ai, text: "t" }),
    ).rejects.toThrow(/no usable audio/);
    await expect(
      synthesizeSpeech({
        db,
        userId: u,
        ai: fakeAi({ audio: b64([1, 2, 3, 4, 5, 6]) }).ai,
        text: "t",
      }),
    ).rejects.toThrow(/no usable audio/);
    const e = await synthesizeSpeech({
      db,
      userId: u,
      ai: fakeAi(new Error("boom-internal")).ai,
      text: "t",
    }).catch((x) => x);
    expect(String(e.message)).not.toContain("boom-internal");
    expect(await ttsCharsToday(db, u)).toBe(0);

    await db
      .prepare(
        "INSERT INTO ai_usage (user_id, kind, model, input_tokens) VALUES (?, 'tts', 'melotts', ?)",
      )
      .bind(u, DAILY_TTS_CHAR_CAP - 3)
      .run();
    const g = fakeAi({ audio: b64(MP3) });
    await expect(
      synthesizeSpeech({ db, userId: u, ai: g.ai, text: "too long now" }),
    ).rejects.toThrow(/Daily free-voice limit/);
    expect(g.calls).toHaveLength(0);
  });
});
