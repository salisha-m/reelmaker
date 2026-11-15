// Export: ffmpeg decodes each clip to raw frames, the shared compositor draws every output
// frame on a Skia canvas (the same drawing code the browser preview runs), ffmpeg encodes.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts, ImageData, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { ExportSettings, MediaItem, Timeline } from "../../shared/types.ts";
import { FONTS, RESOLUTION_SHORT_SIDE, fontKey } from "../../shared/catalog.ts";
import { animatedTransform, layersAt, mediaBox, renderFrame, type FrameSource, type RenderResources } from "../../shared/render.ts";
import { isMedia, timelineDuration, trackOf } from "../../shared/timeline.ts";
import { FONTS_DIR, dirs } from "./config.ts";
import { ffmpeg } from "./media.ts";
import { decodeSource, type AssetDoc } from "./pipeline.ts";

let fontsReady = false;
export function registerFonts() {
  if (fontsReady) return;
  for (const f of FONTS) GlobalFonts.registerFromPath(path.join(FONTS_DIR, f.file), fontKey(f.family, f.weight));
  fontsReady = true;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
export function exportSize(tl: Timeline, resolution: ExportSettings["resolution"]): { width: number; height: number; scale: number } {
  const short = Math.min(tl.size.width, tl.size.height);
  const target = resolution === "original" ? short : RESOLUTION_SHORT_SIDE[resolution] ?? short;
  const scale = target / short;
  return { width: even(tl.size.width * scale), height: even(tl.size.height * scale), scale };
}

/** Sequential raw-frame reader for one clip. Frames arrive at the output frame rate, already retimed. */
class ClipReader {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private wake: (() => void) | null = null;
  private frameIndex = -1;
  private canvas: Canvas;
  private ctx: SKRSContext2D;
  private frameBytes: number;
  readonly source: FrameSource;
  /** Timeline ms of frame 0 of this reader. */
  readonly startMs: number;
  constructor(private file: string, private item: MediaItem, private w: number, private h: number, private fps: number, startMs: number, private endMs: number, private srcDurationMs: number) {
    this.startMs = startMs;
    this.canvas = createCanvas(w, h);
    this.ctx = this.canvas.getContext("2d");
    this.frameBytes = w * h * 4;
    this.source = { image: this.canvas, width: w, height: h };
  }
  private start() {
    const it = this.item;
    const srcStart = Math.max(0, it.trim.from + (this.startMs - it.display.from) * it.playbackRate);
    const srcLen = Math.max(40, (this.endMs - this.startMs) * it.playbackRate + 200);
    const vf = [`setpts=(PTS-STARTPTS)/${it.playbackRate}`, `fps=${this.fps}`, `scale=${this.w}:${this.h}:flags=bicubic`, "format=rgba"].join(",");
    this.proc = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", (srcStart / 1000).toFixed(3), "-t", (srcLen / 1000).toFixed(3), "-i", this.file, "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
    this.proc.stdout.on("data", (d: Buffer) => {
      this.chunks.push(d); this.buffered += d.length;
      // keep at most ~24 frames queued; ffmpeg waits while the pipe is paused
      if (this.buffered > this.frameBytes * 24) this.proc?.stdout.pause();
      this.wake?.();
    });
    this.proc.stdout.on("end", () => { this.ended = true; this.wake?.(); });
    this.proc.on("error", () => { this.ended = true; this.wake?.(); });
    this.proc.stderr.on("data", () => undefined);
  }
  private async readFrame(): Promise<Buffer | null> {
    while (this.buffered < this.frameBytes) {
      if (this.ended) return null;
      this.proc?.stdout.resume();
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
    const out = Buffer.allocUnsafe(this.frameBytes);
    let off = 0;
    while (off < this.frameBytes) {
      const c = this.chunks[0]!;
      const need = this.frameBytes - off;
      if (c.length <= need) { c.copy(out, off); off += c.length; this.chunks.shift(); }
      else { c.copy(out, off, 0, need); this.chunks[0] = c.subarray(need); off += need; }
    }
    this.buffered -= this.frameBytes;
    return out;
  }
  /** Make the frame for timeline time `tMs` current. */
  async seek(tMs: number): Promise<void> {
    if (!this.proc) this.start();
    const want = Math.max(0, Math.round(((tMs - this.startMs) / 1000) * this.fps));
    while (this.frameIndex < want) {
      const buf = await this.readFrame();
      if (!buf) break; // past the end of the media: hold the last frame
      this.frameIndex++;
      if (this.frameIndex === want || this.frameIndex === 0) this.ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), this.w, this.h), 0, 0);
      else if (this.frameIndex > want - 1) this.ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), this.w, this.h), 0, 0);
    }
  }
  close() { try { this.proc?.stdout.destroy(); this.proc?.kill("SIGKILL"); } catch { /* already gone */ } this.proc = null; this.chunks = []; }
}

