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

## Channel 4 phase 2 — Luganda story + voice (test stage)
- run.mjs: CHANNEL=4 translates the English story into Luganda (Sunbird Sunflower), speaks it with Sunbird's Luganda voice (no English fallback), Luganda title/description/hashtags.
- Channel 4 stays PRIVATE until repo variable CH4_AUTO_PUBLISH=1. Not yet in the daily scheduler (catchup.ts) until Tony approves the test video.
- Telegram: "channel 4" / "luganda" / "night tales" starts a Channel 4 video.

## Channel 4 test #1 feedback fixes
- Pictures: the image maker was being given Luganda text (it cannot read it). Now it gets the English scene text, with a scary rural-Uganda look, and a new picture every 3 scenes (own Cloudflare allowance). Slow zoom kept.
- Sound: Luganda voice is normalised and boosted; music for Channel 4 dropped to 0.07 and uses the scary (ch2) tracks.
- Luganda: English source written in short plain sentences with a Ugandan setting; stricter Sunflower translation prompt, temperature 0.15, 2 scenes per request.

## Channel 4 test #2 findings (black screens) and photo library
- Bug: the Channel 4 picture prompt was longer than the picture maker's 600-character limit, so every AI picture failed and the video had 155 s of black screen. Fixed (prompt capped at 590 characters).
- New: scripts/video-bot/ch4-photos/use = 11 scary Uganda pictures from Tony (2240x1260), used with the slow zoom every other picture, and as the backup whenever the AI picture fails. spare/ = 2 unused (one has text in the image, one is a Western bedroom). assets/night-tales-uganda-logo.png = channel logo from Tony.
- Not done / by design: no automatic ChatGPT picture ordering (needs Tony's login, against ChatGPT's terms to automate). Tony can add new batches to ch4-photos/use.

## Channel 4 test #3 feedback (matching, music, length, thumbnail)
- Pictures now MATCH the story: each scene is tagged man/woman (kept from the scene before when a scene has no he/she). Tony's photos are used only when the scene fits (e.g. woman photos only in stories about a woman; ghost photos only when a ghost/spirit appears); otherwise the AI makes a picture for that exact scene (with the right gender). At most 2 photos in a row.
- Stories: research-based rules (mizimu ghosts, misambwa tree/rock spirits, Walumbe, night dancers; real places Ttanda, Mubende, Kibale, Jinja, Kampala), one named main character per story, gender kept.
- Title: short catchy Luganda title from Sunflower (not a word-for-word translation).
- Sound: scary tracks joined with crossfades + night wind + crickets, music ducks under the voice (sidechain compression).
- Length: Channel 4 videos 10-14 minutes (videoMinutes slot 5). Scheduler not yet switched on for Channel 4.
- Thumbnail: built from Tony's photos with the Luganda title (works once the channel is phone-verified; YouTube refuses custom thumbnails on unverified channels).

## 2026-11-14 — Channel 4 photo library v2 (Leonardo batch)
- Added 12 new horror photos made in Leonardo (single pictures, 16:9, Uganda night/fog): forest red eyes, lantern girl + ghost, giant monster, witch hut, old man + faceless figure, grave ghost, boy under bed, hanging tree, woman at window, man running, well ghost x2.
- Tagged each in `CH4_PHOTOS` (run.mjs) with man/woman rule + keywords. Library now 23 photos. Old photos untouched.
- Not yet tested in a full video run.

## 2026-11-14 — Channel 4 photo library v3 (Ideogram batch, brighter style)
- Added 8 bright, vivid moonlit photos from Ideogram (2560x1440 → 2240x1260): man chased by ghost on village road x4, grandfather telling scary story by the fire with ghost behind children x4.
- Tagged in `CH4_PHOTOS` (man-chased-bright, fireside-story-ghost). Library now 31 photos. Nothing removed.

## 2026-11-14 — Channel 4 photo library v4 (Gemini batch, bright + meaningful)
- Added 13 bright vivid photos from Gemini (1024x572 upscaled to 2240x1260): mother+daughter+ghost, boy in graveyard, woman on banana path, healer hut, boda rider with ghost passenger, girl at well, man with torch in forest, mother cooking with ghost child, student with candle, fisherman on lake, farmer with scarecrow ghost, ghost bride at lake, funeral by the fire.
- Tagged each in `CH4_PHOTOS` with man/woman rule + keywords. Library now 44 photos. Nothing removed.
- Gemini free limit reached (resets 11:12 AM Oman time); 7 more prompts queued for next time.

## 2026-11-14 — Channel 4 added to the automatic schedule
- New slot 5 in catchup.ts: Night Tales Uganda, 1 video a day, starts 18:30 Oman (14:30 UTC), 10-14 minutes, tone scary, channel 4.
- New topic list scripts/video-bot/topics4.json (44 original Uganda night stories: men, women, children, elders).
- Videos stay PRIVATE until Tony sets CH4_AUTO_PUBLISH=1 (he approves first). Watchdog label added.
- Tests: 133 passed.

