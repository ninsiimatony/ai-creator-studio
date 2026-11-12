# Changelog — Tony AI YouTube Studio

Older history is kept in git (`git log`). Every change below is a new commit; nothing old was deleted.

## 2026-11-12 — Big upgrade, stage 1 (from the November 2026 research report)

Safety
- Main channel (Channel 1) now posts **1 long video a day** (slot 2, 22:17 UTC) instead of 2. YouTube gives no bonus for more uploads, and several AI stories a day matches the pattern YouTube removed in Jan 2026.
- The "AI-generated" label (`containsSyntheticMedia`) is now set for **any realistic channel** (1 and 3) when AI pictures are used. Cartoon Channel 2 does not need it.
- Video length now changes every day (Channel 1: 8–12 min, Channel 2: 10–15 min, Channel 3: 9–14 min), so videos don't all look cut from one template.

Quality
- New free voice **Kokoro** (Apache-2.0, runs on the runner's CPU, no card). It's first in the voice chain for channels listed in the repo variable `KOKORO_CHANNELS` (default `3`), then edge-tts, Google TTS (if a key exists), then the studio voice. It was tested at about 1.2× real time on 2 CPU cores, so it adds about 8 min per 10-min video. It starts on Channel 3 only to stay inside the private repo's 2,000 free GitHub minutes a month.
- Scripts: about halfway through, each video now ends a section with an open question or tease, to keep viewers for the second half.

Reliability
- All 3 Google apps were moved from "Testing" to "In production", and all 3 channels were reconnected (2026-11-12 03:17–03:30 UTC). Connections no longer expire after 7 days.
- New `/api/auth/google1/start` reconnects the main channel without disconnecting it first.
- Watchdog: the old "will disconnect after 7 days" warning was removed (no longer true). The reconnect link for Channel 1 now uses the new route.
- **Robot alarm:** if a video run on GitHub crashes or is cancelled, Tony gets a Telegram message with the run link.

Not done yet (planned, see the research report): Telegram approve/edit step, CLIP clip matching, native Shorts, auto-dubbing and translated titles, 3-thumbnail generator, backups to Google Drive, smarter analytics loop, weekly long deep-dive for Channel 3. Channel 2's name and positioning review (kids-safety) needs Tony's decision.

## 2026-11-12 — Big upgrade, stage 2

All new steps run after the video is already uploaded and published. If any step fails it only writes a log line, so a video is never lost because of them.
- **Translated titles and descriptions** in Spanish, Portuguese, Hindi, Indonesian, Arabic and French (free Workers AI `m2m100` model, new endpoint `/api/automation/translate`). Viewers in those countries see the video in their own language.
- **Series playlist** per channel, created automatically the first time: "Tony Ninsiima - Full Stories", "Little Hope Tales - Scary Stories", "Wild Wonders - Full Documentaries".
- **Full English subtitles** uploaded for every long video (`captions.insert`), timed from each scene's narration.
- **Shorts:** each Short gets its own vertical picture (custom Shorts thumbnails, Nov 2026) and a comment from the channel linking to the full video. The API can't pin comments.
- **Backup recipe:** title, script scenes, voice, sources, description and tags of every video are kept 90 days as a GitHub artifact (`recipe-<run id>`), so any video can be rebuilt.
- Code: new `scripts/video-bot/extras.mjs` (tested offline with a fake YouTube), `src/server/translate.ts`.
