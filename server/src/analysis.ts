// "Footage understanding": shots, what happens in them and what is heard.
import fs from "node:fs";
import path from "node:path";
import type { Asset, SceneAnalysis, SceneSegment, Transcription, RhythmData } from "../../shared/types.ts";
import { dirs, VISION_INDEXING, llmBackend } from "./config.ts";
import { detectCuts, extractFrames, frameStats, type FrameStat } from "./media.ts";
import { jsonTask } from "./llm.ts";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export interface ShotInfo { start: number; end: number; luma: number; sat: number; motion: number; speech: string; speechCoverage: number }
export interface VisualIndex { cuts: number[]; shots: ShotInfo[]; stats: FrameStat[]; luma: number; sat: number; motion: number }

export function wordsBetween(tr: Transcription | null, a: number, b: number): { text: string; coverage: number } {
  if (!tr) return { text: "", coverage: 0 };
  const words = tr.segments.flatMap((s) => s.words).filter((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 < b);
  const spoken = words.reduce((s, w) => s + (w.end - w.start), 0);
  return { text: words.map((w) => w.word).join(" "), coverage: b > a ? Math.min(1, spoken / (b - a)) : 0 };
}

export async function visualIndex(file: string, durationSec: number, tr: Transcription | null): Promise<VisualIndex> {
  const [cuts, stats] = await Promise.all([detectCuts(file), frameStats(file, durationSec > 600 ? 1 : 2)]);
  const bounds = [0, ...cuts.filter((c) => c > 0.2 && c < durationSec - 0.2), durationSec];
  const shots: ShotInfo[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]!, b = bounds[i + 1]!;
    const st = stats.filter((s) => s.t >= a && s.t < b);
    // the first sample of a shot carries the cut itself as motion; skip it
    const inner = st.length > 1 ? st.slice(1) : st;
    const w = wordsBetween(tr, a, b);
    shots.push({ start: a, end: b, luma: avg(st.map((s) => s.luma)), sat: avg(st.map((s) => s.sat)), motion: avg(inner.map((s) => s.motion)), speech: w.text, speechCoverage: w.coverage });
  }
  return { cuts, shots, stats, luma: avg(stats.map((s) => s.luma)), sat: avg(stats.map((s) => s.sat)), motion: avg(stats.map((s) => s.motion)) };
}

function heuristicDescription(s: ShotInfo, idx: number, total: number): string {
  const light = s.luma < 0.25 ? "dark" : s.luma > 0.62 ? "bright" : "evenly lit";
  const move = s.motion > 0.06 ? "a lot of movement" : s.motion > 0.02 ? "some movement" : "a steady shot";
  const colour = s.sat < 0.12 ? "muted colour" : s.sat > 0.45 ? "saturated colour" : "natural colour";
  const talk = s.speechCoverage > 0.3 ? `someone speaking: "${s.speech.split(" ").slice(0, 16).join(" ")}${s.speech.split(" ").length > 16 ? "…" : ""}"` : "no speech";
  return `Shot ${idx + 1} of ${total}: ${light}, ${move}, ${colour}; ${talk}.`;
}

