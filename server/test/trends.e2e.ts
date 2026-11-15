// End-to-end check of trend ingestion and autopilot without the UI.
import fs from "node:fs";
import path from "node:path";
import { listAssets, getAsset, whenProcessed, type AssetDoc } from "../src/pipeline.ts";
import { ingestTrendFile, getTrend, listSounds, listTrends } from "../src/trends.ts";
import { remix, ruleIdeas, getProfile } from "../src/autopilot.ts";
import { renderTimeline, captureFrame } from "../src/render.ts";
import * as T from "../../shared/timeline.ts";
import { dirs } from "../src/config.ts";

const [montageFile, talkingFile] = process.argv.slice(2);
async function waitTrend(id: string) { for (;;) { const t = getTrend(id)!; if (t.status === "ready" || t.status === "error") return t; await new Promise((r) => setTimeout(r, 400)); } }
const have = listTrends();
let m = have.find((t) => t.title === "Post every day montage");
if (!m) { const tmp = path.join(dirs.tmp, "in_montage.mp4"); fs.copyFileSync(montageFile!, tmp); m = await waitTrend((await ingestTrendFile(tmp, "viral_montage.mp4", { title: "Post every day montage", platform: "tiktok", handle: "dailycreator", stats: { views: 2400000, likes: 310000, comments: 4200, shares: 18000 }, soundTitle: "Pulse 120", soundAuthor: "Test Beats", hashtags: ["contentcreator", "consistency"], postedAt: new Date(Date.now() - 3 * 86400000).toISOString(), deep: false })).id); }
let k = have.find((t) => t.title === "3 things nobody tells you");
if (!k) { const tmp = path.join(dirs.tmp, "in_talking.mp4"); fs.copyFileSync(talkingFile!, tmp); k = await waitTrend((await ingestTrendFile(tmp, "viral_talking.mp4", { title: "3 things nobody tells you", platform: "instagram", handle: "growthcoach", stats: { views: 870000, likes: 64000, comments: 900, shares: 5100 }, hashtags: ["socialmediatips"], postedAt: new Date(Date.now() - 9 * 86400000).toISOString(), deep: false })).id); }
for (const t of [getTrend(m.id)!, getTrend(k.id)!]) {
  const b = t.blueprint!;
  console.log(`TREND ${t.title}: status=${t.status} score=${t.viralScore} format=${b.format} dur=${b.durationMs} cuts=${b.pacing.cuts} (${b.pacing.label}) cutTimes=${b.slots.map((s) => (s.startMs / 1000).toFixed(2)).join(",")} music=${b.audio.hasMusic} bpm=${b.audio.bpm} onBeat=${b.audio.cutsOnBeat} speech=${b.audio.hasSpeech} hook=${JSON.stringify(b.hook.spoken)} type=${b.hook.type} look=${b.captions.look} sound=${t.soundId} err=${t.error}`);
  console.log("   structure:", b.structure.join(" | "), "\n   why:", b.whyItWorks.join(" "));
}
console.log("SOUNDS", listSounds().map((s) => `${s.title} ${s.bpm}bpm posts=${s.postIds.length} views=${s.totalViews}`).join("; "));
const assets = listAssets().filter((a) => !a.origin);
const broll = assets.filter((a) => a.name.startsWith("broll_"));
const talk = assets.find((a) => a.name === "talking_tips.mp4")!;
const all = Object.fromEntries(listAssets().map((a) => [a.id, a])) as Record<string, AssetDoc>;
// 1) montage trend with the same sound
const snd = listSounds().find((s) => s.postIds.includes(m!.id));
const r1 = remix({ blueprint: getTrend(m.id)!.blueprint, assets: broll, musicAsset: snd ? getAsset(snd.assetId) : null, hookText: "POV: you finally post every day" });
console.log("REMIX montage:", JSON.stringify({ ...r1.report, notes: r1.report.notes }), "\n   slots:", T.itemsOnTrack(r1.timeline, "video_1").map((i) => (i.display.from / 1000).toFixed(2)).join(","), "problems", T.validateTimeline(r1.timeline));
// 2) talking trend with talking clip + b-roll + a music bed
const music = assets.find((a) => a.contentType === "music")!;
const r2 = remix({ blueprint: getTrend(k.id)!.blueprint, assets: [talk, ...broll.slice(0, 4)], musicAsset: music, targetSeconds: 20 });
console.log("REMIX talking:", JSON.stringify(r2.report), "problems", T.validateTimeline(r2.timeline));
console.log("   tracks:", r2.timeline.tracks.map((t) => `${t.id}:${T.itemsOnTrack(r2.timeline, t.id).length}`).join(" "));
for (const [name, r] of [["montage", r1], ["talking", r2]] as const) {
  const out = path.join(dirs.renders, `remix-${name}.mp4`);
  const res = await renderTimeline(r.timeline, all, { settings: { preset: "small", resolution: "720p", bitrateMbps: 5, format: "mp4" }, out });
  console.log(`RENDER ${name}:`, JSON.stringify(res), "size", fs.statSync(out).size);
  fs.writeFileSync(path.join(dirs.tmp, `remix-${name}.json`), JSON.stringify(r.timeline));
  for (const t of name === "montage" ? [1500, 4200] : [1200, 7000, 13000]) fs.writeFileSync(path.join(dirs.tmp, `remix-${name}-${t}.jpg`), await captureFrame(r.timeline, all, t, 540));
}
console.log("IDEAS", ruleIdeas(assets, getProfile()).map((i) => `${i.score} ${i.title} | missing: ${i.missing.join("; ") || "-"}`).join("\n      "));
process.exit(0);
