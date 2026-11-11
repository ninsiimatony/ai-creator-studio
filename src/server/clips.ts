// Channel 3 ("wonder" documentary channel): free, licence-safe video clips from several public sources.
//   Pexels, Pixabay   - free stock footage with an API key (commercial use allowed, no credit needed)
//   NASA              - NASA Image and Video Library (NASA media is generally not copyrighted)
//   Internet Archive  - only Prelinger films whose licence mark says public domain / CC0
//   Wikimedia Commons - only files marked CC0 / public domain (no credit needed)
// The scene's search words decide which source is tried first (space -> NASA, old/history -> Internet Archive),
// otherwise sources rotate so videos do not all look alike. Used clips are remembered by the caller (exclude list).
import { AppError } from "./errors";
import { stockKeywords } from "./stock";

export type DocSource = "pexels" | "pixabay" | "nasa" | "archive" | "wikimedia";
export type DocClip = { bytes: Uint8Array; mime: string; key: string; source: DocSource; credit: string };

type F = typeof fetch;
/** One possible clip. `urls` is resolved lazily (NASA / Internet Archive need a second request). */
type Cand = { key: string; source: DocSource; credit: string; mime: string; urls: () => Promise<string[]> };

const MAX_BYTES = 30 * 1024 * 1024;
const UA = "tony-ai-youtube-studio/1.0 (https://youtube-automation-platform.ninsiimatony.workers.dev)";
const SUBREQUEST_BUDGET = 40; // a Worker may only make a limited number of outgoing requests per call

export const SOURCE_NAMES: Record<DocSource, string> = {
  pexels: "Pexels (https://www.pexels.com)",
  pixabay: "Pixabay (https://pixabay.com)",
  nasa: "NASA Image and Video Library (https://images.nasa.gov)",
  archive: "Internet Archive, public-domain films (https://archive.org)",
  wikimedia: "Wikimedia Commons, public-domain files (https://commons.wikimedia.org)",
};

const j = async <T>(res: Response): Promise<T | null> => (await res.json().catch(() => null)) as T | null;
const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

// ---------- Pexels ----------
type PexelsFile = { width?: number; link?: string; file_type?: string };
async function searchPexels(key: string | undefined, q: string, f: F): Promise<Cand[]> {
  if (!key) return [];
  const res = await f(`https://api.pexels.com/videos/search?${new URLSearchParams({ query: q, per_page: "15", orientation: "landscape" })}`, {
    headers: { Authorization: key, "user-agent": UA },
  });
  if (!res.ok) return [];
  const data = await j<{ videos?: { id: number; user?: { name?: string }; video_files?: PexelsFile[] }[] }>(res);
  const out: Cand[] = [];
  for (const v of data?.videos ?? []) {
    const files = (v.video_files ?? []).filter((x) => x.link && (x.file_type ?? "video/mp4") === "video/mp4" && (x.width ?? 0) >= 640);
    // Closest to 1280 wide first (good quality, small file), then smaller ones as fall-backs.
    files.sort((a, b) => Math.abs((a.width ?? 0) - 1280) - Math.abs((b.width ?? 0) - 1280));
    if (!files.length) continue;
    out.push({
      key: `pexels:${v.id}`,
      source: "pexels",
      credit: `Pexels${v.user?.name ? ` / ${v.user.name}` : ""}`,
      mime: "video/mp4",
      urls: async () => files.slice(0, 3).map((x) => x.link!),
    });
  }
  return out;
}

