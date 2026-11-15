// Trend intelligence: bring in posts that are already performing, break each one down
// (hook, cut rhythm, captions, sound, structure) and keep the breakdown as a blueprint.
import fs from "node:fs";
import path from "node:path";
import type { TrendBlueprint, TrendCandidate, TrendFormat, TrendOverlay, TrendPost, TrendSlot, TrendSound, TrendStats, WatchSource } from "../../shared/trends.ts";
import { CAPTION_TEMPLATES } from "../../shared/catalog.ts";
import { dirs, llmBackend, YTDLP } from "./config.ts";
import * as db from "./db.ts";
import { emit } from "./events.ts";
import { extractFrames, ffmpeg, run } from "./media.ts";
import { assetPaths, createAsset, getAsset, publicAsset, whenProcessed, type AssetDoc } from "./pipeline.ts";
import { jsonTask } from "./llm.ts";

type TrendDoc = Omit<TrendPost, "urls">;
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };

export function publicTrend(t: TrendDoc): TrendPost {
  const a = t.assetId ? getAsset(t.assetId) : null;
  const pa = a ? publicAsset(a) : null;
  return { ...t, urls: { video: pa?.urls.proxy ?? null, thumbnail: pa?.urls.thumbnail ?? null } };
}
export const listTrends = () => db.list<TrendDoc>("trend").sort((a, b) => b.viralScore - a.viralScore || b.createdAt.localeCompare(a.createdAt));
export const getTrend = (id: string) => db.get<TrendDoc>("trend", id);
function saveTrend(t: TrendDoc) { db.put("trend", t.id, t); emit({ type: "trend", trend: publicTrend(t) }); }

export function publicSound(s: Omit<TrendSound, "urls">): TrendSound {
  const a = getAsset(s.assetId);
  return { ...s, urls: { audio: a ? publicAsset(a).urls.proxy : null } };
}
export const listSounds = () => db.list<Omit<TrendSound, "urls">>("sound").sort((a, b) => b.postIds.length - a.postIds.length || b.totalViews - a.totalViews);

