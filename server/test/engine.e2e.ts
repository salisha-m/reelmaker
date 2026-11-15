// End-to-end check of the edit engine without the UI: build an edit with the shared operations, export it, report facts.
import path from "node:path";
import fs from "node:fs";
import { listAssets, type AssetDoc } from "../src/pipeline.ts";
import { captureFrame, renderTimeline } from "../src/render.ts";
import * as T from "../../shared/timeline.ts";
import { captionTemplate } from "../../shared/catalog.ts";
import type { MediaItem } from "../../shared/types.ts";
import { dirs } from "../src/config.ts";

const assets = Object.fromEntries(listAssets().map((a) => [a.id, a])) as Record<string, AssetDoc>;
const byName = (n: string) => Object.values(assets).find((a) => a.name === n)!;
const look = process.argv[2] ?? "bold-pop";
const tl = T.emptyTimeline(1080, 1920, 30);
const talk = byName("talking_tips.mp4"), music = byName("beat_120bpm.mp3");
T.placeMedia(tl, [{ asset: talk }], { trackId: "video_1", atMs: 0 });
const before = T.timelineDuration(tl);
const clean = T.cutDeadSpace(tl, assets, undefined, { minPauseMs: 400, removeFillers: true, removeRestarts: true });
console.log("cuts:", clean.cuts.map((c) => `${c.reason}@${c.fromSeconds}-${c.toSeconds}${c.text ? ` "${c.text}"` : ""}`).join("; "));
console.log("duration", before / 1000, "->", T.timelineDuration(tl) / 1000, "pieces", clean.itemsAfter.length);
// alternate a punch-in so the jump cuts read as intended
T.itemsOnTrack(tl, "video_1").forEach((it, i) => { if (i % 2 === 1) (it as MediaItem).transform.scale = 1.14; });
const cap = T.generateCaptions(tl, assets, { style: captionTemplate(look)!.style, emphasisWords: ["every single day", "hook", "eighty percent", "80%", "captions"] });
console.log("captions:", cap.created, "first:", T.itemsOnTrack(tl, cap.trackId).slice(0, 4).map((c: any) => `${T.sec(c.display.from)}-${T.sec(c.display.to)} ${T.captionText(c)}`).join(" | "));
const [m] = T.placeMedia(tl, [{ asset: music, trimStartMs: 0, trimEndMs: Math.min(music.durationMs, T.timelineDuration(tl) + 300), volume: 0.5 }], { trackId: "audio_1", atMs: 0 });
const duck = T.duckUnderSpeech(tl, assets, m!.id, { baseVolume: 0.5, duckedVolume: 0.12 });
m!.fadeOutMs = 600;
T.addText(tl, { text: "NOBODY TELLS YOU THIS", startMs: 0, durationMs: 2600, y: -620, style: { fontFamily: "Montserrat", fontWeight: 900, fontSize: 84, color: "#111111", background: { color: "#FFE600", paddingX: 30, paddingY: 16, radius: 18 }, shadow: null }, animationIn: "pop" });
console.log("duck dips", duck.dips, "problems", T.validateTimeline(tl));
fs.writeFileSync(path.join(dirs.tmp, "e2e-timeline.json"), JSON.stringify(tl));
const out = path.join(dirs.renders, `e2e-${look}.mp4`);
const r = await renderTimeline(tl, assets, { settings: { preset: "small", resolution: "720p", bitrateMbps: 5, format: "mp4" }, out });
console.log("render", JSON.stringify(r), "fps", (r.frames / r.seconds).toFixed(1), "size", fs.statSync(out).size);
for (const t of [1200, 6000, 14000]) fs.writeFileSync(path.join(dirs.tmp, `e2e-${look}-${t}.jpg`), await captureFrame(tl, assets, t, 640));
console.log("out", out);
process.exit(0);
