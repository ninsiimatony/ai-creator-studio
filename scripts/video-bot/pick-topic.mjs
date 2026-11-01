// Picks today's emotional story topic for the scheduled runs (3 per day, rotating through topics.json).
import { readFile } from "node:fs/promises";
const topics = JSON.parse(await readFile(new URL("./topics.json", import.meta.url), "utf8"));
const now = new Date();
const day = Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
const slot = Math.min(2, Math.floor(now.getUTCHours() / 8));
const topic = topics[(day * 3 + slot) % topics.length];
console.log(`TOPIC=${topic}`);
console.log("MINUTES=10");
console.log("STYLE=real");
console.log("TONE=emotional");
