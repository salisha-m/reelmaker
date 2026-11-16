# Reelsmith

Trend-driven short-form video maker. It tracks posts that are already performing, breaks each one
down into the parts you can reuse (hook, cut rhythm, caption look, sound), tells you what to post,
and builds the video from your own footage. Every result stays editable on a real timeline, by hand
or by telling the built-in assistant what you want.

## What it does

| Area | What you get |
| --- | --- |
| **Trends** | Add a TikTok / Reel / Short by link or by uploading the saved video. Each post is analysed into a blueprint: hook (spoken + on screen) and its reusable formula, every cut with timing, cuts-on-beat %, BPM and beat grid, caption look, structure, "why it works", and how to make your own. Music-driven posts keep their sound as a reusable track. A watchlist ranks recent posts from accounts/hashtags by views per hour. |
| **What to post** | Ideas matched to your trend library, your niche profile and the footage you already have, with a shot list and what is still missing. Rule-based instantly, or written by AI. |
| **Templates** | Short Talking Head, Vlog, Long Podcast and Beat Montage, each with its own assembly: the vlog runs in recording order with talking parts tightened and b-roll cut so every cut lands on the beat; the podcast keeps the whole conversation in order at 16:9 with music only on the intro and outro. Short tracks loop on whole bars so the beat grid carries on. |
| **Autopilot** | Pick a trend or a template, pick clips, press *Make the video*. Talking formats: strongest line moved to the front, pauses / fillers / restarts removed from the transcript, punch-ins on cuts, b-roll matched to what is said, captions, on-screen hook, sound ducked under the voice. Montage formats: the original post's cut points reproduced on its sound, or cuts placed on the beat grid of any track. |
| **Caption looks** | 15 looks modelled on what short-form creators actually post with (Montserrat Black keyword highlight, word box karaoke, TikTok Sans line boxes, Bangers pop, Rubik karaoke, typewriter build-up, Instrument Serif lower case, Bebas tall caps...). Word-level timing, spoken-word highlight, emphasis words. All fonts are bundled and open-licensed. |
| **Editor** | Multi-track timeline (drag, trim, split, ripple delete, undo/redo), live canvas preview with audio, drag text and captions on the canvas, inspector (volume, speed, zoom, filters, fonts), per-word caption fixes, export presets. |
| **Assistant** | Chat that edits the same timeline through 27 tools (cut by quoted words, tighten, caption, music, beat sync, transitions, grade, resize, apply a trend or template, export). The project's template or trend is part of every request. Each change can be undone as a unit. |
| **MCP** | The same tools at `POST /mcp` so Claude Code, Cursor or any MCP client can drive the editor. |
| **Export** | H.264 MP4 or VP9 WebM, 480p to 4K, from the original files. Preview and export are drawn by the same compositor code, so what you see is what you get. Option to export without the music so the official sound can be added in-app. |

How Vyra works and how this compares: [docs/VYRA_TEARDOWN.md](docs/VYRA_TEARDOWN.md).

## Run it

Requirements: Node 22.5+, Python 3.10+, ffmpeg.

```bash
npm install
npm run setup:python
npm run build
npm start
```

Open http://127.0.0.1:8787. For development with hot reload use `npm run dev` (web on :5173, API on :8787).

The speech model (faster-whisper `small`, about 480 MB) downloads on first use. Set `WHISPER_MODEL`
to a local model directory or another size (`base`, `medium`, `large-v3`) to change it.

### AI

Everything except the assistant, AI ideas, AI planning and the frame read works with no model at all.

| Setting | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Uses the Claude API through the official SDK (streaming, adaptive thinking, prompt caching, server-side refusal fallback). |
| *(none, `claude` CLI installed and signed in)* | Uses Claude Code in headless mode, driving the editor through this server's MCP endpoint. The model named in `AGENT_MODEL` is always passed explicitly. |
| `AI_BACKEND=none` | Turns AI off. |
| `AGENT_MODEL`, `VISION_MODEL` | Model ids. Default `claude-opus-5-5` for both. |
| `AGENT_EFFORT` | `low` \| `medium` \| `high`. Default `medium`. |
| `VISION_INDEXING=1` | Also describe every uploaded clip's scenes with the vision model (costs model usage per clip). Off by default; scenes are then described from signal statistics and the transcript. |

Other settings: `PORT` (8787), `DATA_DIR` (`./data`), `WHISPER_LANGUAGE` (auto).

### Connect an outside agent

```bash
claude mcp add --transport http reelsmith http://127.0.0.1:8787/mcp
```

## How it is built

```
shared/     timeline model + operations, the compositor (Canvas 2D), catalogs (fonts, caption looks, presets)
server/     Express API, SQLite document store, ffmpeg pipeline, Whisper + beat analysis (Python),
            trend analysis, autopilot, export renderer, agent + MCP
web/        React + Vite editor
```

- **One compositor.** `shared/render.ts` draws a frame to any Canvas 2D context. The browser runs it
  for the preview; the server runs it on a Skia canvas for export, with ffmpeg decoding and encoding.
- **One set of edit operations.** `shared/timeline.ts` is used by the editor UI, the assistant, the
  MCP endpoint and autopilot. A failed operation changes nothing and says why.
- **Upload pipeline.** probe -> 720p proxy + thumbnail -> word-level transcript -> beat grid, onsets,
  silences -> shot boundaries and per-second motion/brightness -> scene descriptions.

## Tests

```bash
npm test
npm run typecheck
```

`server/test/engine.e2e.ts` and `server/test/trends.e2e.ts` build and export edits from files in the library.

## Known limits

- Importing a post by link uses `yt-dlp` and needs network access to the platform from the server.
  Platforms change often and Instagram usually needs a logged-in cookie file; uploading the saved
  video always works. Check each platform's terms before downloading other people's posts.
- Trending sounds are ranked from the posts in your own library. There is no global chart feed.
- A post's sound is kept only when the post is driven by music; music under a voice cannot be separated.
- No accounts, teams or billing: one workspace per server. Put it behind your own auth before exposing it.
- Not built: masks / background removal, motion-graphic authoring UI, stock libraries, multicam sync.
