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

## 2026-11-12 — Channel 2 new format (inspired by scary-story compilation channels)

Tony asked for Channel 2 to work like big scary-story channels (e.g. Mr. Nightmare), but honest: our stories are fiction.
- **Format:** every video is now **3 separate, original, first-person scary stories on one everyday theme** (night shift, camping, home alone...), each scarier than the last. Titles look like "3 Scary Night Shift Stories". The words True, Real, Actual and Based On are never used, and the description says the stories are fiction.
- **Length and schedule:** 22–28 minutes, **3 videos a week** (Monday, Wednesday and Saturday at 23:17 UTC, so they go live early Tuesday, Thursday and Sunday in Oman). Before this it was 10–15 minutes every day.
- **Look:** the cartoon goblin is gone. Pictures and thumbnails are now **dark, real-looking night photos** (cabins, motels, roads, forests, no faces). The old cartoon picture library is no longer used. If the picture maker fails, the last picture is kept.
- **Safety:** for teens and adults, never "made for kids" (also removes the kids-cartoon risk the research flagged). The AI label is on, because the AI pictures look realistic.
- **Story ideas (DNA):** new themes, fears, narrators and twists for 3-story episodes. The 10 unused goblin topics were marked as archived (`used = 2`), not deleted.
- The old goblin code, prompts and picture library are kept in git history and in the repo (`scenes/`, `thumbs/ch2`).

## 2026-11-12 — Fix: Channel 3 on the "Make videos public" page
- The one-tap publish page (`/go-public`) only showed Channels 1 and 2. It now lists **Wild Wonders World** too: its private videos, the Make public button, and a reconnect link. Its API also accepts channel 3, and publishing keeps the video's AI label.

## 2026-11-12 — Fixes found by the Channel 2 test video
A private test video ("3 Scary Night Shift Stories", 18 min) proved the new format works: right title, 3 stories, playlist created, 2 Shorts and the recipe backup. It also found:
- **Free Workers AI allowance used up for the day** (it resets at 00:00 UTC): pictures, thumbnail, policy check and translations failed. Added a **pause switch** (`app_notes.pause_dispatch_until`). The catch-up starts no new videos until that time. It's set to 2026-11-13 00:10 UTC, so today's Channel 3 and Channel 1 videos are skipped cleanly instead of failing 3 times. The test video stayed private (not published) because the checks were not green.
- **Subtitles and Short link comments returned 403:** YouTube needs the `youtube.force-ssl` permission for them. It was added to the scopes, and all 3 channels were reconnected.
- Lesson: a 25-min Channel 2 video uses about 2.5× the AI of a 10-min video. Keep extra manual test runs away from posting days.

## 2026-11-12 — Save the free daily AI allowance
- Channel 2 makes a new picture every 6 scenes instead of every 4 (about 12 pictures instead of 18 in a 25-min video). Each picture slowly zooms, so it still moves.
- After Workers AI says the allowance is used up, the bot stops asking for more pictures in that run and reuses the last one (no more 3× retries per picture).
- Translated titles and descriptions now run on **Channel 3 only**, the most international channel.
- **Auto-pause:** if a video fails because the free AI allowance is used up, the bot calls the new `/api/automation/pause`. No new videos start until 00:10 UTC (04:10 Oman, just after the reset), and Tony gets one calm Telegram message instead of 3 failure alarms.
- Hashtags for Channel 2 no longer include the old #goblin and #animatedhorror.

## 2026-11-13 — Fix: silent stop while the Kokoro voice loads
- Channel 3's video (run 43492872858) wrote the script, then the bot quietly ended with "success" and no video. Cause: the Kokoro helper process was set to not keep the bot alive, so while the bot waited for the voice model to load, nothing kept it running and it exited with code 0.
- Fix: a keep-alive timer while waiting for Kokoro, plus a 4-minute limit. If Kokoro isn't ready the bot logs it and uses the next voice (edge-tts).
- Two more Kokoro bugs found by the re-run and fixed: (1) the voice file was saved without a format (name ends in .bin), so Kokoro always failed and the bot used the backup voice; now saved as WAV. (2) A crash at the very end when the helper closed (a null check), which stopped the video before upload.
- Auto-publish: the black-screen limit that holds a video back as private was raised from 8 to 30 seconds (a normal 11-min video had 10 s of black and stayed private, so it did not go public by itself).

## 2026-11-14 — Channel 4 "Night Tales Uganda" (phase 1: connection)
- New YouTube channel **Night Tales Uganda** (@NightTalesUganda, Luganda scary stories) created. It is slot 4 in `extra_channels` and shares the second channel's Google project (In production).
- New login link `/api/auth/google4/start`; the Google callback, YouTube token route, one-tap publish page (`/go-public`) and the watchdog now include channel 4.
- Still to do (phases 2 and 3): Luganda scripts (Sunbird Sunflower) and voice (Sunbird TTS), schedule and style, and a separate Cloudflare account for its AI.

## Channel 4 phase 3 — separate Cloudflare AI
- New src/server/aipick.ts: Channel 4 AI calls go to its own Cloudflare account (REST, CF_AI_TOKEN_4 + CF_ACCOUNT_ID_4); other channels unchanged.
- Video bot sends x-channel header; run.mjs accepts CHANNEL=4. deploy.yml sets the two Worker secrets.
