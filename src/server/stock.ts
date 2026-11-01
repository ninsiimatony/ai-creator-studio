// Free stock video clips from Pixabay (https://pixabay.com/api/docs/). The clip is searched from the scene's
// words and proxied through our server so the API key never reaches the browser.
import { AppError } from "./errors";

const STOP = new Set(
  (
    "a about above after again all also an and any are as at be because been before being between both but by " +
    "can could did do does doing down during each few for from further had has have having he her here hers him " +
    "his how i if in into is it its just like make many may me more most much must my no nor not now of off on " +
    "once only or other our out over own same she should so some such than that the their them then there these " +
    "they this those through to too under until up very was we were what when where which while who why will " +
    "with would you your yours first second third every always never really thing things something simple using " +
    "use used then than keep keeps called works work"
  ).split(/\s+/),
);

/** Up to three content words from a scene's text (longer words tend to be the nouns). */
export function stockKeywords(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  return [...words].sort((a, b) => b.length - a.length).slice(0, 3);
}

type Rendition = { url?: string; size?: number };
type Hit = { videos?: { large?: Rendition; medium?: Rendition; small?: Rendition; tiny?: Rendition } };

const MAX_CLIP_BYTES = 30 * 1024 * 1024;

/** Medium (about 1280 wide) when it is not huge, else the next size down. */
export function pickRendition(hit: Hit): string | null {
  const v = hit.videos;
  if (!v) return null;
  for (const r of [v.medium, v.small, v.tiny]) {
    if (r?.url && (r.size === undefined || r.size === 0 || r.size <= MAX_CLIP_BYTES)) return r.url;
  }
  return null;
}

export async function fetchStockClip(p: {
  apiKey: string | undefined;
  text: string;
  index?: number;
  fetcher?: typeof fetch;
}): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!p.apiKey)
    throw new AppError("Stock clips are not connected. Add the PIXABAY_API_KEY secret.");
  const f = p.fetcher ?? fetch;
  const text = p.text.replace(/\s+/g, " ").trim();
  if (!text) throw new AppError("There is no text to search clips for.");
  const kw = stockKeywords(text);
  const queries = [...new Set([kw.join(" "), kw[0] ?? "", "technology"].filter(Boolean))];
  const index = Math.max(0, Math.floor(p.index ?? 0));

  let clipUrl: string | null = null;
  for (const q of queries) {
    const url =
      "https://pixabay.com/api/videos/?" +
      new URLSearchParams({
        key: p.apiKey,
        q: q.slice(0, 100),
        per_page: "20",
        safesearch: "true",
      }).toString();
    let res: Response;
    try {
      // Pixabay asks that API responses are cached for 24 hours.
      res = await f(url, { cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);
    } catch (e) {
      console.error("pixabay search failed", e);
      throw new AppError("Could not reach Pixabay. Please try again.");
    }
    if (res.status === 429)
      throw new AppError("Pixabay says too many requests. Wait one minute and try again.");
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new AppError("Pixabay rejected the API key. Check PIXABAY_API_KEY.");
    if (!res.ok) throw new AppError("Pixabay is not answering right now. Please try again.");
    const json = (await res.json().catch(() => null)) as { hits?: Hit[] } | null;
    const usable = (json?.hits ?? []).filter((h) => pickRendition(h));
    if (usable.length) {
      clipUrl = pickRendition(usable[index % usable.length]!);
      break;
    }
  }
  if (!clipUrl) throw new AppError("No stock clip was found for this scene.");

  let clip: Response;
  try {
    clip = await f(clipUrl);
  } catch (e) {
    console.error("pixabay clip download failed", e);
    throw new AppError("Could not download the stock clip. Please try again.");
  }
  if (!clip.ok) throw new AppError("Could not download the stock clip. Please try again.");
  const len = Number(clip.headers.get("content-length") ?? 0);
  if (len > MAX_CLIP_BYTES) throw new AppError("That stock clip is too large. Please try again.");
  const bytes = new Uint8Array(await clip.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_CLIP_BYTES)
    throw new AppError("The stock clip was empty or too large. Please try again.");
  return { bytes, mime: "video/mp4" };
}
