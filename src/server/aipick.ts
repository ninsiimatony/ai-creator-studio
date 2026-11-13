// Picks which Cloudflare account's free Workers AI a request uses.
// Channel 4 (Night Tales Uganda) uses its OWN Cloudflare account (separate free daily allowance) through the REST API.
// Every other channel keeps using the Worker's normal AI binding. Without the channel-4 secrets everything falls back to the binding.
import type { AiBinding, WorkerEnv } from "./db";

type F = typeof fetch;

/** Workers AI over REST, shaped like the binding: run(model, input) returns the model's "result". */
export function restAi(accountId: string, token: string, f: F = fetch): AiBinding {
  return {
    async run(model: string, input: Record<string, unknown>): Promise<unknown> {
      const res = await f(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("application/json")) {
        if (!res.ok) throw new Error(`workers ai rest ${res.status}`);
        return new Uint8Array(await res.arrayBuffer()); // e.g. raw audio
      }
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { message?: string }[] };
      if (!res.ok || json.success === false)
        throw new Error(`workers ai rest ${res.status}: ${String(json.errors?.[0]?.message ?? "").slice(0, 160)}`);
      return json.result;
    },
  };
}

/** The AI to use for a request. The video bot sends the header "x-channel" on every call. */
export function aiFor(env: Pick<WorkerEnv, "AI" | "CF_AI_TOKEN_4" | "CF_ACCOUNT_ID_4">, request: Request, f: F = fetch): AiBinding | undefined {
  const channel = Number(request.headers.get("x-channel") ?? 0);
  if (channel === 4 && env.CF_AI_TOKEN_4 && env.CF_ACCOUNT_ID_4) return restAi(env.CF_ACCOUNT_ID_4, env.CF_AI_TOKEN_4, f);
  return env.AI;
}
