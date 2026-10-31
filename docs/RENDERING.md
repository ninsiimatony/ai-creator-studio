# Video rendering

The renderer turns a script into a finished MP4 **inside the user's browser** (WebCodecs + an MP4 muxer).
That is deliberate: Cloudflare Workers cannot run ffmpeg, a server renderer would cost money and hit CPU limits,
and a browser renderer is free and keeps raw media off the server.

```
script ──► scenes (storyboard or auto-split) ──► per-scene voiceover ──► exact timeline
                                  │                                          │
                                  └──► per-scene visual ─────────────────────┤
                                                              music + ducking ┤
                                                    subtitles (SRT/VTT/burn-in) ──► MP4
```

## How voice and picture stay in sync

Every scene is voiced **separately**, so a scene lasts exactly as long as its audio (plus a short lead-in and
tail). There is no estimating of speech timing. Transitions overlap scenes but never overlap speech. Subtitles are
timed inside each scene's real voice window, split into phrases in proportion to their length: exact to the scene,
a close estimate within it (it is not word-level forced alignment).

## What is connected

| Capability     | Provider                                           | Cost                                                                        | Status                                                                                 |
| -------------- | -------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Visuals        | Title cards (generated gradient + text)            | Free                                                                        | Works everywhere, no network                                                           |
| Visuals        | Cloudflare **FLUX-1-schnell** AI images            | Free daily allowance (~43 of 10,000 free neurons per image; app cap 60/day) | Needs the Workers AI binding; **live call unverified** (tested against a fake binding) |
| Visuals        | Your own images and **video clips** (per scene)    | Free                                                                        | Works; clips are seeked frame by frame                                                 |
| Voice          | Cloudflare **MeloTTS**                             | Free daily allowance (app cap 40,000 chars/day)                             | Needs the Workers AI binding; **live call unverified**                                 |
| Voice          | **ElevenLabs**                                     | Your own ElevenLabs credits (app cap 40,000 chars/day)                      | Needs `ELEVENLABS_API_KEY`; **live call unverified**                                   |
| Voice          | None                                               | Free                                                                        | Scenes timed by reading pace (150 wpm)                                                 |
| Music          | Generated ambient pad (royalty-free, from code)    | Free                                                                        | Works everywhere                                                                       |
| Music          | Your own track                                     | Free                                                                        | Works (you need the rights)                                                            |
| AI video clips | Cloudflare video models (PixVerse, Veo, Seedance…) | **Paid per second**                                                         | **Not connected** on purpose; listed with its cost                                     |

Transitions: crossfade, dip to black, slide left/right, zoom, wipe, cut. Ken Burns motion on images.
Formats: 1080p, 720p, 1440p, and 9:16 Shorts; 30 fps; bitrates follow YouTube's recommendations.

## Adding a provider

Implement one interface in `src/render/providers/types.ts` (`VoiceProvider`, `ImageProvider`, `ClipProvider`,
`MusicProvider`) and add it to the list in its file. `availability()` must say plainly why it cannot be used;
unconnected providers must throw rather than produce fake output. The UI and renderer need no other change.
Keep API keys on the server (see `src/server/media.ts` and `src/routes/api/media/*` for the pattern).

## Output format and known limits

- The MP4 is **H.264 + AAC** (YouTube's recommendation) when the browser can encode AAC (current Chrome, Edge and
  Safari on a computer). Where it cannot (for example Chromium on Linux, where this was tested) it falls back to
  **H.264 + Opus** and the page says so. YouTube re-encodes uploads and accepts this, but AAC is the standard.
- Chrome's encoder writes **full-range BT.709** video. It is correctly flagged in the H.264 stream and the MP4
  container tag is made to match, so colours are right in compliant players.
- Rendering uses the user's CPU: roughly 1-3x the video's length. 1440p is slow. Very long videos use a lot of memory.
- The finished video lives in the browser until downloaded; nothing is stored on the server (no R2 bucket).
- Scenes without an asset, or whose provider fails, fall back to a title card and the page lists which.

## Verification

- `bun run test` — timeline, subtitles, transitions, ducking and provider logic.
- `scripts/verify-render.cjs` — renders real MP4s and checks them with ffprobe/ffmpeg: codecs, size, duration,
  decode errors, colour accuracy, transition blends, burned-in subtitles, voice onsets within ~15 ms of the timeline.
- `scripts/e2e-render-ui.cjs` — drives the Render page as a user, with provider responses simulated at the browser
  boundary, and verifies the downloaded MP4 and SRT.
- `scripts/e2e-render-demo.cjs` — the no-keys path in demo mode.
