import { listAssets } from "../src/pipeline.ts";
for (const d of listAssets().reverse()) console.log(d.id, d.name, d.type, d.status, d.durationMs, `${d.width}x${d.height}`, "words", d.transcription?.segments.flatMap((s) => s.words).length ?? 0, "bpm", d.rhythm?.averageBpm, "music", d.musicScore, d.contentType, "shots", d.visual?.shots.length ?? "-", (d.analysis?.tags ?? []).join(","), d.error ?? "");
process.exit(0);