// ---------- hook reading ----------
export function classifyHook(text: string): { type: string; formula: string } {
  const t = text.trim().toLowerCase();
  if (!t) return { type: "visual", formula: "Open on the most striking shot with no words." };
  if (/^pov\b/.test(t)) return { type: "pov", formula: "POV: [a specific situation your viewer has been in]" };
  if (/\b(nobody|no one)\b.*\b(tells?|talks?|told)\b|\bsecret\b|\bwhat they don'?t\b/.test(t)) return { type: "secret", formula: "Nobody tells you this about [topic]" };
  if (/^(stop|don'?t|never|quit)\b/.test(t)) return { type: "warning", formula: "Stop [common mistake] if you want [result]" };
  if (/\b(\d+|one|two|three|four|five|six|seven|ten)\b.*\b(things?|ways?|tips?|mistakes?|reasons?|steps?|signs?|habits?|lessons?|rules?|hacks?)\b/.test(t)) return { type: "list", formula: "[Number] [things/mistakes/ways] [audience] should know about [topic]" };
  if (/\?\s*$/.test(t) || /^(how|why|what|did|do|does|have|are|is|can|would|ever)\b/.test(t)) return { type: "question", formula: "[A question your viewer already asks themselves]?" };
  if (/^(i|my|we|when i|last (week|year|month)|yesterday)\b/.test(t)) return { type: "story", formula: "I [did something specific] and [surprising result]" };
  if (/\b(this is (how|why|what)|here'?s (how|why|what)|this is the)\b/.test(t)) return { type: "how-to", formula: "Here's how to [result] without [pain]" };
  if (/\b(you|your)\b/.test(t)) return { type: "direct", formula: "If you [situation], you need to [action]" };
  return { type: "statement", formula: "[A bold, specific claim about your topic]" };
}

/** Sentences of a transcript with word-accurate times. */
export function sentencesOf(a: Pick<AssetDoc, "transcription">): { text: string; startMs: number; endMs: number; words: number }[] {
  const out: { text: string; startMs: number; endMs: number; words: number }[] = [];
  const words = a.transcription?.segments.flatMap((s) => s.words) ?? [];
  let cur: typeof words = [];
  const flush = () => { if (cur.length) out.push({ text: cur.map((w) => w.word).join(" "), startMs: Math.round(cur[0]!.start * 1000), endMs: Math.round(cur[cur.length - 1]!.end * 1000), words: cur.length }); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 1.1) flush();
    cur.push(w);
    if (/[.!?…]["')]?$/.test(w.word) || cur.length >= 32) flush();
  }
  flush();
  return out;
}

// ---------- blueprint ----------
export function buildBlueprint(a: AssetDoc): TrendBlueprint {
  const dur = a.durationMs;
  const durS = dur / 1000;
  const cuts = (a.visual?.cuts ?? []).filter((c) => c > 0.15 && c < durS - 0.15);
  const bounds = [0, ...cuts, durS];
  const beats = (a.rhythm?.pulseBeats ?? []).map((b) => Math.round(b[0] * 1000));
  const music = (a.musicScore ?? 0) >= 0.45 && beats.length >= 8;
  const words = a.transcription?.segments.flatMap((s) => s.words) ?? [];
  const spoken = words.reduce((s, w) => s + (w.end - w.start), 0);
  const speechCoverage = durS > 0 ? Math.min(1, spoken / durS) : 0;
  const hasSpeech = words.length >= 6 && speechCoverage > 0.12;
  const nearBeat = (ms: number) => beats.some((b) => Math.abs(b - ms) <= 95);
  const slots: TrendSlot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = bounds[i]!, e = bounds[i + 1]!;
    const inSlot = words.filter((w) => (w.start + w.end) / 2 >= s && (w.start + w.end) / 2 < e).reduce((x, w) => x + (w.end - w.start), 0);
    slots.push({ index: i, startMs: Math.round(s * 1000), endMs: Math.round(e * 1000), kind: e > s && inSlot / (e - s) > 0.35 ? "talking" : "broll", onBeat: music && i > 0 ? nearBeat(Math.round(s * 1000)) : false });
  }
  const lens = slots.map((s) => s.endMs - s.startMs);
  const cpm = durS > 0 ? (cuts.length / durS) * 60 : 0;
  const avgShot = lens.length ? lens.reduce((x, y) => x + y, 0) / lens.length : dur;
  const onBeat = music && cuts.length ? cuts.filter((c) => nearBeat(Math.round(c * 1000))).length / cuts.length : null;
  const sents = sentencesOf(a);
  const hookSent = sents[0] && sents[0].startMs < 4000 ? sents[0] : null;
  const hk = classifyHook(hookSent?.text ?? "");
  let format: TrendFormat;
  if (!hasSpeech) format = "montage";
  else if (cuts.length <= 2 || slots.filter((s) => s.kind === "talking").length >= slots.length * 0.7) format = cpm > 14 && slots.some((s) => s.kind === "broll") ? "mixed" : "talking-head";
  else format = "voiceover-broll";
  const w = a.width ?? 9, h = a.height ?? 16;
  const aspect = Math.abs(w / h - 9 / 16) < 0.08 ? "9:16" : Math.abs(w / h - 16 / 9) < 0.1 ? "16:9" : Math.abs(w / h - 1) < 0.08 ? "1:1" : w < h ? "4:5" : "16:9";
  const label = avgShot < 900 ? "very fast" : avgShot < 2200 ? "fast" : avgShot < 4500 ? "medium" : "slow";
  const look = format === "montage" ? "tall-caps" : format === "talking-head" || format === "mixed" ? "bold-pop" : "tiktok-outline";
  const structure: string[] = [];
  if (hookSent) structure.push(`0:00 Hook (${hk.type}): "${hookSent.text.slice(0, 90)}"`);
  else structure.push("0:00 Visual hook: strongest shot first, no speech");
  if (format === "montage") structure.push(`${slots.length} shots, ${music && onBeat !== null && onBeat > 0.5 ? "cut on the beat" : "cut freely"}, about ${(avgShot / 1000).toFixed(1)}s each`);
  else {
    const mid = sents.slice(1, -1);
    if (mid.length) structure.push(`Body: ${mid.length} sentence${mid.length === 1 ? "" : "s"}, ${cuts.length ? `${cuts.length} cuts` : "single take"}${slots.some((s) => s.kind === "broll") ? ", b-roll over the voice" : ""}`);
    const last = sents[sents.length - 1];
    if (last && sents.length > 1) structure.push(`${/follow|subscribe|comment|link|share|save/i.test(last.text) ? "Call to action" : "Close"}: "${last.text.slice(0, 80)}"`);
  }
  const why: string[] = [];
  if (hookSent && hookSent.endMs < 3500) why.push(`The point is clear inside ${(hookSent.endMs / 1000).toFixed(1)} seconds.`);
  if (cuts.filter((c) => c < 3).length >= 2) why.push("Two or more cuts in the first three seconds keep the opening moving.");
  if (onBeat !== null && onBeat > 0.6) why.push(`${Math.round(onBeat * 100)}% of the cuts land on the beat.`);
  if (durS <= 20) why.push("Short enough to be watched to the end and looped.");
  if (hasSpeech && words.length / Math.max(0.1, spoken / 60) > 170) why.push("Fast delivery with the pauses removed.");
  return {
    format, durationMs: dur, aspect,
    hook: { spoken: hookSent?.text ?? null, onScreen: null, seconds: hookSent ? Math.round(hookSent.endMs / 100) / 10 : Math.min(3, durS), type: hk.type, formula: hk.formula },
    slots,
    pacing: { cuts: cuts.length, cutsPerMinute: Math.round(cpm * 10) / 10, avgShotMs: Math.round(avgShot), medianShotMs: Math.round(median(lens)), cutsInFirst3s: cuts.filter((c) => c < 3).length, label },
    audio: { hasSpeech, speechCoverage: Math.round(speechCoverage * 100) / 100, wordsPerMinute: hasSpeech && spoken > 1 ? Math.round(words.length / (durS / 60)) : null, hasMusic: music, bpm: music ? a.rhythm?.averageBpm ?? null : null, beatsMs: music ? beats : [], cutsOnBeat: onBeat === null ? null : Math.round(onBeat * 100) / 100, musicUnderSpeech: music && hasSpeech },
    captions: { present: null, look, mode: CAPTION_TEMPLATES.find((c) => c.id === look)?.style.mode ?? "highlight", position: 0.66, uppercase: null, description: "Not read yet. Caption look chosen from the format." },
    overlays: [],
    color: { brightness: a.visual?.luma ?? 0.5, saturation: a.visual?.sat ?? 0.3, filterId: null },
    structure, whyItWorks: why,
    recreate: format === "montage"
      ? `Bring ${slots.length} clips. Each gets the same slot length as the original${music ? ", locked to the same sound" : ""}. Put your strongest shot first.`
      : `Record yourself making one point. Open with a ${hk.type} hook in the first ${Math.max(2, Math.round((hookSent?.endMs ?? 3000) / 1000))} seconds, keep it to about ${Math.round(durS)} seconds${slots.some((s) => s.kind === "broll") ? ", and bring a few b-roll clips to cover the middle" : ""}.`,
    source: "heuristic",
  };
}

interface VisionRead { onScreenHook?: string | null; captions?: { present: boolean; look?: string; uppercase?: boolean; position?: number; description?: string }; overlays?: { text: string; position: "top" | "center" | "bottom"; role: TrendOverlay["role"]; fromSeconds: number; toSeconds: number }[]; format?: TrendFormat; structure?: string[]; whyItWorks?: string[]; recreate?: string; niche?: string[]; title?: string }
/** Look at frames of the post to read what the signal analysis cannot: on-screen text, caption look, why it works. */
export async function visionRead(a: AssetDoc, bp: TrendBlueprint, meta: { caption?: string | null; stats?: TrendStats }): Promise<VisionRead | null> {
  if (llmBackend() === "none") return null;
  const durS = a.durationMs / 1000;
  const early = [0.4, 1.2, 2.2, 3.2].filter((t) => t < durS - 0.2);
  const rest = Array.from({ length: 6 }, (_, i) => 4 + ((durS - 4.4) * i) / 5).filter((t) => t > 3.4 && t < durS - 0.2);
  const dir = path.join(dirs.frames, `trend_${a.id}`);
  const p = assetPaths(a);
  const frames = await extractFrames(fs.existsSync(p.proxy) ? p.proxy : a.file, [...early, ...rest], dir, 360, "t");
  if (!frames.length) return null;
  const looks = CAPTION_TEMPLATES.map((c) => `"${c.id}": ${c.description}`).join("\n");
  const res = await jsonTask<VisionRead>({
    task: "trend-read",
    system: "You analyse short-form videos for a creator who wants to make their own version of formats that perform. You are precise about what is on screen and practical about why a video holds attention. You never invent on-screen text you cannot read.",
    prompt: `Frames from one short video (${durS.toFixed(1)}s), taken at: ${frames.map((f, i) => `frame ${i} = ${f.time.toFixed(1)}s`).join(", ")}.
What is said: ${a.transcription ? `"${a.transcription.segments.map((s) => s.text).join(" ").slice(0, 1800)}"` : "(no speech)"}
Measured: ${bp.pacing.cuts} cuts (${bp.pacing.cutsPerMinute}/min, ${bp.pacing.label}), ${bp.audio.hasMusic ? `music at ${bp.audio.bpm} BPM${bp.audio.cutsOnBeat !== null ? `, ${Math.round(bp.audio.cutsOnBeat * 100)}% of cuts on the beat` : ""}` : "no music detected"}, speech covers ${Math.round(bp.audio.speechCoverage * 100)}%.
${meta.caption ? `Post caption: "${meta.caption.slice(0, 400)}"` : ""}${meta.stats?.views ? `\nViews: ${meta.stats.views}` : ""}

Caption looks available in the editor (pick the closest one for "look"):
${looks}

Return JSON:
{"title": "5-8 word name for this format", "onScreenHook": "text shown on screen in the first 3 seconds, exactly as written, or null",
 "captions": {"present": true|false, "look": "one id from the list", "uppercase": true|false, "position": 0.0-1.0 vertical centre of the captions as a fraction of frame height, "description": "font feel, colours, outline/box, words at a time"},
 "overlays": [{"text": "exact text", "position": "top|center|bottom", "role": "hook|label|cta", "fromSeconds": 0, "toSeconds": 3}],
 "format": "talking-head|voiceover-broll|montage|text-on-video|mixed",
 "structure": ["0:00 ...", "0:03 ..."], "whyItWorks": ["3-5 concrete reasons tied to what you see and hear"],
 "recreate": "2-3 sentences telling a creator exactly what to film and say to make their own version", "niche": ["2-4 lowercase topic tags"]}
"overlays" lists titles and labels only, not the running speech captions.`,
    imagePaths: frames.map((f) => f.file),
    effort: "low",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}
function applyVision(bp: TrendBlueprint, v: VisionRead): TrendBlueprint {
  const out = structuredClone(bp);
  if (v.format && ["talking-head", "voiceover-broll", "montage", "text-on-video", "mixed"].includes(v.format)) out.format = v.format;
  if (v.onScreenHook) out.hook.onScreen = v.onScreenHook;
  if (v.captions) {
    const look = CAPTION_TEMPLATES.find((c) => c.id === v.captions!.look);
    out.captions = { present: !!v.captions.present, look: look?.id ?? out.captions.look, mode: look?.style.mode ?? out.captions.mode, position: typeof v.captions.position === "number" ? Math.min(0.92, Math.max(0.08, v.captions.position)) : out.captions.position, uppercase: v.captions.uppercase ?? null, description: v.captions.description ?? "" };
  }
  if (Array.isArray(v.overlays)) out.overlays = v.overlays.filter((o) => o?.text).slice(0, 8).map((o) => ({ text: String(o.text), position: ["top", "center", "bottom"].includes(o.position) ? o.position : "top", role: o.role ?? "label", startMs: Math.max(0, Math.round((o.fromSeconds ?? 0) * 1000)), endMs: Math.round((o.toSeconds ?? 3) * 1000) }));
  if (v.structure?.length) out.structure = v.structure.slice(0, 8).map(String);
  if (v.whyItWorks?.length) out.whyItWorks = v.whyItWorks.slice(0, 6).map(String);
  if (v.recreate) out.recreate = String(v.recreate);
  out.source = "vision";
  return out;
}

// ---------- scoring ----------
export function rescore() {
  const all = db.list<TrendDoc>("trend");
  const maxViews = Math.max(1, ...all.map((t) => t.stats.views ?? 0));
  for (const t of all) {
    const v = t.stats.views ?? 0;
    const eng = v > 0 ? ((t.stats.likes ?? 0) + (t.stats.comments ?? 0) * 2 + (t.stats.shares ?? 0) * 3) / v : 0;
    const reach = v > 0 ? Math.log10(v + 1) / Math.log10(maxViews + 1) : 0.35;
    const ageDays = t.source.postedAt ? Math.max(0, (Date.now() - Date.parse(t.source.postedAt)) / 86400000) : 14;
    const fresh = Math.exp(-ageDays / 30);
    const score = Math.round(100 * Math.min(1, 0.6 * reach + 0.25 * Math.min(1, eng * 6) + 0.15 * fresh));
    if (score !== t.viralScore) { t.viralScore = score; db.put("trend", t.id, t); }
  }
}

// ---------- ingest ----------
export interface IngestMeta { title?: string; platform?: TrendPost["source"]["platform"]; url?: string | null; author?: string | null; handle?: string | null; caption?: string | null; hashtags?: string[]; postedAt?: string | null; stats?: Partial<TrendStats>; soundTitle?: string | null; soundAuthor?: string | null; deep?: boolean }

async function finishTrend(t: TrendDoc, assetId: string, meta: IngestMeta) {
  t.assetId = assetId; t.status = "processing"; saveTrend(t);
  const a = await whenProcessed(assetId);
  t.durationMs = a.durationMs; t.width = a.width; t.height = a.height;
  if (a.type !== "video") { t.status = "error"; t.error = "A trend post has to be a video."; saveTrend(t); return; }
  t.status = "analyzing"; saveTrend(t);
  let bp = buildBlueprint(a);
  let vr: VisionRead | null = null;
  if (meta.deep !== false) { try { vr = await visionRead(a, bp, { caption: t.source.caption, stats: t.stats }); } catch (e) { console.warn("[trend] vision read failed:", (e as Error).message); } }
  if (vr) { bp = applyVision(bp, vr); if (vr.niche?.length) t.niche = vr.niche.map(String).slice(0, 5); if (vr.title && !meta.title) t.title = String(vr.title); }
  t.blueprint = bp;
  if (!t.niche.length) t.niche = t.source.hashtags.slice(0, 4);
  // keep the sound as a reusable track when the post is cut to music
  if (bp.audio.hasMusic && a.hasAudio) {
    try {
      const key = (t.sound?.title ? `${t.sound.title}|${t.sound.author ?? ""}` : `post:${t.id}`).toLowerCase();
      let s = db.list<Omit<TrendSound, "urls"> & { key?: string }>("sound").find((x) => x.key === key);
      if (!s) {
        const tmp = path.join(dirs.tmp, `sound_${t.id}.m4a`);
        await ffmpeg(["-i", a.file, "-vn", "-c:a", "aac", "-b:a", "192k", tmp]);
        const title = t.sound?.title ?? `Sound from ${t.source.handle ? `@${t.source.handle}` : t.title}`;
        const sa = await createAsset({ tmpPath: tmp, name: `${title.replace(/[^\w .-]+/g, "").slice(0, 60) || "sound"}.m4a`, contentType: "music", origin: { kind: "trend-sound", ref: t.id } });
        const done = await whenProcessed(sa.id);
        s = { id: db.newId("snd"), key, title, author: t.sound?.author ?? t.source.author ?? null, assetId: sa.id, durationMs: done.durationMs, bpm: done.rhythm?.averageBpm ?? bp.audio.bpm, postIds: [], totalViews: 0, createdAt: new Date().toISOString() };
      }
      if (!s.postIds.includes(t.id)) s.postIds.push(t.id);
      s.totalViews = s.postIds.map((id) => (id === t.id ? t.stats.views ?? 0 : getTrend(id)?.stats.views ?? 0)).reduce((x, y) => x + y, 0);
      db.put("sound", s.id, s);
      t.soundId = s.id;
      emit({ type: "sound", sound: publicSound(s) });
    } catch (e) { console.warn("[trend] sound extraction failed:", (e as Error).message); }
  }
  t.status = "ready"; t.error = null;
  saveTrend(t);
  rescore();
}

function newTrend(meta: IngestMeta, fallbackTitle: string): TrendDoc {
  return {
    id: db.newId("tr"), createdAt: new Date().toISOString(), status: "downloading", error: null, title: meta.title || fallbackTitle,
    source: { platform: meta.platform ?? "upload", url: meta.url ?? null, author: meta.author ?? null, handle: meta.handle ?? null, caption: meta.caption ?? null, hashtags: meta.hashtags ?? [], postedAt: meta.postedAt ?? null },
    stats: { views: meta.stats?.views ?? null, likes: meta.stats?.likes ?? null, comments: meta.stats?.comments ?? null, shares: meta.stats?.shares ?? null },
    sound: meta.soundTitle ? { title: meta.soundTitle, author: meta.soundAuthor ?? null, original: false } : null,
    soundId: null, assetId: null, durationMs: 0, width: null, height: null, niche: [], viralScore: 0, blueprint: null,
  };
}

export async function ingestTrendFile(tmpPath: string, name: string, meta: IngestMeta = {}): Promise<TrendDoc> {
  const t = newTrend(meta, name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  saveTrend(t);
  try {
    const a = await createAsset({ tmpPath, name, origin: { kind: "trend", ref: t.id }, copy: false });
    void finishTrend(t, a.id, meta).catch((e) => { t.status = "error"; t.error = (e as Error).message; saveTrend(t); });
  } catch (e) { t.status = "error"; t.error = (e as Error).message; saveTrend(t); }
  return t;
}

export function platformOf(url: string): TrendPost["source"]["platform"] {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return "link";
}
const tagsOf = (text: string | null | undefined) => [...new Set((text ?? "").match(/#[\p{L}\p{N}_]+/gu)?.map((x) => x.slice(1).toLowerCase()) ?? [])];

/** Bring in a public post by link. Needs network access to the platform; reports a clear error when it is not reachable. */
export async function ingestTrendUrl(url: string, meta: IngestMeta = {}): Promise<TrendDoc> {
  if (!/^https?:\/\//i.test(url)) throw new Error("That is not a link.");
  const existing = db.list<TrendDoc>("trend").find((x) => x.source.url === url);
  if (existing) return existing;
  const t = newTrend({ ...meta, platform: platformOf(url), url }, "Importing…");
  saveTrend(t);
  void (async () => {
    const base = path.join(dirs.tmp, `dl_${t.id}`);
    try {
      const r = await run(YTDLP, ["--no-playlist", "--no-progress", "--no-warnings", "--max-filesize", "600M", "--match-filter", "duration <= 1200", "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4", "--write-info-json", "-o", `${base}.%(ext)s`, url], { timeoutMs: 600_000 });
      const file = [".mp4", ".webm", ".mkv", ".mov"].map((e) => base + e).find((f) => fs.existsSync(f));
      if (r.code !== 0 || !file) {
        const msg = r.stderr.split("\n").filter((l) => /ERROR/.test(l)).pop() ?? r.stderr.trim().split("\n").pop() ?? "download failed";
        throw new Error(/Unable to connect|tunnel|proxy|403|Temporary failure|getaddrinfo|timed out|Connection/i.test(msg) ? `The post could not be reached from this server (${platformOf(url)} is not accessible on this network). Upload the video file instead, or allow access to the platform.` : `The post could not be imported: ${msg.replace(/^ERROR:\s*/, "").slice(0, 220)}`);
      }
      let info: Record<string, any> = {};
      try { info = JSON.parse(fs.readFileSync(`${base}.info.json`, "utf8")); } catch { /* no metadata */ }
      t.title = meta.title || String(info.title || info.description || "Imported post").slice(0, 90);
      t.source.author = info.uploader ?? info.channel ?? null;
      t.source.handle = info.uploader_id ?? info.channel_id ?? null;
      t.source.caption = info.description ?? null;
      t.source.hashtags = [...new Set([...(Array.isArray(info.tags) ? info.tags.map((x: unknown) => String(x).toLowerCase()) : []), ...tagsOf(info.description)])].slice(0, 20);
      t.source.postedAt = info.timestamp ? new Date(info.timestamp * 1000).toISOString() : null;
      t.stats = { views: info.view_count ?? null, likes: info.like_count ?? null, comments: info.comment_count ?? null, shares: info.repost_count ?? null };
      if (info.track) t.sound = { title: String(info.track), author: info.artist ?? (Array.isArray(info.artists) ? info.artists.join(", ") : null), original: /original/i.test(String(info.track)) };
      saveTrend(t);
      const a = await createAsset({ tmpPath: file, name: `${(info.id ?? t.id)}.mp4`, origin: { kind: "trend", ref: t.id } });
      await finishTrend(t, a.id, meta);
    } catch (e) {
      t.status = "error"; t.error = (e as Error).message; saveTrend(t);
    } finally {
      for (const f of fs.readdirSync(dirs.tmp)) if (f.startsWith(`dl_${t.id}`)) fs.rmSync(path.join(dirs.tmp, f), { force: true });
    }
  })();
  return t;
}

export function deleteTrend(id: string) {
  const t = getTrend(id);
  if (!t) return;
  for (const s of db.list<Omit<TrendSound, "urls">>("sound")) if (s.postIds.includes(id)) { s.postIds = s.postIds.filter((x) => x !== id); db.put("sound", s.id, s); }
  db.del("trend", id);
  emit({ type: "trend-deleted", id });
}

// ---------- watchlist: accounts, hashtags and sounds to keep an eye on ----------
export const listSources = () => db.list<WatchSource>("watch");
export function addSource(s: Pick<WatchSource, "platform" | "kind" | "value">): WatchSource {
  const doc: WatchSource = { id: db.newId("w"), platform: s.platform, kind: s.kind, value: s.value.trim().replace(/^[@#]/, ""), lastChecked: null, lastError: null };
  return db.put("watch", doc.id, doc);
}
export function sourceUrl(s: WatchSource): string {
  if (s.kind === "url") return s.value;
  if (s.platform === "tiktok") return s.kind === "account" ? `https://www.tiktok.com/@${s.value}` : s.kind === "hashtag" ? `https://www.tiktok.com/tag/${s.value}` : `https://www.tiktok.com/music/${s.value}`;
  if (s.platform === "instagram") return s.kind === "account" ? `https://www.instagram.com/${s.value}/reels/` : `https://www.instagram.com/explore/tags/${s.value}/`;
  return s.kind === "account" ? `https://www.youtube.com/@${s.value}/shorts` : `https://www.youtube.com/hashtag/${s.value}/shorts`;
}
/** List recent posts of a watched source and rank them by views per hour. */
export async function refreshSource(id: string, limit = 25): Promise<{ source: WatchSource; candidates: TrendCandidate[] }> {
  const s = db.get<WatchSource>("watch", id);
  if (!s) throw new Error("source not found");
  const r = await run(YTDLP, ["--flat-playlist", "--playlist-end", String(limit), "--no-warnings", "-J", sourceUrl(s)], { timeoutMs: 180_000 });
  s.lastChecked = new Date().toISOString();
  let entries: Record<string, any>[] = [];
  try { entries = (JSON.parse(r.stdout).entries ?? []) as Record<string, any>[]; } catch { /* no listing */ }
  if (r.code !== 0 || !entries.length) {
    s.lastError = (r.stderr.split("\n").filter((l) => /ERROR/.test(l)).pop() ?? "No posts could be listed for this source.").replace(/^ERROR:\s*/, "").slice(0, 240);
    db.put("watch", s.id, s);
    return { source: s, candidates: [] };
  }
  s.lastError = null;
  db.put("watch", s.id, s);
  const known = new Set(db.list<TrendDoc>("trend").map((t) => t.source.url));
  const out: TrendCandidate[] = [];
  for (const e of entries) {
    const url = e.webpage_url ?? e.url;
    if (!url) continue;
    const posted = e.timestamp ? new Date(e.timestamp * 1000).toISOString() : null;
    const hours = posted ? Math.max(1, (Date.now() - Date.parse(posted)) / 3600000) : null;
    const c: TrendCandidate = { id: `c_${Buffer.from(String(url)).toString("base64url").slice(-24)}`, url, platform: s.platform, title: String(e.title ?? e.description ?? "").slice(0, 120), author: e.uploader ?? e.channel ?? s.value, views: e.view_count ?? null, likes: e.like_count ?? null, postedAt: posted, durationSec: e.duration ?? null, velocity: e.view_count && hours ? Math.round(e.view_count / hours) : null, sourceId: s.id, ingested: known.has(url) };
    db.put("candidate", c.id, c);
    out.push(c);
  }
  out.sort((a, b) => (b.velocity ?? b.views ?? 0) - (a.velocity ?? a.views ?? 0));
  return { source: s, candidates: out };
}
export const listCandidates = () => db.list<TrendCandidate>("candidate").sort((a, b) => (b.velocity ?? b.views ?? 0) - (a.velocity ?? a.views ?? 0));
