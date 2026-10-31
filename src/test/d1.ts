// Test helper: a real (local, in-memory) D1 database from wrangler's platform proxy,
// with the project's migrations applied.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@/server/db";

export async function createTestDb(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.resolve(__dirname, "../../wrangler.jsonc"),
    persist: false,
    // Tests only need the local D1. Skipping remote bindings (Workers AI) keeps them runnable without credentials.
    remoteBindings: false,
  });
  const db = proxy.env.DB;
  const dir = path.resolve(__dirname, "../../migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8").replace(/--.*$/gm, ""); // strip comments (inline ones may contain ';')
    for (const stmt of sql
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
  return { db, dispose: () => proxy.dispose() };
}
