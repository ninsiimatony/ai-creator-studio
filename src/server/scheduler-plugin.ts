import { runCatchup } from "./catchup";
import { runWeeklyReport } from "./growth";
import { refillTopics, refillTopics2 } from "./topicgen";
import { channel2Connected } from "./google2";

// Nitro plugin: Cloudflare cron ticks run the catch-up check.
export default (nitroApp: { hooks: { hook: (name: string, fn: (ctx: { env: never }) => Promise<void>) => void } }) => {
  nitroApp.hooks.hook("cloudflare:scheduled", async ({ env }) => {
    try {
      console.log("catch-up:", await runCatchup(env));
    } catch (e) {
      console.error("catch-up crashed", e);
    }
    try {
      const t = await refillTopics(env);
      if (t !== "already checked" && t !== "enough topics") console.log("topics:", t);
    } catch (e) {
      console.error("topic refill crashed", e);
    }
    try {
      if (env.DB && (await channel2Connected(env.DB))) {
        const t2 = await refillTopics2(env);
        if (t2 !== "already checked" && t2 !== "enough topics") console.log("topics2:", t2);
      }
    } catch (e) {
      console.error("topic refill 2 crashed", e);
    }
    try {
      const r = await runWeeklyReport(env);
      if (r !== "not report time" && r !== "already sent") console.log("weekly report:", r);
    } catch (e) {
      console.error("weekly report crashed", e);
    }
  });
};
