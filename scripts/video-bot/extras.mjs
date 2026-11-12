// Extra YouTube steps after a video is uploaded (Nov 2026 upgrade, stage 2).
// Every step here is optional: if one fails it only logs a line, and the video stays published as normal.
// Quota cost per long video: localizations 50 + playlist ~51 (+50 once to create) + captions 400 = about 500 of 10,000/day.

const YT = "https://www.googleapis.com/youtube/v3";

/** Languages for translated titles/descriptions: big YouTube audiences the m2m100 model handles well. */
export const LANGS = ["es", "pt", "hi", "id", "ar", "fr"];

/** One SRT file for the whole video, from each scene's start time, length and narration. */
export function fullSrt(parts) {
  const p2 = (n, l = 2) => String(n).padStart(l, "0");
  const ts = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${p2(ms % 1000, 3)}`;
  };
  const cues = [];
  for (const { start, dur, narration } of parts) {
    const words = String(narration).split(/\s+/).filter(Boolean);
    const chunks = [];
    for (let i = 0; i < words.length; i += 9) chunks.push(words.slice(i, i + 9).join(" "));
    const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
    const span = Math.max(0.5, dur - 0.5);
    let t = start + 0.1;
    for (const c of chunks) {
      const len = (c.length / total) * span;
      cues.push([t, t + len, c]);
      t += len;
    }
  }
  return cues.map(([a, b, c], i) => `${i + 1}\n${ts(a)} --> ${ts(b)}\n${c}\n`).join("\n");
}

export function makeExtras({ token, studio, log }) {
  async function api(method, url, body, headers = {}) {
    const accessToken = await token();
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body && !headers["content-type"] ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  /** Adds translated titles/descriptions so YouTube can show the video in more countries. */
  async function localize(videoId, title, hook) {
    try {
      const r = await studio("/api/automation/translate", { texts: [title.slice(0, 300), hook.slice(0, 600)], langs: LANGS });
      const tr = r.translations || {};
      const cur = await api("GET", `${YT}/videos?part=snippet&id=${videoId}`);
      const sn = cur.items?.[0]?.snippet;
      if (!sn) throw new Error("video not found");
      const localizations = { en: { title: sn.title, description: sn.description } };
      for (const [lang, [t, h]] of Object.entries(tr)) {
        if (!t || !h) continue;
        localizations[lang] = { title: t.replace(/[<>]/g, "").slice(0, 100), description: `${h.replace(/[<>]/g, "")}\n\n${sn.description}`.slice(0, 4900) };
      }
      const n = Object.keys(localizations).length - 1;
      if (!n) throw new Error("no translations came back");
      await api("PUT", `${YT}/videos?part=snippet,localizations`, {
        id: videoId,
        snippet: { title: sn.title, description: sn.description, tags: sn.tags ?? [], categoryId: sn.categoryId, defaultLanguage: "en", defaultAudioLanguage: "en" },
        localizations,
      });
      log("Translated title/description added:", n, "languages");
    } catch (e) {
      log("translations skipped:", String(e.message).slice(0, 160));
    }
  }

  /** Puts the video in the channel's series playlist (made once, automatically). */
  async function addToPlaylist(videoId, name, about) {
    try {
      let id = null;
      let page = "";
      for (let i = 0; i < 4 && !id; i++) {
        const r = await api("GET", `${YT}/playlists?part=snippet&mine=true&maxResults=50${page ? `&pageToken=${page}` : ""}`);
        id = (r.items || []).find((p) => p.snippet?.title === name)?.id ?? null;
        page = r.nextPageToken || "";
        if (!page) break;
      }
      if (!id) {
        const made = await api("POST", `${YT}/playlists?part=snippet,status`, { snippet: { title: name, description: about, defaultLanguage: "en" }, status: { privacyStatus: "public" } });
        id = made.id;
        log("Created playlist:", name);
      }
      await api("POST", `${YT}/playlistItems?part=snippet`, { snippet: { playlistId: id, resourceId: { kind: "youtube#video", videoId } } });
      log("Added to playlist:", name);
    } catch (e) {
      log("playlist skipped:", String(e.message).slice(0, 160));
    }
  }

  /** Uploads full English subtitles (helps search and viewers watching without sound). */
  async function uploadCaptions(videoId, srt) {
    try {
      const boundary = "tonyai" + Date.now();
      const meta = JSON.stringify({ snippet: { videoId, language: "en", name: "English", isDraft: false } });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/x-subrip\r\n\r\n${srt}\r\n--${boundary}--`;
      await api("POST", `https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart`, body, { "content-type": `multipart/related; boundary=${boundary}` });
      log("Subtitles uploaded");
    } catch (e) {
      log("subtitles skipped:", String(e.message).slice(0, 160));
    }
  }

  /** Posts a comment from the channel on a Short, linking to the full video. (The API cannot pin it.) */
  async function commentLink(videoId, text) {
    try {
      await api("POST", `${YT}/commentThreads?part=snippet`, { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } });
      log("Link comment posted on the Short");
    } catch (e) {
      log("short comment skipped:", String(e.message).slice(0, 160));
    }
  }

  return { localize, addToPlaylist, uploadCaptions, commentLink };
}
