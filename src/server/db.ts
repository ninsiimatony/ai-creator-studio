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

/** The subset of the Workers AI binding we use. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type WorkerEnv = {
  DB?: D1Database;
  /** Workers AI binding (free daily allowance). Optional: image/speech providers are off without it. */
  AI?: AiBinding;
  /** Channel 4 only: its own Cloudflare account's Workers AI (REST token with Workers AI permission) and that account's id. */
  CF_AI_TOKEN_4?: string;
  CF_ACCOUNT_ID_4?: string;
  SETUP_CODE?: string;
  ANTHROPIC_API_KEY?: string;
  /** Model for long-form writing (default claude-sonnet-5-5). */
  AI_MODEL_WRITER?: string;
  /** Model for short tasks: ideas, titles, tags, thumbnails (default claude-haiku-5-5). */
  AI_MODEL_FAST?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID_2?: string;
  GOOGLE_CLIENT_SECRET_2?: string;
  /** Optional own Google project for the third channel; when unset it shares the second channel's. */
  GOOGLE_CLIENT_ID_3?: string;
  GOOGLE_CLIENT_SECRET_3?: string;
  /** Base64 of 32 random bytes; encrypts stored Google refresh tokens. */
  TOKEN_ENC_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  /** Free Pixabay API key for automatic stock video clips. */
  PIXABAY_API_KEY?: string;
  /** Free Pexels API key (channel 3 clips). */
  PEXELS_API_KEY?: string;
  /** Telegram bot (chat-to-video). Token from @BotFather; chat id = the owner's chat; webhook secret is random. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Fine-grained GitHub token (Actions: read/write on the repo) used to start the video-making job. */
  GITHUB_TOKEN?: string;
  /** Shared secret the GitHub job uses to call this studio. */
  AUTOMATION_SECRET?: string;
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
