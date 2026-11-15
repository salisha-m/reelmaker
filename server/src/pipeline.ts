// Asset library and the processing every upload goes through:
// probe -> editing proxy + thumbnail -> audio -> waveform -> beats/silences -> transcript -> scenes.
import fs from "node:fs";
import path from "node:path";
import type { Asset, AssetSteps, RhythmData, Transcription } from "../../shared/types.ts";
import { dirs, PY, PY_DIR, WHISPER_MODEL } from "./config.ts";
import * as db from "./db.ts";
import { emit } from "./events.ts";
import { extractWav, makeAudioProxy, makeProxy, makeThumbnail, probe, run, waveformPeaks } from "./media.ts";
import { analyzeScenes, type VisualIndex } from "./analysis.ts";

/** Stored form of an asset: the public record plus private file locations and the visual index. */
export interface AssetDoc extends Omit<Asset, "urls"> { file: string; ext: string; visual?: (Pick<VisualIndex, "cuts" | "shots" | "luma" | "sat" | "motion"> & { curve?: [number, number, number][] }) | null; musicScore?: number; origin?: { kind: string; ref?: string } }

const STEP_WEIGHT: Record<keyof AssetSteps, number> = { probe: 0.03, thumbnail: 0.04, proxy: 0.28, waveform: 0.05, rhythm: 0.1, transcript: 0.35, scenes: 0.15 };

export function publicAsset(d: AssetDoc): Asset {
  const { file: _f, ext: _e, visual: _v, ...rest } = d;
  const v = encodeURIComponent(d.createdAt);
  return {
    ...rest,
    urls: {
      original: `/media/original/${d.id}${d.ext}`,
      proxy: d.steps.proxy === "done" ? `/media/proxy/${d.id}${d.type === "audio" ? ".m4a" : ".mp4"}?v=${v}` : d.type === "image" ? `/media/original/${d.id}${d.ext}` : null,
      thumbnail: d.steps.thumbnail === "done" ? `/media/thumb/${d.id}.jpg?v=${v}` : null,
    },
  };
}
export const getAsset = (id: string) => db.get<AssetDoc>("asset", id);
export const listAssets = () => db.list<AssetDoc>("asset");
export function assetPaths(d: Pick<AssetDoc, "id" | "type" | "file">) {
  return { original: d.file, proxy: path.join(dirs.proxies, `${d.id}${d.type === "audio" ? ".m4a" : ".mp4"}`), thumb: path.join(dirs.thumbs, `${d.id}.jpg`), wav: path.join(dirs.audio, `${d.id}.wav`) };
}
/** The best file to decode frames from at edit quality. */
export function decodeSource(d: AssetDoc, preferOriginal: boolean): string {
  const p = assetPaths(d);
  if (d.type === "image") return d.file;
  return preferOriginal || !fs.existsSync(p.proxy) ? d.file : p.proxy;
}

function save(d: AssetDoc, announce = true) {
  const steps = d.steps;
  let done = 0, total = 0;
  for (const k of Object.keys(STEP_WEIGHT) as (keyof AssetSteps)[]) {
    if (steps[k] === "skipped") continue;
    total += STEP_WEIGHT[k];
    if (steps[k] === "done" || steps[k] === "error") done += STEP_WEIGHT[k];
    else if (steps[k] === "running") done += STEP_WEIGHT[k] * (partial.get(`${d.id}:${k}`) ?? 0);
  }
  d.progress = total ? Math.min(1, done / total) : 1;
  db.put("asset", d.id, d);
  if (announce) emit({ type: "asset", asset: publicAsset(d) });
}
const partial = new Map<string, number>();

export async function createAsset(input: { tmpPath: string; name: string; mime?: string; contentType?: Asset["contentType"]; origin?: AssetDoc["origin"]; copy?: boolean }): Promise<AssetDoc> {
  const id = db.newId("as");
  const ext = (path.extname(input.name) || ".bin").toLowerCase().replace(/[^.a-z0-9]/g, "");
  const file = path.join(dirs.uploads, `${id}${ext}`);
  if (input.copy) fs.copyFileSync(input.tmpPath, file); else fs.renameSync(input.tmpPath, file);
  const size = fs.statSync(file).size;
  let info;
  try { info = await probe(file); } catch (e) { fs.rmSync(file, { force: true }); throw e; }
  const type: Asset["type"] = info.isImage ? "image" : info.hasVideo ? "video" : "audio";
  if (!info.isImage && !info.hasVideo && !info.hasAudio) { fs.rmSync(file, { force: true }); throw new Error("This file has no picture or sound that can be used."); }
  const steps: AssetSteps = {
    probe: "done", thumbnail: type === "audio" ? "skipped" : "pending", proxy: type === "image" ? "skipped" : "pending",
    waveform: info.hasAudio ? "pending" : "skipped", rhythm: info.hasAudio ? "pending" : "skipped", transcript: info.hasAudio ? "pending" : "skipped", scenes: type === "audio" ? "skipped" : "pending",
  };
  const doc: AssetDoc = {
    id, name: input.name, type, mime: input.mime ?? "", size, width: info.width, height: info.height, durationMs: info.durationMs, fps: info.fps, hasAudio: info.hasAudio, rotation: info.rotation,
    createdAt: new Date().toISOString(), fileCreatedAt: info.createdAt, status: "processing", steps, progress: 0, error: null, contentType: input.contentType ?? "footage",
    analysis: null, transcription: null, rhythm: null, waveform: null, file, ext, origin: input.origin,
  };
  save(doc);
  enqueue(id);
  return doc;
}

