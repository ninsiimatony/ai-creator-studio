// Minimal D1 typings (avoids a workers-types dependency in the browser build).
export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes?: number; [k: string]: unknown };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export type WorkerEnv = {
  DB?: D1Database;
  SETUP_CODE?: string;
  ANTHROPIC_API_KEY?: string;
  /** Model for long-form writing (default claude-sonnet-5-5). */
  AI_MODEL_WRITER?: string;
  /** Model for short tasks: ideas, titles, tags, thumbnails (default claude-haiku-5-5). */
  AI_MODEL_FAST?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Base64 of 32 random bytes; encrypts stored Google refresh tokens. */
  TOKEN_ENC_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
};

/**
 * Returns the Worker bindings/secrets, or {} when not running inside Cloudflare Workers
 * (plain `vite dev`, Lovable preview, unit tests). Callers treat a missing DB as demo mode.
 */
export async function getEnv(): Promise<WorkerEnv> {
  try {
    const specifier = "cloudflare:workers";
    const mod = (await import(/* @vite-ignore */ specifier)) as { env?: WorkerEnv };
    return mod.env ?? {};
  } catch {
    return {};
  }
}

export async function getDb(): Promise<D1Database | null> {
  return (await getEnv()).DB ?? null;
}