// ---------- Pixabay ----------
type PxRendition = { url?: string; size?: number };
async function searchPixabay(key: string | undefined, q: string, f: F): Promise<Cand[]> {
  if (!key) return [];
  const res = await f(`https://pixabay.com/api/videos/?${new URLSearchParams({ key, q: q.slice(0, 100), per_page: "20", safesearch: "true" })}`, {
    cf: { cacheTtl: 86400, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) return [];
  const data = await j<{ hits?: { id?: number; user?: string; videos?: { medium?: PxRendition; small?: PxRendition; tiny?: PxRendition } }[] }>(res);
  const out: Cand[] = [];
  for (const h of data?.hits ?? []) {
    if (h.id === undefined) continue;
    const urls = [h.videos?.medium, h.videos?.small, h.videos?.tiny].filter((r) => r?.url && (!r.size || r.size <= MAX_BYTES)).map((r) => r!.url!);
    if (!urls.length) continue;
    out.push({ key: `pixabay:${h.id}`, source: "pixabay", credit: `Pixabay${h.user ? ` / ${h.user}` : ""}`, mime: "video/mp4", urls: async () => urls });
  }
  return out;
}

// ---------- NASA ----------
async function searchNasa(q: string, f: F): Promise<Cand[]> {
  const res = await f(`https://images-api.nasa.gov/search?${new URLSearchParams({ q, media_type: "video" })}`, { headers: { "user-agent": UA } });
  if (!res.ok) return [];
  const data = await j<{ collection?: { items?: { href?: string; data?: { nasa_id?: string; title?: string }[] }[] } }>(res);
  const out: Cand[] = [];
  for (const it of (data?.collection?.items ?? []).slice(0, 12)) {
    const id = it.data?.[0]?.nasa_id;
    const href = it.href;
    if (!id || !href) continue;
    out.push({
      key: `nasa:${id}`,
      source: "nasa",
      credit: "NASA",
      mime: "video/mp4",
      urls: async () => {
        const r = await f(href.replace(/^http:/, "https:"), { headers: { "user-agent": UA } });
        if (!r.ok) return [];
        const files = (await j<string[]>(r)) ?? [];
        const mp4 = files.filter((u) => /\.mp4$/i.test(u) && !/~orig/i.test(u)).map((u) => u.replace(/^http:/, "https:"));
        const rank = (u: string) => (/~medium/i.test(u) ? 0 : /~mobile/i.test(u) ? 1 : /~small/i.test(u) ? 2 : 3);
        return mp4.sort((a, b) => rank(a) - rank(b)).slice(0, 3);
      },
    });
  }
  return out;
}

// ---------- Internet Archive (Prelinger films that carry a public-domain mark only) ----------
export const isPublicDomainUrl = (u: string) => /creativecommons\.org\/(publicdomain|licenses\/publicdomain)|publicdomain/i.test(u);
async function searchArchive(q: string, f: F): Promise<Cand[]> {
  const params = new URLSearchParams({ q: `(${q}) AND mediatype:movies AND collection:prelinger`, rows: "12", output: "json" });
  params.append("fl[]", "identifier");
  const res = await f(`https://archive.org/advancedsearch.php?${params}`, { headers: { "user-agent": UA } });
  if (!res.ok) return [];
  const data = await j<{ response?: { docs?: { identifier?: string }[] } }>(res);
  const out: Cand[] = [];
  for (const d of data?.response?.docs ?? []) {
    const id = d.identifier;
    if (!id) continue;
    out.push({
      key: `archive:${id}`,
      source: "archive",
      credit: "Internet Archive (public domain)",
      mime: "video/mp4",
      urls: async () => {
        const r = await f(`https://archive.org/metadata/${encodeURIComponent(id)}`, { headers: { "user-agent": UA } });
        if (!r.ok) return [];
        const meta = await j<{ metadata?: { licenseurl?: string }; files?: { name?: string; format?: string; size?: string }[] }>(r);
        // Not every Prelinger film is public domain: only items carrying a public-domain / CC0 mark are used.
        if (!isPublicDomainUrl(meta?.metadata?.licenseurl ?? "")) return [];
        const mp4 = (meta?.files ?? [])
          .filter((x) => x.name && /MPEG4|h\.264/i.test(x.format ?? "") && /\.mp4$/i.test(x.name) && Number(x.size ?? 0) > 0 && Number(x.size) <= MAX_BYTES)
          .sort((a, b) => Number(b.size) - Number(a.size)); // biggest that still fits = best quality
        return mp4.slice(0, 2).map((x) => `https://archive.org/download/${encodeURIComponent(id)}/${x.name!.split("/").map(encodeURIComponent).join("/")}`);
      },
    });
  }
  return out;
}

// ---------- Wikimedia Commons (CC0 / public domain only) ----------
type WmInfo = { url?: string; size?: number; mime?: string; extmetadata?: Record<string, { value?: string } | undefined> };
export const isFreeLicence = (s: string) => /^(cc0|cc[- ]?zero|pd\b|public domain)/i.test(s.trim());
async function searchWikimedia(q: string, f: F): Promise<Cand[]> {
  const params = new URLSearchParams({
    action: "query", format: "json", origin: "*", generator: "search", gsrsearch: `filetype:video ${q}`, gsrnamespace: "6", gsrlimit: "15",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata",
  });
  const res = await f(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "user-agent": UA } });
  if (!res.ok) return [];
  const data = await j<{ query?: { pages?: Record<string, { pageid?: number; imageinfo?: WmInfo[] }> } }>(res);
  const out: Cand[] = [];
  for (const page of Object.values(data?.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    if (!info?.url || !page.pageid) continue;
    if (!/^video\/(webm|mp4|ogg)/i.test(info.mime ?? "") || (info.size ?? 0) > MAX_BYTES) continue;
    const lic = info.extmetadata?.["LicenseShortName"]?.value ?? "";
    if (!isFreeLicence(lic)) continue; // only CC0 / public domain: no credit needed
    const url = info.url;
    out.push({ key: `wikimedia:${page.pageid}`, source: "wikimedia", credit: "Wikimedia Commons (public domain)", mime: info.mime ?? "video/webm", urls: async () => [url] });
  }
  return out;
}

// ---------- choosing and downloading ----------
const SPACE = /\b(space|planet|moon|lunar|star|stars|galaxy|rocket|astronaut|orbit|mars|jupiter|saturn|sun|solar|nebula|satellite|telescope|cosmos|comet|eclipse)\b/i;
const OLD = /\b(old|vintage|history|historic|ancient|retro|century|1[0-9]{3}|war|past|classic)\b/i;

/** Which sources to try, in order, for this scene. */
export function sourceOrder(text: string, index: number): DocSource[] {
  if (SPACE.test(text)) return ["nasa", "pexels", "pixabay", "wikimedia", "archive"];
  if (OLD.test(text)) return ["archive", "wikimedia", "pexels", "pixabay", "nasa"];
  const base: DocSource[] = index % 2 === 0 ? ["pexels", "pixabay"] : ["pixabay", "pexels"];
  // Now and then start with a public-domain source so the video has a different look.
  // Old public-domain films (Internet Archive) are only used for history topics:
  // for nature topics they pulled in unrelated people, so they are left out here.
  if (index % 7 === 3) return ["wikimedia", ...base, "nasa"];
  return [...base, "wikimedia", "nasa"];
}

async function download(urls: string[], f: F): Promise<{ bytes: Uint8Array; url: string } | null> {
  for (const url of urls) {
    try {
      const r = await f(url, { headers: { "user-agent": UA } });
      if (!r.ok) continue;
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) {
        await r.body?.cancel().catch(() => {});
        continue;
      }
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 2000 && bytes.length <= MAX_BYTES) return { bytes, url };
    } catch {
      /* try the next file */
    }
  }
  return null;
}