## 2026-11-14 — Channel 4: 2 videos a day (6 AM and 12 PM Oman)
- Slots 5 and 6: start 05:30 and 11:30 Oman (01:30 and 07:30 UTC), ready about 06:00 and 12:00 Oman. Still private until Tony approves (CH4_AUTO_PUBLISH).

## 2026-11-14 — Channel 4 posts automatically + safer photos
- Tony asked for auto-post: Channel 4 videos now publish by themselves when the quality check is green (a failed check still holds the video private). Set repo variable CH4_AUTO_PUBLISH=0 to hold again.
- Photos with blood/claws (ghost-crawling, woman-fallen-ghost, ghost-over-girl-house, boy-ghost-graveyard) are never thumbnails and are used in videos only when no gentler photo fits (YouTube age-restriction risk). Files kept, nothing deleted.

## 2026-11-14 — Channel 2 also uses the scary photo library
- Little Hope Tales: about 1 picture in 3 may now be one of the realistic scary photos (only if it matches the story, never the bloody ones), mixed with the goblin pictures for more variety. Nothing deleted.

## 2026-11-14 — Channel 4: every story different
- Each Channel 4 video now gets a random hero name (30 men, 30 women), a random place and a random twist, so names, places and plots stop repeating.

## 2026-11-14 — Channel 4 brighter pictures and thumbnails
- Channel 4 video pictures get a brightness/gamma lift (YouTube picks its own frame as thumbnail until the channel is phone-verified, so bright frames matter).
- Channel 4 custom thumbnails (thumb.py) are now brightened (1.12–1.28) instead of darkened (0.55–0.8). Bloody photos stay out of thumbnails (earlier change).

## 2026-11-14 — Photo library v5 (8 new bright Gemini photos)
- Added 46–53: child sleeping with ghost mother, taxi van ghost passenger, haunted tree hands, empty market ghost vendor, healer ritual fire, couple with shadow figure, women washing at river with ghost, schoolboy with shadow monster. Library now 52 photos. Nothing deleted.

## 2026-11-15 — Fix: Night Tales could stop channels 1-3
- Problem: when Channel 4 hit its free AI limit (it has its own Cloudflare account), the robot paused ALL channels, so Channels 1-3 made no videos on 2026-11-14.
- Fix: two separate pauses (pause_dispatch_until for channels 1-3, pause_dispatch_until_ch4 for Channel 4). One no longer stops the other.

## 2026-11-16 — Night Tales: fewer, better videos
- Channel 4 now makes 1 video a day (slot 5, ready 6 AM Oman). Slot 6 (12 PM) switched off. Reason: YouTube's July 2026 policy does not pay for repetitive/mass-produced content.
- Channel 4 uses moving clips (LTX-Video on free Kaggle GPU) mixed with photos by default (LTX_CHANNELS default "4"). If Kaggle fails it falls back to photos automatically. Not yet tested on Channel 4.
- Previous behaviour is in git history (commit before this one).

## 2026-11-16 — Safer for the new YouTube rules (fewer videos, honest titles, more variety)
- Why: YouTube's 2026 rules do not pay for mass-produced, repetitive AI videos. Research report read; channels ranked by risk.
- Channel 1 now posts 4 days a week (Mon, Wed, Fri, Sun), Channel 3 four days (Tue, Thu, Sat, Sun), Channel 4 four days (Mon, Wed, Fri, Sat), Channel 2 stays 3 days (Mon, Wed, Sat). Before: Channels 1, 3 and 4 posted every day. (src/server/catchup.ts: CH1_DAYS, CH3_DAYS, CH4_DAYS). Old version is in git history.
- Titles: `cleanTitle()` in run.mjs removes "true story", "real footage", "caught on camera" and similar claims (our stories are fiction). Used on the outline title and again at upload.
- Music: each video picks a track at random and starts at a random point, so videos do not all begin the same.
- Descriptions already say "original fiction"; unchanged.
- Still needs Tony in YouTube Studio: phone verification, "Not made for kids", AI-made label, accept new YPP terms before 2027-01-31.

## 2026-11-16 — Video descriptions no longer promise "every day"
- Channels now post 3-4 days a week, so the auto descriptions for Channel 1 and 3 say "every week" instead of "every day" (honest metadata, YouTube spam rule).
- Night Tales (Channel 4) got a new no-blood banner (file NightTales_banner_v2_nogore.jpg; old banner kept). Little Hope Tales and Wild Wonders World banners and pictures checked: fine.
- Tony still to edit in Studio: Wild Wonders World channel text/banner say "a new documentary every day"; Little Hope Tales channel text says "a new one every day".

