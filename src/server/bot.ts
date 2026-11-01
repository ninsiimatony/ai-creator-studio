// Telegram chat-to-video: parse a chat message into a video request and hand it to the GitHub job.
import { AppError } from "./errors";

export type VideoRequest = { topic: string; minutes: number; style: "real" | "cartoon" };

export const MAX_MINUTES = 90;
export const DEFAULT_MINUTES = 10;

/** "make a 1.5 hour cartoon video about robots" -> { topic: "robots", minutes: 90, style: "cartoon" } */
export function parseVideoRequest(textIn: string): VideoRequest | null {
  let text = textIn.replace(/\s+/g, " ").trim();
  if (!text) return null;
  let minutes = DEFAULT_MINUTES;
  const hours = text.match(/(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|h)\b/i);
  const mins = text.match(/(\d+(?:[.,]\d+)?)\s*(?:minutes?|mins?|m)\b/i);
  if (hours) {
    minutes = Math.round(Number(hours[1]!.replace(",", ".")) * 60);
    text = text.replace(hours[0], " ");
    const extra = text.match(/(\d+)\s*(?:minutes?|mins?|m)\b/i); // "1 hour 30 minutes"
    if (extra) {
      minutes += Number(extra[1]);
      text = text.replace(extra[0], " ");
    }
  } else if (mins) {
    minutes = Math.round(Number(mins[1]!.replace(",", ".")));
    text = text.replace(mins[0], " ");
  }
  minutes = Math.min(MAX_MINUTES, Math.max(3, minutes));
  const style = /\b(cartoon|animation|animated|anime)\b/i.test(text) ? "cartoon" : "real";
  const topic = text
    .replace(/\b(cartoon|animation|animated|anime)\b/gi, " ")
    .replace(/\b(please|generate|make|create|build|produce|post|upload)\b/gi, " ")
    .replace(/^[\s,.:;-]+/, "")
    .replace(/^(?:(?:a|an|the|me|us|for|long|video|videos|youtube|about|on|of)\b[\s,.:;-]*)+/i, "")
    .replace(/[\s,.:;-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const finalTopic = (topic.length >= 3 ? topic : text).slice(0, 500);
  if (finalTopic.length < 3) return null;
  return { topic: finalTopic, minutes, style };
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) }),
  });
  if (!res.ok) console.error("telegram send failed", res.status);
}

/** Starts the video-making GitHub Actions job. */
export async function dispatchVideoJob(p: {
  token: string;
  repo: string;
  ref: string;
  req: VideoRequest;
}): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${p.repo}/actions/workflows/video-bot.yml/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${p.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "tony-ai-youtube-studio",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ref: p.ref,
        inputs: { topic: p.req.topic, minutes: String(p.req.minutes), style: p.req.style },
      }),
    },
  );
  if (res.status !== 204) {
    console.error("github dispatch failed", res.status, (await res.text()).slice(0, 300));
    throw new AppError(
      res.status === 401 || res.status === 403
        ? "GitHub refused the token. Check the GITHUB_TOKEN secret and its Actions permission."
        : res.status === 404
          ? "GitHub could not find the video job. Merge the project into the main branch first."
          : `GitHub returned an error (${res.status}).`,
    );
  }
}