/** Piecewise-linear gain as an ffmpeg expression of t (seconds from the clip's first sample). */
function gainExpr(points: { t: number; v: number }[]): string {
  if (!points.length) return "1";
  let e = points[0]!.v.toFixed(4);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const dt = Math.max(0.001, b.t - a.t), dv = b.v - a.v;
    if (Math.abs(dv) < 1e-5) continue;
    e += `+(${dv.toFixed(4)})*clip((t-${a.t.toFixed(3)})/${dt.toFixed(3)},0,1)`;
  }
  return e;
}
function atempoChain(rate: number): string[] {
  const out: string[] = [];
  let r = rate;
  while (r > 2.0) { out.push("atempo=2.0"); r /= 2; }
  while (r < 0.5) { out.push("atempo=0.5"); r /= 0.5; }
  if (Math.abs(r - 1) > 0.001) out.push(`atempo=${r.toFixed(4)}`);
  return out;
}

export async function mixAudio(tl: Timeline, assets: Record<string, AssetDoc>, out: string, startMs: number, endMs: number, opts: { skipItemIds?: string[] } = {}): Promise<void> {
  const total = (endMs - startMs) / 1000;
  const items = Object.values(tl.items).filter((i): i is MediaItem => isMedia(i) && i.type !== "image" && !(opts.skipItemIds ?? []).includes(i.id))
    .filter((i) => assets[i.assetId]?.hasAudio && !i.muted && !trackOf(tl, i.trackId).muted && i.display.to > startMs && i.display.from < endMs);
  if (!items.length) { await ffmpeg(["-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo", "-c:a", "pcm_s16le", out]); return; }
  const inputs: string[] = [];
  const chains: string[] = [];
  items.forEach((it, i) => {
    const a = assets[it.assetId]!;
    const track = trackOf(tl, it.trackId);
    const len = (it.display.to - it.display.from) / 1000;
    inputs.push("-ss", (it.trim.from / 1000).toFixed(3), "-t", ((it.trim.to - it.trim.from) / 1000).toFixed(3), "-i", a.file);
    const f: string[] = ["aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo", ...atempoChain(it.playbackRate)];
    const kf = it.keyframes?.volume;
    const pts = kf?.length ? kf.map((k) => ({ t: k.t / 1000, v: k.value })) : [{ t: 0, v: it.volume }];
    let expr = `(${gainExpr(pts)})*${(track.gain ?? 1).toFixed(3)}`;
    if (it.fadeInMs > 0) expr += `*clip(t/${(it.fadeInMs / 1000).toFixed(3)},0,1)`;
    if (it.fadeOutMs > 0) expr += `*clip((${len.toFixed(3)}-t)/${(it.fadeOutMs / 1000).toFixed(3)},0,1)`;
    f.push(`volume='${expr}':eval=frame`);
    // 12 ms edge ramps stop hard cuts from clicking
    f.push("afade=t=in:d=0.012", `afade=t=out:st=${Math.max(0, len - 0.012).toFixed(3)}:d=0.012`);
    const delay = Math.round(it.display.from - startMs);
    if (delay > 0) f.push(`adelay=${delay}:all=1`);
    else if (delay < 0) f.push(`atrim=start=${(-delay / 1000).toFixed(3)}`, "asetpts=PTS-STARTPTS");
    chains.push(`[${i}:a:0]${f.join(",")}[a${i}]`);
  });
  const mix = `${items.map((_, i) => `[a${i}]`).join("")}amix=inputs=${items.length}:normalize=0:duration=longest,alimiter=limit=0.97:level=false,apad,atrim=0:${total.toFixed(3)}[out]`;
  const script = path.join(dirs.tmp, `mix_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`);
  fs.writeFileSync(script, [...chains, mix].join(";\n"));
  try { await ffmpeg([...inputs, "-filter_complex_script", script, "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", out]); } finally { fs.rmSync(script, { force: true }); }
}

