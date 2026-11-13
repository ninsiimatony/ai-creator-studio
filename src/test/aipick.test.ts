import { describe, it, expect, vi } from "vitest";
import { aiFor, restAi } from "../server/aipick";

describe("aiFor", () => {
  const binding = { run: async () => "binding" };
  const env = { AI: binding, CF_AI_TOKEN_4: "t", CF_ACCOUNT_ID_4: "a" };
  it("uses the binding for other channels", () => {
    expect(aiFor(env, new Request("https://x", { headers: { "x-channel": "2" } }))).toBe(binding);
    expect(aiFor(env, new Request("https://x"))).toBe(binding);
  });
  it("uses REST for channel 4 and falls back without secrets", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { response: "hi" } }), { headers: { "content-type": "application/json" } }));
    const ai = aiFor(env, new Request("https://x", { headers: { "x-channel": "4" } }), f as never)!;
    expect(await ai.run("m", { a: 1 })).toEqual({ response: "hi" });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("/accounts/a/ai/run/m");
    expect(aiFor({ AI: binding }, new Request("https://x", { headers: { "x-channel": "4" } }))).toBe(binding);
  });
  it("throws on REST errors", async () => {
    const f = async () => new Response(JSON.stringify({ success: false, errors: [{ message: "limit" }] }), { status: 429, headers: { "content-type": "application/json" } });
    await expect(restAi("a", "t", f as never).run("m", {})).rejects.toThrow(/429/);
  });
});