## 2026-11-16 — Thumbnails no longer repeat (Channels 1-3)
- Why: Channel 1 had the same crying-woman picture on two videos and the same shocked-face picture on two others. YouTube treats "same video, new names" as mass-produced.
- Thumbnail style (Tony's face / AI person / scene) now rotates by date instead of random. Library pictures for Channels 1-3 rotate by date (9 pictures = no repeat inside about 9 days). Tony's face never repeats the previous video's face. Channel 4 stays random (52 pictures).
- Only 9 library pictures exist for Channel 1: adding more pictures makes it even safer. Old behaviour is in git history (commit before this one).

## 2026-11-17 — Little Hope Tales video held private: black screen fix
- What happened: the 2026-11-16 23:30 UTC video ("3 Scary Apartment Stories", Channel 2) ran out of the free AI picture allowance part-way, and some scenes got no picture. Result: 66 seconds of black screen in a 21-minute video. The quality check correctly kept it PRIVATE (and its 2 Shorts private). All other videos that day passed the check and were published.
- Fix (run.mjs): on Channel 2, when the picture maker fails, use a gentle (non-bloody) library photo that matches the story instead of leaving the screen black. Before: kept the last picture or showed black. Old version in git history.
- Note: the free AI allowance is shared, so fewer videos per week (see 2026-11-16) also helps.
- Open: that one held video is still private in Studio; Tony decides whether to make it public.

## 2026-11-18 — Night Tales Uganda photo library: 13 new photos (now 65)
- Added photos 54-66 (Gemini, bright, non-gory): maize seller, fisherwoman, sisters braiding, adungu elder, nurse, goat boy, firewood woman, market stall, church, classroom, bicycle repair, grandmother story, dishes woman. Each has a CH4_PHOTOS entry in run.mjs. No existing photos changed.

## 2026-11-19 — Loud-peak fix
- Videos were held private when the final audio peak touched 0 dB ("audio may be clipping"). Added `alimiter=limit=0.89` after loudnorm in both final mixes (run.mjs) so peaks stay under -1 dB.
- Loud-peak and a-bit-quiet audio no longer hold a video private (logged only). Serious problems (policy risk, no sound, black screen, too short) still hold it.
- Held video no longer leaves a gap: when a video is held private (not Ch4 hold), the workflow starts ONE replacement run (retry=1) with the same inputs. Runs are independent, so a held video never blocks later ones. Needs `actions: write` (added).

## 2026-11-23 — Little Hope Tales (channel 2) stays goblin horror
- Problem: the goblin channel made some non-goblin stories (for example "3 Empty Office Stories") and sometimes used Night Tales (Luganda) photos, so the channels looked mixed.
- Fix: new story ideas for channel 2 must feature a goblin (topicgen.ts); built-in channel-2 topics without "goblin" are skipped (catchup.ts); channel 2 never uses ch4-photos (run.mjs), only its own goblin pictures in thumbs/ch2.
- Previous version kept as git tag `v-before-ch2-goblin-fix` (commit 97bbb0f). Old non-goblin topics already stored in the database are not deleted; they are skipped.
- Not yet verified on a real video run.
- 2026-11-24: Night Tales Uganda (ch4) photo library: added 13 new bright scenes (67-79) from Gemini and their CH4_PHOTOS entries; library now 78 photos. No existing photos changed.
- 2026-11-25: Night Tales Uganda (ch4) photo library: added 3 new bright scenes (80-82) from Gemini (tailor mirror spirit, maize roaster spirit, schoolgirls papyrus swamp) with CH4_PHOTOS entries; library now 81 photos. No existing photos changed.
- 2026-11-26: Night Tales Uganda (ch4) photo library: added 12 new bright scenes (83-94: fisherman wife net, borehole queue, cattle herder, mat weaving, chapati stall, salon, roof repair, skipping rope, kite boy, fig tree ceremony, hill path termite mound, cassava farm) from Gemini with CH4_PHOTOS entries; library now 93 photos. No existing photos changed.
- 2026-11-27: Night Tales Uganda (ch4) photo library: added 13 new bright scenes (95-107: barber mirror, tea pickers, charcoal smoke face, marbles, millet pounding, coffee drying, ferry passenger, blacksmith shadow, old couple bench, sugarcane girl, taxi park, dormitory bunk, lullaby crib) from Gemini with CH4_PHOTOS entries; library now 106 photos. No existing photos changed.
- 2026-11-27 (2nd batch): Night Tales Uganda (ch4) photo library: added 10 more bright scenes (108-117: fish smoking, brick wheelbarrow, radio repair, pineapple umbrella, choir, water tank reflection, market bicycle, goat market, matooke steaming, teacher doorway) from Gemini with CH4_PHOTOS entries; library now 116 photos. No existing photos changed.