export interface RenderOptions { settings: ExportSettings; out: string; onProgress?: (p: number, stage: string) => void; isCancelled?: () => boolean; useOriginals?: boolean; muteItemIds?: string[] }
export async function renderTimeline(tl: Timeline, assets: Record<string, AssetDoc>, o: RenderOptions): Promise<{ width: number; height: number; durationMs: number; frames: number; seconds: number }> {
  registerFonts();
  const t0 = Date.now();
  const fps = Math.min(60, Math.max(1, o.settings.fps ?? tl.fps ?? 30));
  const startMs = Math.max(0, o.settings.startMs ?? 0);
  const endMs = Math.min(o.settings.endMs ?? Number.POSITIVE_INFINITY, timelineDuration(tl));
  if (!(endMs > startMs)) throw new Error("There is nothing on the timeline to export.");
  const { width, height, scale } = exportSize(tl, o.settings.resolution);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const scratchPool = new Map<number, { canvas: Canvas; ctx: SKRSContext2D }>();
  const readers = new Map<string, ClipReader>();
  const stills = new Map<string, FrameSource>();
  const handles = new Map<string, { before: number; after: number }>();
  for (const tr of tl.transitions) {
    const half = tr.durationMs / 2;
    const a = handles.get(tr.fromItemId) ?? { before: 0, after: 0 }; a.after = Math.max(a.after, half); handles.set(tr.fromItemId, a);
    const b = handles.get(tr.toItemId) ?? { before: 0, after: 0 }; b.before = Math.max(b.before, half); handles.set(tr.toItemId, b);
  }
  const res: RenderResources = {
    getFrame(item) { return item.type === "image" ? stills.get(item.assetId) ?? null : readers.get(item.id)?.source ?? null; },
    scratch(w, h, slot) {
      let s = scratchPool.get(slot);
      if (!s || s.canvas.width !== Math.round(w * scale) || s.canvas.height !== Math.round(h * scale)) {
        const c = createCanvas(Math.round(w * scale), Math.round(h * scale)); const x = c.getContext("2d"); x.setTransform(scale, 0, 0, scale, 0, 0);
        s = { canvas: c, ctx: x }; scratchPool.set(slot, s);
      }
      return { canvas: s.canvas, ctx: s.ctx as unknown as CanvasRenderingContext2D };
    },
    getImage(assetId) { return stills.get(assetId) ?? null; },
  };
  async function ensureSources(tMs: number) {
    for (const { item } of layersAt(tl, tMs)) {
      if (!isMedia(item) || item.type === "audio") continue;
      const a = assets[item.assetId];
      if (!a) continue;
      if (item.type === "image") {
        if (!stills.has(a.id)) { const img = await loadImage(a.file); stills.set(a.id, { image: img, width: img.width, height: img.height }); }
        continue;
      }
      let r = readers.get(item.id);
      if (!r) {
        // decode at the size the clip is drawn, never above the source
        const tr = animatedTransform(item, item.display.from);
        const maxScale = Math.max(tr.scale, ...(item.keyframes?.scale ?? []).map((k) => k.value)) * 1.35;
        const box = mediaBox(tl, { ...tr, scale: maxScale }, a.width ?? width, a.height ?? height);
        const k = Math.min(1, Math.max((box.w * scale) / (a.width ?? width), (box.h * scale) / (a.height ?? height)));
        const dw = even((a.width ?? width) * k), dh = even((a.height ?? height) * k);
        const h = handles.get(item.id) ?? { before: 0, after: 0 };
        const from = Math.max(startMs, item.display.from - h.before, item.display.from - item.trim.from / item.playbackRate);
        r = new ClipReader(decodeSource(a, o.useOriginals !== false), item, dw, dh, fps, from, Math.min(endMs, item.display.to + h.after), a.durationMs);
        readers.set(item.id, r);
      }
      await r.seek(tMs);
    }
    for (const [id, r] of readers) { const it = tl.items[id]; const h = handles.get(id)?.after ?? 0; if (!it || tMs > it.display.to + h + 50) { r.close(); readers.delete(id); } }
  }

  o.onProgress?.(0, "audio");
  const wav = path.join(dirs.tmp, `mix_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`);
  await mixAudio(tl, assets, wav, startMs, endMs, { skipItemIds: o.muteItemIds });

  const totalFrames = Math.max(1, Math.round(((endMs - startMs) / 1000) * fps));
  const kbps = Math.round(o.settings.bitrateMbps * 1000);
  const codec = o.settings.format === "webm"
    ? ["-c:v", "libvpx-vp9", "-b:v", `${kbps}k`, "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "160k"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.5)}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
  const enc = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0", "-i", wav, "-map", "0:v:0", "-map", "1:a:0", ...codec, "-r", String(fps), "-shortest", o.out]);
  let encErr = "";
  enc.stderr.on("data", (d: Buffer) => { encErr += d.toString(); });
  enc.stdin.on("error", () => undefined);
  const done = new Promise<number>((resolve) => enc.on("close", (c) => resolve(c ?? -1)));
  try {
    for (let n = 0; n < totalFrames; n++) {
      if (o.isCancelled?.()) throw new Error("cancelled");
      const tMs = startMs + (n * 1000) / fps;
      await ensureSources(tMs);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      renderFrame(ctx as unknown as CanvasRenderingContext2D, tl, tMs, res);
      const px = canvas.data();
      if (!enc.stdin.write(px)) await new Promise<void>((r) => enc.stdin.once("drain", () => r()));
      if (n % 15 === 0) o.onProgress?.(n / totalFrames, "rendering");
    }
    enc.stdin.end();
    o.onProgress?.(0.99, "encoding");
    const code = await done;
    if (code !== 0) throw new Error(`The encoder failed: ${encErr.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
  } catch (e) {
    try { enc.stdin.destroy(); enc.kill("SIGKILL"); } catch { /* gone */ }
    fs.rmSync(o.out, { force: true });
    throw e;
  } finally {
    for (const r of readers.values()) r.close();
    fs.rmSync(wav, { force: true });
  }
  o.onProgress?.(1, "done");
  return { width, height, durationMs: Math.round(endMs - startMs), frames: totalFrames, seconds: (Date.now() - t0) / 1000 };
}

/** One frame of the timeline as a JPEG/PNG buffer (thumbnails, and frames the AI looks at). */
export async function captureFrame(tl: Timeline, assets: Record<string, AssetDoc>, tMs: number, maxSide = 720, format: "jpeg" | "png" = "jpeg"): Promise<Buffer> {
  registerFonts();
  const scale = Math.min(1, maxSide / Math.max(tl.size.width, tl.size.height));
  const width = even(tl.size.width * scale), height = even(tl.size.height * scale);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const frames = new Map<string, FrameSource>();
  for (const { item } of layersAt(tl, tMs)) {
    if (!isMedia(item) || item.type === "audio") continue;
    const a = assets[item.assetId];
    if (!a || frames.has(item.id)) continue;
    if (item.type === "image") { const img = await loadImage(a.file); frames.set(item.id, { image: img, width: img.width, height: img.height }); continue; }
    const src = Math.max(0, Math.min(a.durationMs - 40, item.trim.from + (tMs - item.display.from) * item.playbackRate));
    const tmp = path.join(dirs.tmp, `cap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`);
    try {
      await ffmpeg(["-ss", (src / 1000).toFixed(3), "-i", decodeSource(a, false), "-frames:v", "1", "-q:v", "3", tmp]);
      const img = await loadImage(tmp);
      frames.set(item.id, { image: img, width: img.width, height: img.height });
    } catch { /* leave the layer empty */ } finally { fs.rmSync(tmp, { force: true }); }
  }
  const scratch = new Map<number, { canvas: Canvas; ctx: SKRSContext2D }>();
  const res: RenderResources = {
    getFrame: (item) => frames.get(item.id) ?? null,
    scratch(w, h, slot) { let s = scratch.get(slot); if (!s) { const c = createCanvas(width, height); const x = c.getContext("2d"); x.setTransform(scale, 0, 0, scale, 0, 0); s = { canvas: c, ctx: x }; scratch.set(slot, s); } return { canvas: s.canvas, ctx: s.ctx as unknown as CanvasRenderingContext2D }; },
    getImage: () => null,
  };
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  renderFrame(ctx as unknown as CanvasRenderingContext2D, tl, tMs, res);
  return format === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", 82);
}