// ---- queue: one heavy job at a time ----
const queue: string[] = [];
let working = false;
const waiters = new Map<string, ((d: AssetDoc) => void)[]>();
export function enqueue(id: string) { queue.push(id); void pump(); }
async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    const id = queue.shift()!;
    try { await processAsset(id); } catch (e) { console.error("[pipeline]", id, e); }
    const d = getAsset(id);
    if (d) for (const w of waiters.get(id) ?? []) w(d);
    waiters.delete(id);
  }
  working = false;
}
/** Resolves when an asset has finished processing (ready or error). */
export function whenProcessed(id: string): Promise<AssetDoc> {
  const d = getAsset(id);
  if (d && d.status !== "processing" && d.status !== "uploading") return Promise.resolve(d);
  return new Promise((res) => { waiters.set(id, [...(waiters.get(id) ?? []), res]); });
}

async function step(d: AssetDoc, name: keyof AssetSteps, fn: (progress: (p: number) => void) => Promise<void>) {
  if (d.steps[name] !== "pending") return;
  d.steps[name] = "running"; save(d);
  let last = 0;
  try {
    await fn((p) => { partial.set(`${d.id}:${name}`, p); if (Date.now() - last > 700) { last = Date.now(); save(d); } });
    d.steps[name] = "done";
  } catch (e) {
    d.steps[name] = "error";
    d.error = `${name}: ${(e as Error).message}`.slice(0, 400);
    console.warn(`[pipeline] ${d.id} ${name} failed:`, (e as Error).message);
  }
  partial.delete(`${d.id}:${name}`);
  save(d);
}

export async function transcribeFile(wav: string, onProgress?: (p: number) => void): Promise<Transcription> {
  const r = await run(PY, [path.join(PY_DIR, "transcribe.py"), wav, WHISPER_MODEL, process.env.WHISPER_LANGUAGE ?? "auto"], {
    onStderr: (s) => { const m = /progress ([0-9.]+)/.exec(s); if (m) onProgress?.(Number(m[1])); }, timeoutMs: 3 * 3600_000,
  });
  if (r.code !== 0) throw new Error(r.stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || "speech recognition failed");
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Transcription;
}
export async function rhythmOf(wav: string): Promise<RhythmData & { musicScore: number }> {
  const r = await run(PY, [path.join(PY_DIR, "rhythm.py"), wav], { timeoutMs: 1800_000 });
  if (r.code !== 0) throw new Error(r.stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || "beat analysis failed");
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

export async function processAsset(id: string, opts: { vision?: boolean } = {}): Promise<AssetDoc> {
  const d = getAsset(id);
  if (!d) throw new Error("asset not found");
  const p = assetPaths(d);
  d.status = "processing";
  await step(d, "thumbnail", () => makeThumbnail(d.file, p.thumb, d.type === "image" ? 0 : Math.min(1, d.durationMs / 2000), d.type === "image"));
  await step(d, "proxy", (prog) => (d.type === "audio" ? makeAudioProxy(d.file, p.proxy) : makeProxy(d.file, p.proxy, prog, d.durationMs)));
  if (d.hasAudio) {
    try { await extractWav(d.file, p.wav); } catch (e) { d.steps.waveform = d.steps.rhythm = d.steps.transcript = "error"; d.error = `audio: ${(e as Error).message}`.slice(0, 300); save(d); }
  }
  await step(d, "waveform", async () => { d.waveform = await waveformPeaks(p.wav); });
  await step(d, "rhythm", async () => {
    const r = await rhythmOf(p.wav);
    d.musicScore = r.musicScore;
    d.rhythm = r;
  });
  // a track with a clear pulse is music: not worth transcribing. Voice recordings are.
  if (d.steps.transcript === "pending" && d.type === "audio" && ((d.musicScore ?? 0) >= 0.8 || d.contentType === "music")) { d.steps.transcript = "skipped"; if (d.contentType === "footage") d.contentType = "music"; save(d); }
  await step(d, "transcript", async (prog) => {
    const tr = await transcribeFile(p.wav, prog);
    d.transcription = tr.segments.length ? tr : null;
    const spoken = tr.segments.flatMap((x) => x.words).reduce((a, w) => a + (w.end - w.start), 0) * 1000;
    if (d.type === "audio" && d.contentType === "footage" && (d.musicScore ?? 0) >= 0.5 && spoken < d.durationMs * 0.3) d.contentType = "music";
  });
  await step(d, "scenes", async () => {
    if (d.type === "image") {
      d.analysis = { tags: ["image"], summary: `Still image ${d.width}x${d.height}.`, segments: [], aspect_ratio: d.width && d.height ? `${d.width}:${d.height}` : undefined, source: "heuristic" };
      return;
    }
    const src = fs.existsSync(p.proxy) ? p.proxy : d.file;
    const { analysis, index } = await analyzeScenes(d, src, d.transcription, d.rhythm, { vision: opts.vision });
    d.analysis = analysis;
    d.visual = { cuts: index.cuts, shots: index.shots, luma: index.luma, sat: index.sat, motion: index.motion, curve: index.stats.map((x) => [Math.round(x.t * 100) / 100, Math.round(x.motion * 1000) / 1000, Math.round(x.luma * 1000) / 1000]) };
  });
  const failed = (Object.keys(d.steps) as (keyof AssetSteps)[]).filter((k) => d.steps[k] === "error");
  // a clip is usable as long as it can be decoded; a failed transcript or scene pass only limits what the AI knows about it
  d.status = failed.includes("proxy") && d.type !== "image" && !fs.existsSync(d.file) ? "error" : "ready";
  if (!failed.length) d.error = null;
  save(d);
  return d;
}

export function deleteAsset(id: string) {
  const d = getAsset(id);
  if (!d) return;
  const p = assetPaths(d);
  for (const f of [p.original, p.proxy, p.thumb, p.wav]) fs.rmSync(f, { force: true });
  db.del("asset", id);
  emit({ type: "asset-deleted", id });
}
