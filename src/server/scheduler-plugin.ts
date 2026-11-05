import { runCatchup } from "./catchup";
import { runWeeklyReport } from "./growth";

// Nitro plugin: Cloudflare cron ticks run the catch-up check.
export default (nitroApp: { hooks: { hook: (name: string, fn: (ctx: { env: never }) => Promise<void>) => void } }) => {
  nitroApp.hooks.hook("cloudflare:scheduled", async ({ env }) => {
    try {
      console.log("catch-up:", await runCatchup(env));
    } catch (e) {
      console.error("catch-up crashed", e);
    }
    try {
      const r = await runWeeklyReport(env);
      if (r !== "not report time" && r !== "already sent") console.log("weekly report:", r);
    } catch (e) {
      console.error("weekly report crashed", e);
    }
  });
};