export async function fetchDocClip(p: {
  pexelsKey: string | undefined;
  pixabayKey: string | undefined;
  text: string;
  query?: string;
  index?: number;
  /** Keys ("pexels:123") of clips earlier videos used. */
  exclude?: string[];
  fetcher?: F;
}): Promise<DocClip> {
  const base = p.fetcher ?? fetch;
  let used = 0;
  const f: F = (input, init) => {
    if (++used > SUBREQUEST_BUDGET) throw new AppError("Too many clip lookups for one scene.");
    return base(input, init);
  };
  const text = p.text.replace(/\s+/g, " ").trim();
  if (!text) throw new AppError("There is no text to search clips for.");
  const own = (p.query ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const kw = stockKeywords(text);
  const queries = [...new Set([own, own.split(" ").slice(0, 2).join(" "), kw.join(" "), kw[0] ?? ""].filter(Boolean))];
  const index = Math.max(0, Math.floor(p.index ?? 0));
  const skip = new Set(p.exclude ?? []);
  const order = sourceOrder(`${own} ${text}`, index);

  const search = (s: DocSource, q: string): Promise<Cand[]> =>
    s === "pexels" ? searchPexels(p.pexelsKey, q, f)
    : s === "pixabay" ? searchPixabay(p.pixabayKey, q, f)
    : s === "nasa" ? searchNasa(q, f)
    : s === "archive" ? searchArchive(q, f)
    : searchWikimedia(q, f);

  for (const q of queries) {
    for (const s of order) {
      let cands: Cand[] = [];
      try {
        cands = await search(s, q);
      } catch (e) {
        if (e instanceof AppError) throw e;
        cands = [];
      }
      const fresh = cands.filter((c) => !skip.has(c.key));
      if (!fresh.length) continue;
      for (let k = 0; k < Math.min(3, fresh.length); k++) {
        const c = fresh[(index + k) % fresh.length]!;
        let urls: string[] = [];
        try {
          urls = await c.urls();
        } catch (e) {
          if (e instanceof AppError) throw e;
        }
        const got = urls.length ? await download(urls, f) : null;
        if (got) return { bytes: got.bytes, mime: /\.webm(\?|$)/i.test(got.url) ? "video/webm" : c.mime, key: c.key, source: c.source, credit: c.credit };
      }
    }
  }
  throw new AppError("No free clip was found for this scene.");
}

/** Description line that names the sources actually used (good practice even where no credit is required). */
export function sourcesLine(sources: Iterable<string>): string {
  const names = [...new Set(sources)].filter((s): s is DocSource => s in SOURCE_NAMES).map((s) => SOURCE_NAMES[s]);
  return names.length ? `Footage: ${names.join("; ")}.` : "";
}
