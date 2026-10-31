// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIP_PROVIDERS,
  IMAGE_PROVIDERS,
  MUSIC_PROVIDERS,
  VOICE_PROVIDERS,
  describeProviders,
  findProvider,
  type MediaEnv,
} from "@/render/providers";
import { elevenLabsVoice, workersAiVoice } from "@/render/providers/voices";
import { titleCardImage, workersAiImage } from "@/render/providers/images";
import { postForBlob } from "@/render/providers/http";

const env = (over: Partial<MediaEnv> = {}): MediaEnv => ({
  server: true,
  elevenlabs: false,
  workersAi: false,
  ...over,
});
afterEach(() => vi.unstubAllGlobals());

describe("provider availability is honest", () => {
  it("title cards and generated music always work, with no server and no keys", () => {
    for (const e of [env({ server: false }), env()]) {
      expect(titleCardImage.availability(e)).toEqual({ ok: true });
      for (const m of MUSIC_PROVIDERS) expect(m.availability(e)).toEqual({ ok: true });
    }
  });

  it("server providers say exactly why they cannot be used", () => {
    const demo = elevenLabsVoice.availability(env({ server: false }));
    expect(demo.ok).toBe(false);
    expect(demo.ok === false && demo.reason).toMatch(/demo mode/);
    const noKey = elevenLabsVoice.availability(env());
    expect(noKey.ok === false && noKey.reason).toMatch(/ELEVENLABS_API_KEY/);
    expect(elevenLabsVoice.availability(env({ elevenlabs: true }))).toEqual({ ok: true });

    const noAi = workersAiVoice.availability(env());
    expect(noAi.ok === false && noAi.reason).toMatch(/Workers AI binding/);
    expect(workersAiVoice.availability(env({ workersAi: true }))).toEqual({ ok: true });
    expect(workersAiImage.availability(env({ workersAi: true }))).toEqual({ ok: true });
    expect(workersAiImage.availability(env()).ok).toBe(false);
  });

  it("AI video generators are listed but never connected, and refuse rather than fake output", async () => {
    expect(CLIP_PROVIDERS.length).toBeGreaterThan(0);
    for (const p of CLIP_PROVIDERS) {
      expect(p.availability(env({ elevenlabs: true, workersAi: true })).ok).toBe(false);
      expect(p.cost).toMatch(/Paid/);
      await expect(
        p.generate({ prompt: "x", seconds: 5, width: 1920, height: 1080 }),
      ).rejects.toThrow(/not connected/i);
    }
  });

  it("describes every provider of a kind with its availability, and finds them by id", () => {
    const rows = describeProviders(VOICE_PROVIDERS, env({ workersAi: true }));
    expect(rows.map((r) => r.id)).toEqual(["workers-ai-melotts", "elevenlabs"]);
    expect(rows[0]!.availability.ok).toBe(true);
    expect(rows[1]!.availability.ok).toBe(false);
    expect(findProvider(IMAGE_PROVIDERS, "title-card")).toBe(titleCardImage);
    expect(findProvider(IMAGE_PROVIDERS, "nope")).toBeUndefined();
    // Every provider states its cost, so there are no surprises.
    for (const list of [VOICE_PROVIDERS, IMAGE_PROVIDERS, CLIP_PROVIDERS, MUSIC_PROVIDERS]) {
      for (const p of list) expect(p.cost.length).toBeGreaterThan(3);
    }
  });
});

describe("HTTP adapters", () => {
  const stubFetch = (res: Response) => {
    const f = vi.fn(async () => res);
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("voice providers post the text (and voice id) to our own endpoints and return the audio bytes", async () => {
    const f1 = stubFetch(new Response(new Uint8Array([1, 2, 3])));
    const a = await elevenLabsVoice.synthesize("Hello there", { voiceId: "voice_abc123" });
    expect(new Uint8Array(a)).toEqual(new Uint8Array([1, 2, 3]));
    const [url1, init1] = f1.mock.calls[0] as unknown as [string, RequestInit];
    expect(url1).toBe("/api/voiceover");
    expect(JSON.parse(String(init1.body))).toEqual({
      text: "Hello there",
      voiceId: "voice_abc123",
    });

    const f2 = stubFetch(new Response(new Uint8Array([9])));
    await workersAiVoice.synthesize("Hi", {});
    const [url2, init2] = f2.mock.calls[0] as unknown as [string, RequestInit];
    expect(url2).toBe("/api/media/tts");
    expect(JSON.parse(String(init2.body))).toEqual({ text: "Hi", lang: "en" });
    // The voice id is omitted when none is chosen.
    stubFetch(new Response(new Uint8Array([1])));
    const f3 = stubFetch(new Response(new Uint8Array([1])));
    await elevenLabsVoice.synthesize("x", {});
    expect(
      JSON.parse(String((f3.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toEqual({ text: "x" });
  });

  it("surfaces the server's error message, and a safe fallback when there is none", async () => {
    stubFetch(Response.json({ error: "Daily free-voice limit reached." }, { status: 400 }));
    await expect(postForBlob("/x", {})).rejects.toThrow("Daily free-voice limit reached.");
    stubFetch(new Response("not json", { status: 502 }));
    await expect(postForBlob("/x", {})).rejects.toThrow(/\(502\)/);
  });
});
