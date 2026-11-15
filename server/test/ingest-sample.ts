// Dev helper: push local files through the upload pipeline. Usage: tsx server/test/ingest-sample.ts file...
import path from "node:path";
import { createAsset, whenProcessed } from "../src/pipeline.ts";

const files = process.argv.slice(2);
const t0 = Date.now();
for (const f of files) {
  const a = await createAsset({ tmpPath: f, name: path.basename(f), copy: true });
  const d = await whenProcessed(a.id);
  const words = d.transcription?.segments.flatMap((s) => s.words).length ?? 0;
  console.log(JSON.stringify({ id: d.id, name: d.name, type: d.type, status: d.status, dur: d.durationMs, size: `${d.width}x${d.height}`, steps: d.steps, words, bpm: d.rhythm?.averageBpm, beats: d.rhythm?.pulseBeats.length, music: d.musicScore, contentType: d.contentType, shots: d.visual?.shots.length, tags: d.analysis?.tags, error: d.error }));
  if (d.transcription) console.log("   text:", d.transcription.segments.map((s) => s.text).join(" ").slice(0, 300));
  if (d.analysis) console.log("   scene0:", d.analysis.segments[0]?.description, "| summary:", d.analysis.summary);
}
console.log("total seconds", (Date.now() - t0) / 1000);
process.exit(0);
