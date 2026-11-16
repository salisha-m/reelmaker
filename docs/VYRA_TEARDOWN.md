# Vyra teardown

How Vyra (usevyra.com) works, from what is publicly observable, and how Reelsmith compares.
Gathered November 2026.

## What was examined

| Source | How |
| --- | --- |
| Marketing site, docs, tutorials, feature, template and tool pages (589 pages, incl. `llms.txt`) | Downloaded from the public sitemap and read in full |
| Public REST API reference (`/docs/api`) | Read in full |
| Web app client (`app.usevyra.com`): Vite single-page app, 8.6 MB main bundle plus 35 lazy chunks and workers, 43 MB in total | Downloaded the public assets; static analysis with REA (`rea analyze-javascript-application`: 33 files, 31 JavaScript sources parsed, 2.38M syntax nodes, 3,222 findings), then targeted reading of the tool dispatcher, chat streaming and MCP relay code |
| Public endpoints | `/api/config`, `/api/demo/templates/boston-startup-day` (a full analysed demo project: 73 assets with transcripts, scene analysis and beat grids), OAuth metadata at `api.usevyra.com/.well-known/*` |

Not examined: the signed-in app (sign-in is Google or email; Google sign-in needs the account
owner's browser) and the MCP server's live tool list (needs OAuth). Statements below are marked
**observed** (seen in code, data or docs) or **inferred**.

## Product

- **Positioning (observed).** A timeline video editor where an AI agent edits your own footage
  from a plain-language request. The core edit generates nothing; voiceover, music, sound effects
  and images can be generated through MCP and the API.
- **Surfaces (observed).** Web app, iPhone app, an MCP server for Claude / ChatGPT / Cursor, and a
  REST API for approved accounts.
- **Pricing (observed).** MCP Starter $24/mo, MCP Pro $65, Vyra AI Starter $54, Vyra AI Pro $129;
  credits pay for processing and each editing turn; exports up to 1440p (Starter) or 4K (Pro);
  3-day web trial; iPhone free tier of 100 credits with 720p watermarked exports.
- **Templates (observed).** Three structures handed to the agent as guidance: Short Talking Head,
  Vlog, Long Podcast. Two styles (fonts + palette + grade): "Vyra Default" (Inter Bold captions,
  Montserrat Black titles, DM Serif Display accent) and "Cinematic Film".
- **Reference videos (observed).** One per project, analysed for cut rhythm, caption style, music
  behaviour and colour; a personal reference library; on iPhone, Reels and TikToks can be shared
  into the app as references.
- **Trends (observed).** The product has no trend tracking: the client bundle has no trend or
  sound-chart endpoints (the only "trends" are admin analytics charts). Trends appear only in
  marketing content (idea lists, a "color wheel trend" example video).

## Architecture

- **Client (observed).** React SPA on Vercel. Supabase for auth and storage, Cloudflare R2 for media
  (signed URLs), PostHog analytics. Export runs in the browser (WebCodecs via mediabunny; "keep the
  tab open until it finishes"), with a server export path for agents. Motion graphics are React /
  Remotion code compiled in the browser with Babel. Background removal runs on-device
  (onnxruntime-web, MODNet worker). Audio effects in a WASM module.
- **Models (observed in `/api/config` and code).** The built-in agent model is exposed as "Vyra AI"
  (`gpt-6.1-sol` in the config fetched). Scene analysis fields are named `gemini_metadata`
  (summary, tags, per-segment description and audio). Strings also reference `claude-haiku-4-5`,
  `gemini-3.7-flash` and an image-generation model family.
- **Upload pipeline (observed).** Every file gets a word-level transcript with speaker ids, a
  scene-by-scene description, thumbnails, a 720p editing proxy, and for audio a beat grid from the
  "Beat This!" detector (pulse beats, downbeats, onsets, silences, average BPM, tempo type). Files
  can stay local to the device or be stored in the cloud.
- **Agent (observed).** Chat responses stream as typed events (`TEXT_MESSAGE_CONTENT`,
  `TOOL_CALL_START/ARGS/END`, motion-graphic events). Tool calls execute in the browser against the
  timeline store. A guard rejects edits to anything the agent has not read, or that the user changed
  since it read it (`STALE_READ_REFRESHED`, with the current state attached). Each turn keeps a
  version so it can be undone.
- **MCP (observed).** Originally a relay: the MCP server forwarded each tool call to the user's open
  editor tab (`/mcp/connect`, `MCP_TOOL_CALL`, `/mcp/tool-result`). Since October 2026 it is
  "headless": each agent gets its own server-side editing container. Streamable HTTP, OAuth 2.1 with
  PKCE, scopes `editor` and `offline_access`.
- **REST API (observed).** `POST /v1/videos` with footage links (files, Drive/Dropbox, or
  Instagram/TikTok/YouTube links), a prompt, up to 5 reference videos, `effort`, `max_seconds`,
  aspect, variations (portion or full), optional generated media with a budget. Status runs
  queued → importing → analysing → editing → rendering → completed; HMAC-signed webhooks; revisions
  and free re-exports; priced per length band (e.g. $0.50 low / $1.00 high effort up to 60 s, plus
  $0.02 per minute of video sent).

### The agent's tool set (observed, 54 tools in the client dispatcher)

`viewItemDetails`, `context`, `fonts`, `listEffects`, `getEffectDetails`, `captureFrame`,
`exportProject`, `moveItem`, `reorderItems`, `trimItem`, `splitItem`, `deleteItems`, `listAllowedDir`,
`importFromAllowedDir`, `cloneItem`, `slipItem`, `manageMarkers`, `manageTrackGroup`, `manageTrack`,
`applyTransition`, `addMedia`, `addText`, `addShape`, `addLayout`, `editLayout`, `addMotionGraphic`,
`applyPreset`, `syncAndSwap`, `consolidateTracks`, `addCaptions`, `listCaptionTemplates`,
`getMotionGraphicCode`, `editMotionGraphicCode`, `editMotionGraphic`, `editProperties`,
`editAllCaptionStyles`, `transformItem`, `changeTrack`, `writeKeyframes`, `setTimeRemap`,
`viewMaskFrame`, `previewSmartMask`, `trackSmartMask`, `createMask`, `editMaskProperties`,
`removeMask`, `writeMaskPoints`, `removeBackground`, `writeShapePoints`, `setFilter`,
`writeEffects`, `searchStockMedia`, `addExternalToProject`, `resizeCanvas`.

Notable details: `addMedia` accepts a `transcriptRange` (cut by quoted words); `viewItemDetails`
returns beats with strength filters and subdivisions; errors carry codes and the next free position
on a track, so the model can correct itself.

## Reelsmith compared

| Capability | Vyra | Reelsmith |
| --- | --- | --- |
| Upload and index footage (transcript, scenes, proxy, beats) | Yes | Yes (Whisper word timestamps, shot detection and motion, librosa beat grid; optional vision descriptions) |
| Chat agent editing a real timeline | Yes, 54 tools | Yes, 27 tools on the same model: read, cut by quoted words, tighten, captions, music ducking, beat sync, transitions, grade, resize, templates, trends, export; undo per turn |
| MCP for outside agents | Yes (OAuth, hosted) | Yes (local endpoint, no OAuth) |
| Templates | Short Talking Head, Vlog, Long Podcast | Those three plus Beat Montage, each with its own assembly (vlog runs in recording order with b-roll cut on the beat; podcast keeps the conversation with music on intro and outro only) |
| Reference style matching | One reference per project, described by the agent | Trend library: every post becomes a reusable blueprint (hook formula, every cut, cuts-on-beat %, BPM, caption look, structure, why it works) |
| Trend tracking and trending sounds | No | Yes: import by link or file, viral score, sound library ranked by use, watchlist of accounts/hashtags/sounds ranked by views per hour |
| "What to post" | Marketing idea pages only | In-app ideas from your trends, your footage and your niche, each opening in Autopilot |
| One-click video | API only (no trend input) | Autopilot from any trend or template, with or without AI planning |
| Caption looks | Caption templates; fonts include TikTok Sans | 15 looks modelled on what creators post with (keyword highlight, word box, native line box, comic, karaoke, typewriter, serif lower case...) |
| Manual editing | Full timeline | Timeline with drag, trim, split, ripple delete, undo/redo; on-canvas text and caption placement |
| Export | In browser, MP4/WebM up to 4K | Server render from originals, MP4/WebM up to 4K, preview and export drawn by the same code |
| Masks, background removal, motion graphics as code | Yes | Not built |
| Stock media, voiceover/music/image generation | Yes | Not built |
| Multi-camera sync, variations, iPhone app, accounts and billing, hosted API | Yes | Not built |
