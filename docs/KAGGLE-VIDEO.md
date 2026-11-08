# Optional upgrade: moving clips via Kaggle LTX-Video

Built 2026-11-09. **Off by default.** When off, the daily video pipeline behaves exactly as it
did before this was added — channel 2 still uses still pictures (hand-made library + AI
fallback), channel 1 still uses Pixabay stock clips.

## What it does

Instead of a still picture (channel 2) or a Pixabay stock clip (channel 1), each picture/clip
slot can instead be a short (~3s) AI-generated **moving** clip of the recurring character,
rendered with **LTX-Video** on a free Kaggle GPU. ffmpeg already loops/trims clips to fit each
scene's narration length (`-stream_loop -1 -i clip.mp4 -t <seconds>`), so the clip doesn't need
to match the scene length exactly — the same trick channel 1 already uses with Pixabay clips.

All the clips for one video are generated in a **single Kaggle kernel run** (loads the model
once, then renders one clip per group of 4 narration scenes — the same grouping channel 2
already uses for its picture refreshes). If Kaggle is unreachable, credentials are missing, the
weekly GPU-hour budget would be exceeded, or anything else goes wrong, the whole thing is
skipped and the video is made the normal way — nothing fails or looks broken.

## Turning it on

1. Get a Kaggle API token: kaggle.com → profile picture → Settings → API → **Create New Token**.
   This downloads `kaggle.json` with a `username` and a `key`.
2. In the GitHub repo: Settings → Secrets and variables → Actions:
   - Add secret `KAGGLE_USERNAME` = the username from that file.
   - Add secret `KAGGLE_KEY` = the key from that file.
   - Add **variable** `USE_LTX_VIDEO` = `1`.
3. That's it — the next video (either channel) will use Kaggle clips if the weekly GPU-hour
   budget allows it.

To turn it back off: set the `USE_LTX_VIDEO` variable to `0` (or delete it). No code change
needed.

## Weekly GPU-hour budget

Kaggle's free tier gives ~30 GPU hours/week per account. Usage is tracked server-side (D1 table
`kaggle_usage`, via `/api/automation/kaggle-budget`) and checked before every video — if a video
would push the week over budget, Kaggle is skipped for that video only (falls back to normal).

Rough math at today's settings (one ~3s clip per group of 4 narration scenes, ~2.5 min/clip +
5 min model load per kernel run, ~15 clips for a 10-minute video):

- One 10-min video ≈ 0.7 GPU hours
- 4 videos/day (3 on channel 1 + 1 on channel 2) ≈ 2.8 GPU hours/day ≈ **~20 GPU hours/week**

That leaves roughly 10 hours/week of headroom for manual testing in the separate Goblin Forge
app (github.com/ninsiimatony/screenshot-match), which uses the same Kaggle account/quota.

## Known limitation — not yet tested against live Kaggle

This was built and wired in with the automated pipeline's existing fallback pattern (same shape
as every other external call in `run.mjs` — try it, log the failure, use the normal method), and
checked with `node --check`, `tsc`, `eslint`, and the full test suite. **It has not yet been run
against a real Kaggle account** (no credentials were available while building it), so the exact
Kaggle CLI behaviour (kernel push/poll/output download) should be watched closely the first few
times it runs for real. If it fails outright, the video still completes normally — worst case is
wasted time waiting for the Kaggle poll loop (up to ~3.5h) before it gives up and falls back.

## Files

- `scripts/video-bot/kaggle-ltx.mjs` — the Kaggle integration (push/poll/download via the
  official `kaggle` CLI, budget check, LTX-Video script generation).
- `src/server/kaggle-budget.ts` + `src/routes/api/automation/kaggle-budget.ts` — weekly GPU-hour
  tracking (D1-backed, same pattern as the existing daily AI-image/TTS caps in `src/server/media.ts`).
- `scripts/video-bot/run.mjs` — integration points: a new "1.5" step after script generation, and
  small additions inside the existing per-scene loop (both channels) that check for a Kaggle clip
  before falling through to the existing logic, unchanged.
