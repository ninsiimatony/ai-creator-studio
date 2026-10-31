// Minimal D1 typings (avoids a workers-types dependency in the browser build).
export interface D1Result<T = unknown> { results: T[]; success: boolean; meta: Record<string, unknown> }
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

/** Returns the D1 binding, or null when not running inside Cloudflare Workers (Node dev, Lovable preview, tests). */
export async function getDb(): Promise<D1Database | null> {
  try {
    const specifier = "cloudflare:workers";
    const mod = (await import(/* @vite-ignore */ specifier)) as { env?: { DB?: D1Database } };
    return mod.env?.DB ?? null;
  } catch {
    return null;
  }
}
