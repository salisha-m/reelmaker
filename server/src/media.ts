// ffmpeg / ffprobe helpers. Everything is spawned with argument arrays, never through a shell.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RunResult { code: number; stdout: string; stderr: string }
export function run(bin: string, args: string[], opts: { input?: Buffer; onStderr?: (chunk: string) => void; timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; maxStdout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    const timer = opts.timeoutMs ? setTimeout(() => { p.kill("SIGKILL"); }, opts.timeoutMs) : null;
    p.stdout.on("data", (d: Buffer) => { outLen += d.length; if (outLen <= (opts.maxStdout ?? 256 * 1024 * 1024)) out.push(d); });
    p.stderr.on("data", (d: Buffer) => { const s = d.toString(); if (err.length < 4_000_000) err += s; opts.onStderr?.(s); });
    p.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    p.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: err }); });
    if (opts.input) p.stdin.end(opts.input); else p.stdin.end();
  });
}
export async function ffmpeg(args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], opts);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.split("\n").filter(Boolean).slice(-4).join(" | ")}`);
  return r;
}

export interface Probe { durationMs: number; width: number | null; height: number | null; fps: number | null; hasAudio: boolean; hasVideo: boolean; rotation: number; videoCodec: string | null; audioCodec: string | null; createdAt: string | null; isImage: boolean }
export async function probe(file: string): Promise<Probe> {
  const r = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  if (r.code !== 0) throw new Error(`This file could not be read as media: ${r.stderr.trim().split("\n").pop() ?? "unknown error"}`);
  const j = JSON.parse(r.stdout) as { streams?: Record<string, any>[]; format?: Record<string, any> };
  const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
  const fmt = String(j.format?.format_name ?? "");
  const isImage = !!v && (/(image2|png_pipe|jpeg_pipe|webp_pipe|gif|bmp_pipe|tiff_pipe|heif)/.test(fmt) || ["png", "mjpeg", "webp", "bmp", "tiff", "gif"].includes(String(v.codec_name))) && !a && !(Number(v.nb_frames) > 1 && Number(j.format?.duration) > 0.2);
  let rotation = 0;
  const sd = (v?.side_data_list ?? []).find((x: any) => x.rotation !== undefined);
  if (sd) rotation = Number(sd.rotation) || 0;
  else if (v?.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
  let width = v ? Number(v.width) : null, height = v ? Number(v.height) : null;
  if (width && height && Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const [n, d] = String(v?.avg_frame_rate ?? v?.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = v && d ? Math.round((n! / d) * 1000) / 1000 : null;
  const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  return {
    durationMs: isImage ? 0 : Math.round(dur * 1000), width, height, fps: isImage ? null : fps, hasAudio: !!a, hasVideo: !!v && !isImage, rotation,
    videoCodec: v ? String(v.codec_name) : null, audioCodec: a ? String(a.codec_name) : null, createdAt: j.format?.tags?.creation_time ?? null, isImage,
  };
}

/** 720p H.264 editing copy with a short GOP so scrubbing is frame-accurate enough. */
export async function makeProxy(src: string, out: string, onProgress?: (p: number) => void, durationMs = 0): Promise<void> {
  const vf = "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)':flags=bicubic,fps=fps='min(source_fps,30)',format=yuv420p";
  await ffmpeg(["-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", "-progress", "pipe:2", out], {
    onStderr: (s) => { const m = /out_time_ms=(\d+)/.exec(s); if (m && durationMs) onProgress?.(Math.min(1, Number(m[1]) / 1000 / durationMs)); },
  });
}
export async function makeAudioProxy(src: string, out: string): Promise<void> {
  await ffmpeg(["-i", src, "-vn", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", out]);
}
export async function makeThumbnail(src: string, out: string, atSec: number, isImage = false): Promise<void> {
  const args = isImage ? ["-i", src] : ["-ss", String(Math.max(0, atSec)), "-i", src];
  await ffmpeg([...args, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "4", out]);
}
/** Mono 16 kHz WAV for speech recognition and beat analysis. */
export async function extractWav(src: string, out: string): Promise<void> {
  await ffmpeg(["-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out]);
}
/** Peak envelope, `perSecond` values a second, 0..1. */
export async function waveformPeaks(wav: string, perSecond = 40): Promise<number[]> {
  const buf = fs.readFileSync(wav);
  const dataAt = buf.indexOf(Buffer.from("data"));
  const pcm = buf.subarray(dataAt >= 0 ? dataAt + 8 : 44);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const win = Math.floor(16000 / perSecond);
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    let max = 0;
    const end = Math.min(samples.length, i + win);
    for (let k = i; k < end; k += 4) { const v = Math.abs(samples[k]!); if (v > max) max = v; }
    peaks.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return peaks;
}
/** One JPEG per requested time. Returns the files that were written. */
export async function extractFrames(src: string, timesSec: number[], outDir: string, width = 384, prefix = "f"): Promise<{ time: number; file: string }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const out: { time: number; file: string }[] = [];
  const jobs = timesSec.map((t, i) => async () => {
    const file = path.join(outDir, `${prefix}_${String(i).padStart(3, "0")}.jpg`);
    try { await ffmpeg(["-ss", t.toFixed(3), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "5", file]); if (fs.existsSync(file)) out.push({ time: t, file }); } catch { /* frame past the end */ }
  });
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map((j) => j()));
  return out.sort((a, b) => a.time - b.time);
}
/** Shot boundaries (seconds) from ffmpeg's scene score. */
export async function detectCuts(src: string, threshold = 0.3): Promise<number[]> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", src, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"]);
  const cuts: number[] = [];
  for (const m of r.stderr.matchAll(/pts_time:([0-9.]+)/g)) cuts.push(Math.round(Number(m[1]) * 1000) / 1000);
  // drop boundaries closer than 150 ms (flashes, fast dissolves)
  return cuts.filter((c, i) => i === 0 || c - cuts[i - 1]! > 0.15);
}
export interface FrameStat { t: number; luma: number; sat: number; motion: number }
/** Brightness, saturation and motion sampled a few times a second. */
export async function frameStats(src: string, fps = 2): Promise<FrameStat[]> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", src, "-an", "-vf", `fps=${fps},scale=160:-2,signalstats,select='gte(scene,0)',metadata=print:file=-`, "-f", "null", "-"], { maxStdout: 64 * 1024 * 1024 });
  const stats: FrameStat[] = [];
  let cur: Partial<FrameStat> | null = null;
  for (const line of r.stdout.split("\n")) {
    const f = /pts_time:([0-9.]+)/.exec(line);
    if (f) { if (cur?.t !== undefined) stats.push({ t: cur.t, luma: cur.luma ?? 0, sat: cur.sat ?? 0, motion: cur.motion ?? 0 }); cur = { t: Number(f[1]) }; continue; }
    if (!cur) continue;
    const kv = /lavfi\.([a-zA-Z_.]+)=([0-9.eE+-]+)/.exec(line);
    if (!kv) continue;
    if (kv[1] === "signalstats.YAVG") cur.luma = Number(kv[2]) / 255;
    else if (kv[1] === "signalstats.SATAVG") cur.sat = Math.min(1, Number(kv[2]) / 128);
    else if (kv[1] === "scene_score") cur.motion = Number(kv[2]);
  }
  if (cur?.t !== undefined) stats.push({ t: cur.t, luma: cur.luma ?? 0, sat: cur.sat ?? 0, motion: cur.motion ?? 0 });
  return stats;
}