/** Scene-by-scene description of a video. Uses a vision model when one is configured and enabled, otherwise signal statistics. */
export async function analyzeScenes(asset: Pick<Asset, "id" | "name" | "width" | "height" | "durationMs">, file: string, tr: Transcription | null, rhythm: RhythmData | null, opts: { vision?: boolean } = {}): Promise<{ analysis: SceneAnalysis; index: VisualIndex }> {
  const dur = asset.durationMs / 1000;
  const index = await visualIndex(file, dur, tr);
  // cut long shots into windows of at most 6 s so a moment can be found
  const segs: (ShotInfo & { shot: number })[] = [];
  index.shots.forEach((s, i) => {
    const n = Math.max(1, Math.ceil((s.end - s.start) / 6));
    const step = (s.end - s.start) / n;
    for (let k = 0; k < n; k++) {
      const a = s.start + k * step, b = k === n - 1 ? s.end : s.start + (k + 1) * step;
      const st = index.stats.filter((x) => x.t >= a && x.t < b);
      const w = wordsBetween(tr, a, b);
      segs.push({ shot: i, start: a, end: b, luma: avg(st.map((x) => x.luma)), sat: avg(st.map((x) => x.sat)), motion: avg(st.slice(k === 0 ? 1 : 0).map((x) => x.motion)), speech: w.text, speechCoverage: w.coverage });
    }
  });
  const music = (rhythm as (RhythmData & { musicScore?: number }) | null)?.musicScore ?? 0;
  const segments: SceneSegment[] = segs.map((s) => ({
    start_time: Math.round(s.start * 100) / 100, end_time: Math.round(s.end * 100) / 100,
    description: heuristicDescription(s, s.shot, index.shots.length),
    audio: s.speechCoverage > 0.3 ? "Speech" : music > 0.6 ? "Music" : "Ambient sound",
  }));
  const speechCov = tr ? Math.min(1, tr.segments.flatMap((s) => s.words).reduce((x, w) => x + (w.end - w.start), 0) / Math.max(0.1, dur)) : 0;
  const tags: string[] = [];
  if (speechCov > 0.35) tags.push("talking"); else if (speechCov > 0.08) tags.push("some-speech"); else tags.push("b-roll");
  if (index.shots.length === 1) tags.push("single-shot"); else if (index.shots.length / Math.max(1, dur / 60) > 20) tags.push("fast-cut");
  if (index.motion > 0.05) tags.push("high-motion");
  if (index.luma < 0.25) tags.push("dark");
  if (asset.width && asset.height) tags.push(asset.height > asset.width ? "vertical" : asset.width > asset.height ? "horizontal" : "square");
  const w = asset.width ?? 0, h = asset.height ?? 0;
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const ratio = w && h ? (Math.abs(w / h - 9 / 16) < 0.02 ? "9:16" : Math.abs(w / h - 16 / 9) < 0.02 ? "16:9" : Math.abs(w / h - 1) < 0.02 ? "1:1" : `${w / g(w, h)}:${h / g(w, h)}`) : undefined;
  const firstWords = tr?.segments[0]?.text ?? "";
  const analysis: SceneAnalysis = {
    tags, segments, aspect_ratio: ratio, duration_seconds: Math.round(dur), source: "heuristic",
    summary: `${fmt(dur)} ${tags[0] === "talking" ? "talking clip" : "clip"} with ${index.shots.length} shot${index.shots.length === 1 ? "" : "s"}${firstWords ? `. Opens with: "${firstWords.slice(0, 140)}"` : ", no speech"}.`,
  };
  const useVision = (opts.vision ?? VISION_INDEXING) && llmBackend() !== "none";
  if (useVision && segs.length) {
    const pick = segs.length <= 14 ? segs : Array.from({ length: 14 }, (_, i) => segs[Math.floor((i * segs.length) / 14)]!);
    const dir = path.join(dirs.frames, asset.id);
    const frames = await extractFrames(file, pick.map((s) => (s.start + s.end) / 2), dir, 384, "scene");
    const res = await jsonTask<{ summary: string; tags: string[]; frames: { index: number; description: string }[] }>({
      task: "scene-descriptions",
      system: "You describe video frames for a video editor's footage index. Be concrete and visual: who or what is in frame, what they are doing, the setting, framing (close-up, wide), anything written on screen. One sentence per frame. No guessing about things you cannot see.",
      prompt: `File "${asset.name}", ${fmt(dur)} long. The frames below were taken at these times: ${frames.map((f, i) => `frame ${i} at ${fmt(f.time)}`).join(", ")}.\n${tr ? `What is said in the clip: "${tr.segments.map((s) => s.text).join(" ").slice(0, 1500)}"\n` : "The clip has no speech.\n"}Return JSON: {"summary": "2-3 sentence summary of the whole clip", "tags": ["5-9 short lowercase tags"], "frames": [{"index": 0, "description": "..."}]}`,
      imagePaths: frames.map((f) => f.file),
    });
    if (res?.frames?.length) {
      for (const fr of res.frames) {
        const src = pick[fr.index];
        const seg = src ? segments[segs.indexOf(src)] : undefined;
        if (seg && fr.description) seg.description = fr.description;
      }
      analysis.summary = res.summary || analysis.summary;
      analysis.tags = [...new Set([...(res.tags ?? []), ...tags])].slice(0, 12);
      analysis.source = "vision";
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { analysis, index };
}
