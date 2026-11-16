// Autopilot: make the video. A trend blueprint says what works (hook first, cut rhythm,
// caption look, sound); this fills it with the creator's own footage.
import type { ID, MediaItem, Template, Timeline } from "../../shared/types.ts";
import type { CreatorProfile, Idea, RemixReport, TrendBlueprint, TrendFormat } from "../../shared/trends.ts";
import { CANVAS_PRESETS, CAPTION_TEMPLATES, FILLER_WORDS, TEMPLATES, captionTemplate } from "../../shared/catalog.ts";
import * as T from "../../shared/timeline.ts";
import * as db from "./db.ts";
import { jsonTask, lastLlmError } from "./llm.ts";
import { llmBackend } from "./config.ts";
import type { AssetDoc } from "./pipeline.ts";
import { classifyHook, getTrend, listTrends, sentencesOf } from "./trends.ts";

export interface Sentence { n: number; assetId: ID; text: string; startMs: number; endMs: number; words: number }
export interface RemixOptions {
  blueprint: TrendBlueprint | null;
  assets: AssetDoc[];
  musicAsset?: AssetDoc | null;
  targetSeconds?: number;
  captionLook?: string;
  captions?: boolean;
  hookText?: string | null;
  aspect?: string;
  topic?: string;
  profile?: CreatorProfile | null;
  plan?: AiPlan | null;
  title?: string;
  /** A built-in structure (Short Talking Head, Vlog, Long Podcast, Beat Montage). */
  template?: Template | null;
}
export interface AiPlan { hookSentence?: number; keepSentences?: number[]; hookOverlay?: string | null; emphasisWords?: string[]; broll?: { atSentence: number; assetId: string }[]; clipOrder?: string[]; overlays?: { text: string; fromSeconds: number; toSeconds: number; position: "top" | "center" | "bottom" }[]; title?: string; postCaption?: string; hashtags?: string[] }

const isSpeech = (a: AssetDoc) => a.type !== "image" && (a.transcription?.segments.flatMap((s) => s.words).length ?? 0) >= 8;
const STRONG = /\b(never|always|nobody|everyone|secret|mistake|stop|truth|biggest|best|worst|actually|free|money|first|only|every|most|easy|fast|proof|why|how)\b/i;

export function inventorySentences(assets: AssetDoc[]): Sentence[] {
  const out: Sentence[] = [];
  for (const a of assets.filter(isSpeech)) for (const s of sentencesOf(a)) out.push({ n: out.length, assetId: a.id, ...s });
  return out;
}
function hookScore(s: Sentence, idx: number, total: number): number {
  const t = s.text.toLowerCase();
  let v = 0;
  if (s.words >= 4 && s.words <= 16) v += 2; else if (s.words > 24) v -= 2;
  if (/\?$/.test(t)) v += 1.5;
  if (STRONG.test(t)) v += 1.5;
  if (/\b\d+\b|percent|%/.test(t)) v += 1;
  if (/\b(you|your)\b/.test(t)) v += 1;
  if (["secret", "warning", "list", "question", "how-to"].includes(classifyHook(s.text).type)) v += 1.5;
  if (/^(so|okay|ok|um|uh|and|but|yeah|alright|hi|hey|hello)\b/.test(t)) v -= 1.5;
  if (/\b(follow|subscribe|like and|link in)\b/.test(t)) v -= 4;
  v += Math.max(0, 1.5 - (idx / Math.max(1, total)) * 3); // earlier lines usually set up the point
  return v;
}
function punchy(text: string, maxWords = 9): string {
  let words = text.replace(/[“”"]/g, "").split(/\s+/).filter(Boolean);
  while (words.length > 3 && /^(so|okay|ok|um|uh|and|but|well|yeah|like|alright)[,.]?$/i.test(words[0]!)) words.shift();
  if (words.length > maxWords) {
    // stop at punctuation, or just before a connecting word, so the line does not end mid-thought
    let cut = -1;
    for (let i = Math.min(words.length - 1, maxWords); i >= 3; i--) {
      if (/[,;:—-]$/.test(words[i - 1]!)) { cut = i; break; }
      if (/^(about|and|because|but|for|from|if|in|of|on|so|that|to|when|which|while|with|is|are)$/i.test(words[i]!)) { cut = i; break; }
    }
    words = words.slice(0, cut >= 3 ? cut : maxWords);
  }
  return words.join(" ").replace(/[.,;:—-]+$/, "").trim();
}
function emphasisFrom(sentences: Sentence[]): string[] {
  const out = new Set<string>();
  for (const s of sentences) for (const w of s.text.split(/\s+/)) {
    const n = w.toLowerCase().replace(/[^\p{L}\p{N}%']/gu, "");
    if (!n || FILLER_WORDS.has(n)) continue;
    if (/\d|%/.test(n) || /^(never|always|nobody|everyone|secret|mistake|stop|free|money|biggest|worst|best|every|only|proof|truth)$/.test(n)) out.add(n);
  }
  return [...out].slice(0, 24);
}
/** The liveliest window of a clip that has not been used yet. */
function bestWindow(a: AssetDoc, lenMs: number, used: { from: number; to: number }[]): { from: number; to: number } {
  if (a.type === "image") return { from: 0, to: lenMs };
  const dur = a.durationMs;
  if (dur <= lenMs + 80) return { from: 0, to: dur };
  const curve = a.visual?.curve ?? [];
  let best = Math.max(0, (dur - lenMs) / 2), bestScore = -Infinity;
  for (let s = 0; s + lenMs <= dur; s += 250) {
    const e = s + lenMs;
    const pts = curve.filter((c) => c[0] * 1000 >= s && c[0] * 1000 < e);
    let score = pts.length ? pts.reduce((x, c) => x + c[1], 0) / pts.length : 0;
    const overlap = used.reduce((x, u) => x + Math.max(0, Math.min(e, u.to) - Math.max(s, u.from)), 0);
    score -= (overlap / lenMs) * 1.5;
    score -= Math.abs(s + lenMs / 2 - dur / 2) / dur * 0.01; // slight pull to the middle on ties
    if (s < 200) score -= 0.02; // the first frames of a clip are often the camera settling
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return { from: Math.round(best), to: Math.round(best + lenMs) };
}
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 3));

/** A built-in template expressed as a blueprint, so templates and trends drive the same builder. */
export function templateBlueprint(t: Template): TrendBlueprint {
  const format: TrendFormat = t.id === "beat-montage" ? "montage" : t.id === "vlog" ? "mixed" : "talking-head";
  const durationMs = t.id === "short-talking-head" ? 45000 : t.id === "vlog" ? 60000 : t.id === "beat-montage" ? 25000 : Math.round(((t.defaults.targetSeconds[0] + t.defaults.targetSeconds[1]) / 2) * 1000);
  const look = !t.defaults.captionsOn ? "clean-pod" : t.id === "vlog" ? "tiktok-outline" : t.id === "beat-montage" ? "tall-caps" : "bold-pop";
  const shot = t.id === "beat-montage" ? 1000 : t.id === "vlog" ? 2600 : 3000;
  return {
    format, durationMs, aspect: t.aspect,
    hook: { spoken: null, onScreen: null, seconds: 2, type: t.id === "beat-montage" ? "visual" : "statement", formula: t.guidance.structure.split(". ")[0]! },
    slots: [],
    pacing: { cuts: 0, cutsPerMinute: 0, avgShotMs: shot, medianShotMs: shot, cutsInFirst3s: 0, label: t.id === "long-podcast" ? "slow" : "fast" },
    audio: { hasSpeech: t.id !== "beat-montage", speechCoverage: 0, wordsPerMinute: null, hasMusic: t.defaults.musicOn, bpm: null, beatsMs: [], cutsOnBeat: null, musicUnderSpeech: t.defaults.musicOn && t.id !== "beat-montage" },
    captions: { present: t.defaults.captionsOn, look, mode: CAPTION_TEMPLATES.find((c) => c.id === look)?.style.mode ?? "phrase", position: 0.66, uppercase: null, description: t.guidance.captions },
    overlays: [], color: { brightness: 0.5, saturation: 0.3, filterId: null },
    structure: [t.guidance.structure, t.guidance.pacing, t.guidance.ending], whyItWorks: [], recreate: t.description, source: "heuristic",
  };
}
export const templateById = (id: string | null | undefined) => (id ? TEMPLATES.find((t) => t.id === id) ?? null : null);

/** How to lay a track under an edit of `totalMs`: one play, or repeats of whole bars so the beat grid carries on. */
export function loopPlan(music: AssetDoc, totalMs: number): { pieces: { from: number; to: number; at: number }[]; beats: number[] } {
  const beats = (music.rhythm?.pulseBeats ?? []).map((b) => Math.round(b[0] * 1000));
  const downs = (music.rhythm?.downbeats ?? []).map((b) => Math.round(b[0] * 1000));
  const one = { pieces: [{ from: 0, to: Math.min(music.durationMs, totalMs), at: 0 }], beats: beats.filter((b) => b <= Math.min(music.durationMs, totalMs)) };
  if (music.durationMs >= totalMs || downs.length < 3) return one;
  const loopFrom = downs[1]!, loopTo = downs[downs.length - 1]!;
  if (loopTo - loopFrom < 4000) return one;
  // the first play stops on its last downbeat; each repeat starts on a downbeat, so the rhythm never skips
  const pieces = [{ from: 0, to: loopTo, at: 0 }];
  const grid = beats.filter((b) => b < loopTo);
  for (let at = loopTo; at < totalMs; ) {
    const len = Math.min(loopTo - loopFrom, totalMs - at);
    pieces.push({ from: loopFrom, to: loopFrom + len, at });
    for (const b of beats) if (b >= loopFrom && b < loopFrom + len) grid.push(b - loopFrom + at);
    at += len;
  }
  return { pieces, beats: grid };
}
/** Put a track under the whole edit, looping it if needed, ducked under speech. Returns how many times it repeats. */
function placeBed(tl: Timeline, byId: Record<string, AssetDoc>, music: AssetDoc, totalMs: number, base: number, ducked: number, fadeOutMs: number): number {
  const plan = loopPlan(music, totalMs);
  const at = T.ensureTrack(tl, "audio");
  plan.pieces.forEach((pc, i) => {
    const [m] = T.placeMedia(tl, [{ asset: music, trimStartMs: pc.from, trimEndMs: pc.to, volume: base }], { trackId: at.id, atMs: pc.at });
    T.duckUnderSpeech(tl, byId, m!.id, { baseVolume: base, duckedVolume: ducked });
    if (i === 0) m!.fadeInMs = 150;
    if (i === plan.pieces.length - 1) m!.fadeOutMs = fadeOutMs;
  });
  return plan.pieces.length - 1;
}

export function remix(o: RemixOptions): { timeline: Timeline; report: RemixReport } {
  const bp = o.blueprint;
  const notes: string[] = [];
  const speech = o.assets.filter(isSpeech);
  const visuals = o.assets.filter((a) => a.type !== "audio" && !isSpeech(a));
  // montages and text-on-video posts are driven by the picture, not by speech
  const visualFormat = !!bp && (bp.format === "montage" || bp.format === "text-on-video");
  const wantsTalking = !bp || !visualFormat;
  const tpl = o.template ?? null;
  const mode: RemixReport["mode"] = tpl?.id === "vlog" && o.assets.some((a) => a.type !== "audio") ? "vlog" : speech.length && (wantsTalking || !visuals.length) ? "talking" : "montage";
  if (bp && !visualFormat && !speech.length && !tpl) notes.push("The trend is a talking format but none of the selected clips has speech, so this was built as a montage.");
  if (bp && visualFormat && !visuals.length && speech.length) notes.push(`The trend is ${bp.format === "montage" ? "a montage" : "a text-on-video post"} but only talking clips were selected, so this was built as a talking edit.`);
  const aspect = o.aspect ?? bp?.aspect ?? "9:16";
  const canvas = CANVAS_PRESETS.find((c) => c.id === aspect) ?? CANVAS_PRESETS[0]!;
  const tl = T.emptyTimeline(canvas.width, canvas.height, 30);
  const byId = Object.fromEntries(o.assets.map((a) => [a.id, a])) as Record<string, AssetDoc>;
  if (o.musicAsset) byId[o.musicAsset.id] = o.musicAsset;
  const lookId = o.captionLook ?? bp?.captions.look ?? "bold-pop";
  const look = captionTemplate(lookId) ?? CAPTION_TEMPLATES[0]!;
  const H = canvas.height;
  const k = Math.min(canvas.width, canvas.height) / 1080;
  const report: RemixReport = { mode, durationSeconds: 0, hook: null, hookOverlay: null, usedAssets: [], clips: 0, brollInserts: 0, captionLook: look.id, captions: 0, music: null, cutsRemoved: 0, secondsRemoved: 0, notes, title: o.plan?.title ?? o.title ?? "", postCaption: o.plan?.postCaption ?? "", hashtags: o.plan?.hashtags ?? [], planner: o.plan ? "ai" : "rules" };
  const used = new Set<string>();

  if (mode === "talking") {
    const all = inventorySentences(o.assets);
    // a long podcast keeps the whole conversation in recorded order
    const keepAll = tpl?.id === "long-podcast" && !o.targetSeconds;
    const target = keepAll ? Number.POSITIVE_INFINITY : (o.targetSeconds ?? Math.min(tpl ? tpl.defaults.targetSeconds[1] : 60, Math.max(15, Math.round((bp?.durationMs ?? 35000) / 1000)))) * 1000;
    // 1. hook first
    let hookIdx = keepAll ? 0 : o.plan?.hookSentence !== undefined && all[o.plan.hookSentence] ? o.plan.hookSentence : -1;
    if (hookIdx < 0) { let best = -Infinity; all.slice(0, Math.max(3, Math.ceil(all.length * 0.7))).forEach((s, i) => { const v = hookScore(s, i, all.length); if (v > best) { best = v; hookIdx = s.n; } }); }
    const hook = all[hookIdx]!;
    // 2. the lines that stay, in spoken order, until the target length is reached
    let keep: Sentence[];
    if (keepAll) keep = all.slice(1);
    else if (o.plan?.keepSentences?.length) keep = o.plan.keepSentences.map((n) => all[n]).filter((s): s is Sentence => !!s && s.n !== hook.n);
    else {
      keep = [];
      let total = hook.endMs - hook.startMs;
      const rest = all.filter((s) => s.n !== hook.n && s.n > (hook.n < all.length / 2 ? hook.n : -1));
      const pool = rest.length ? rest : all.filter((s) => s.n !== hook.n);
      for (const s of pool) {
        const len = s.endMs - s.startMs;
        if (/^(um+|uh+|okay|ok|so|yeah|right)[.,!?]*$/i.test(s.text.trim())) continue;
        // speech tightens by about a fifth once pauses are cut
        if (total + len * 0.82 > target * 1.08 && keep.length >= 1) continue;
        keep.push(s); total += len * 0.82;
      }
      if (hook.n > 0 && hook.n < all.length / 2 && keep.length < 2) {
        // very little after the hook: bring the earlier lines back behind it
        for (const s of all.filter((x) => x.n < hook.n)) { if (total > target) break; keep.push(s); total += (s.endMs - s.startMs) * 0.82; }
      }
    }
    const order = [hook, ...keep];
    if (hook.n !== 0) notes.push(`Moved "${punchy(hook.text, 9)}" to the front as the hook.`);
    // 3. lay the lines down, joining neighbours from the same take into one clip
    const ranges: { assetId: ID; from: number; to: number }[] = [];
    for (const s of order) {
      const last = ranges[ranges.length - 1];
      const prev = order[order.indexOf(s) - 1];
      if (last && prev && last.assetId === s.assetId && s.n === prev.n + 1 && s.startMs - last.to < 1500) last.to = s.endMs + 160;
      else ranges.push({ assetId: s.assetId, from: Math.max(0, s.startMs - 100), to: s.endMs + 160 });
    }
    const track = T.mainVideoTrack(tl)!;
    for (const r of ranges) { const a = byId[r.assetId]!; T.placeMedia(tl, [{ asset: a, trimStartMs: r.from, trimEndMs: Math.min(a.durationMs, r.to) }], { trackId: track.id }); used.add(a.id); }
    // 4. tighten: pauses, fillers, restarts
    const fast = (bp?.pacing.label ?? "fast") !== "slow";
    const minPause = tpl?.defaults.removePausesOverMs ?? (fast ? 320 : 480);
    const clean = T.cutDeadSpace(tl, byId, undefined, { minPauseMs: minPause, removeFillers: true, removeRestarts: true, paddingMs: keepAll ? 140 : 80 });
    report.cutsRemoved = clean.cuts.length; report.secondsRemoved = clean.removedSeconds;
    // 5. punch in on alternate pieces so jump cuts read as a choice
    const main = T.itemsOnTrack(tl, track.id) as MediaItem[];
    if (tpl ? tpl.defaults.punchIn : true) main.forEach((it, i) => { if (i % 2 === 1) { it.transform.scale = 1.13; it.transform.y = Math.round(H * 0.012); } });
    report.clips = main.length;
    const duration = T.timelineDuration(tl);
    // 6. b-roll over the voice
    if (visuals.length && duration > 6000 && !keepAll) {
      const cover = bp?.format === "voiceover-broll" ? 0.6 : bp?.format === "talking-head" ? 0.25 : 0.35;
      const slotLen = Math.min(2600, Math.max(1300, bp ? bp.pacing.medianShotMs : 2200));
      const count = Math.max(Math.min(visuals.length, Math.floor(duration / 6500)), Math.min(visuals.length * 3, Math.round((duration * cover) / slotLen)), 1);
      const firstAt = Math.max(2600, T.itemsOnTrack(tl, track.id)[0]!.display.to - 200);
      const gap = Math.max(slotLen + 900, (duration - firstAt - 1500) / count);
      const bt = T.addTrack(tl, "video", { name: "B-roll" });
      const usedWin = new Map<string, { from: number; to: number }[]>();
      const speechWordsAt = (from: number, to: number) => {
        const out: string[] = [];
        for (const it of main) for (const w of T.clipWords(it, byId[it.assetId]?.transcription)) { const t = T.sourceToTimeline(it, w.s); if (t >= from - 800 && t <= to + 800) out.push(w.text); }
        return tokens(out.join(" "));
      };
      for (let i = 0; i < count; i++) {
        let at = Math.round(firstAt + i * gap);
        // start on a cut of the main track when one is near, so the picture changes with the sentence
        const near = main.map((m) => m.display.from).filter((f) => Math.abs(f - at) < 700).sort((x, y) => Math.abs(x - at) - Math.abs(y - at))[0];
        if (near !== undefined) at = near;
        if (at + slotLen > duration - 600) break;
        const said = speechWordsAt(at, at + slotLen);
        const planned = o.plan?.broll?.[i]?.assetId ? byId[o.plan.broll[i]!.assetId] : undefined;
        const ranked = visuals.map((a, vi) => {
          const desc = tokens(`${a.name.replace(/[_.-]/g, " ")} ${a.analysis?.summary ?? ""} ${(a.analysis?.tags ?? []).join(" ")} ${(a.analysis?.segments ?? []).map((s) => s.description).join(" ")}`);
          let match = 0; for (const w of said) if (desc.has(w)) match++;
          return { a, score: match * 2 - (usedWin.get(a.id)?.length ?? 0) * 1.2 - ((vi + visuals.length - (i % visuals.length)) % visuals.length) * 0.01 };
        }).sort((x, y) => y.score - x.score);
        const a = planned ?? ranked[0]!.a;
        const win = bestWindow(a, slotLen, usedWin.get(a.id) ?? []);
        try {
          T.placeMedia(tl, [{ asset: a, trimStartMs: win.from, trimEndMs: win.to, durationMs: slotLen, muted: true }], { trackId: bt.id, atMs: at });
          usedWin.set(a.id, [...(usedWin.get(a.id) ?? []), win]); used.add(a.id); report.brollInserts++;
        } catch { /* slot taken */ }
      }
    }
    // 7. captions in the look the trend uses
    if (o.captions ?? (tpl ? tpl.defaults.captionsOn : true)) {
      const emph = o.plan?.emphasisWords?.length ? o.plan.emphasisWords : emphasisFrom(order);
      const ct = tl.tracks.find((t) => t.kind === "caption")!;
      const cap = T.generateCaptions(tl, byId, { trackId: ct.id, sourceItemIds: main.map((m) => m.id), style: { ...look.style, fontSize: Math.round((look.style.fontSize ?? 70) * k), ...(bp?.captions.present ? { position: Math.min(0.82, Math.max(0.3, bp.captions.position)) } : {}) }, emphasisWords: emph });
      report.captions = cap.created;
    }
    // 8. hook on screen for the first seconds
    const overlay = o.hookText === null || (keepAll && !o.hookText) ? null : (o.hookText ?? o.plan?.hookOverlay ?? punchy(hook.text)).trim();
    report.hook = hook.text;
    if (overlay) {
      const hookEnd = Math.min(3600, Math.max(2200, T.itemsOnTrack(tl, track.id)[0]!.display.to));
      T.addText(tl, { text: overlay, startMs: 0, durationMs: hookEnd, y: -Math.round(H * 0.3), role: "title", animationIn: "pop", style: { fontFamily: "TikTok Sans", fontWeight: 800, fontSize: Math.round(64 * k), color: "#111111", textTransform: "none", strokeColor: null, strokeWidth: 0, shadow: null, lineHeight: 1.2, maxWidth: 0.8, background: { color: "#FFFFFF", paddingX: Math.round(26 * k), paddingY: Math.round(14 * k), radius: Math.round(18 * k) } } });
      report.hookOverlay = overlay;
    }
    // 9. sound under the voice
    if (o.musicAsset && keepAll) {
      // podcast: music on the intro and the outro only
      const d = T.timelineDuration(tl);
      const at = T.ensureTrack(tl, "audio");
      const bed = Math.min(8000, o.musicAsset.durationMs, Math.max(2000, d / 4));
      const [intro] = T.placeMedia(tl, [{ asset: o.musicAsset, trimStartMs: 0, trimEndMs: bed, volume: 0.5 }], { trackId: at.id, atMs: 0 });
      T.duckUnderSpeech(tl, byId, intro!.id, { baseVolume: 0.5, duckedVolume: 0.08 });
      intro!.fadeOutMs = 1500;
      if (d > bed * 2.5) {
        const tailFrom = Math.max(0, o.musicAsset.durationMs - bed);
        const [outro] = T.placeMedia(tl, [{ asset: o.musicAsset, trimStartMs: tailFrom, trimEndMs: tailFrom + bed, volume: 0.5 }], { trackId: at.id, atMs: d - bed });
        T.duckUnderSpeech(tl, byId, outro!.id, { baseVolume: 0.5, duckedVolume: 0.08 });
        outro!.fadeInMs = 1500;
      }
      report.music = o.musicAsset.name;
    } else if (o.musicAsset) {
      const loops = placeBed(tl, byId, o.musicAsset, T.timelineDuration(tl) + 500, 0.32, 0.09, 700);
      report.music = o.musicAsset.name;
      if (loops) notes.push(`The track is shorter than the edit, so it repeats on whole bars (${loops}×).`);
    }
  } else if (mode === "vlog") {
    // ---------- vlog: the day in order, talking where it explains, b-roll cut on the beat ----------
    let clips = o.assets.filter((a) => a.type !== "audio");
    if (o.plan?.clipOrder?.length) { const order = o.plan.clipOrder.map((id) => byId[id]).filter((a): a is AssetDoc => !!a && a.type !== "audio"); clips = [...order, ...clips.filter((a) => !order.includes(a))]; }
    else if (clips.length > 1 && clips.every((a) => a.fileCreatedAt)) { clips = [...clips].sort((a, b) => Date.parse(a.fileCreatedAt!) - Date.parse(b.fileCreatedAt!)); notes.push("Clips are in the order they were recorded."); }
    const music = o.musicAsset ?? null;
    const [lo, hi] = tpl?.defaults.targetSeconds ?? [30, 90];
    const defaultTarget = Math.round((lo + hi) / 2) * 1000;
    // with a track chosen the vlog is cut to the track, unless a length was asked for
    const target = o.targetSeconds ? o.targetSeconds * 1000 : music ? Math.max(lo * 500, Math.min(defaultTarget, music.durationMs - 1200)) : defaultTarget;
    const beats = music ? loopPlan(music, target * 1.6 + 20000).beats : [];
    let sentences = inventorySentences(clips);
    if (o.plan?.keepSentences?.length) { const keepSet = new Set(o.plan.keepSentences); const kept = sentences.filter((x) => keepSet.has(x.n)); if (kept.length) sentences = kept; }
    const byClip = new Map<string, Sentence[]>();
    for (const x of sentences) byClip.set(x.assetId, [...(byClip.get(x.assetId) ?? []), x]);
    // talking takes up to 70% of the length; each talking clip gets a share in proportion to how much it says
    const spokenOf = (list: Sentence[]) => list.reduce((acc, x) => acc + (x.endMs - x.startMs) * 0.82, 0);
    const totalSpoken = spokenOf(sentences);
    const speechBudget = Math.min(totalSpoken, target * 0.7);
    const broll = clips.filter((a) => !byClip.has(a.id));
    const brollBudget = Math.max(0, target - speechBudget);
    const perShot = broll.length ? Math.min(4000, Math.max(1500, brollBudget / broll.length)) : 0;
    const track = T.mainVideoTrack(tl)!;
    const endOfTrack = () => T.itemsOnTrack(tl, track.id).at(-1)?.display.to ?? 0;
    const talkingIds: string[] = [];
    for (const a of clips) {
      const list = byClip.get(a.id);
      if (list?.length) {
        const share = totalSpoken > 0 ? (speechBudget * spokenOf(list)) / totalSpoken : 0;
        const keep: Sentence[] = [];
        let acc = 0;
        for (const x of list) { const len = (x.endMs - x.startMs) * 0.82; if (keep.length && acc + len > share * 1.1) break; keep.push(x); acc += len; }
        const ranges: { from: number; to: number }[] = [];
        for (const x of keep) { const last = ranges.at(-1); if (last && x.startMs - last.to < 1500) last.to = x.endMs + 160; else ranges.push({ from: Math.max(0, x.startMs - 100), to: x.endMs + 160 }); }
        const placed = T.placeMedia(tl, ranges.map((r) => ({ asset: a, trimStartMs: r.from, trimEndMs: Math.min(a.durationMs, r.to) })), { trackId: track.id, atMs: endOfTrack() });
        // tighten now, while these are the last items, so later cuts can still be placed on the beat
        const clean = T.cutDeadSpace(tl, byId, placed.map((p) => p.id), { minPauseMs: tpl?.defaults.removePausesOverMs ?? 600, removeFillers: true, removeRestarts: true, paddingMs: 90 });
        report.cutsRemoved += clean.cuts.length; report.secondsRemoved = Math.round((report.secondsRemoved + clean.removedSeconds) * 1000) / 1000;
        talkingIds.push(...clean.itemsAfter);
        used.add(a.id);
      } else {
        const at = endOfTrack();
        let len = perShot || 2500;
        // end the shot on a beat so the next picture arrives with the music
        if (beats.length) { const end = beats.find((b) => b >= at + len * 0.8); if (end !== undefined && end - at >= 900 && end - at <= len * 1.6) len = end - at; }
        if (a.type !== "image") len = Math.min(len, a.durationMs);
        if (len < 300) continue;
        const win = bestWindow(a, len, []);
        const [it] = T.placeMedia(tl, [{ asset: a, trimStartMs: win.from, trimEndMs: win.to, durationMs: len, muted: true }], { trackId: track.id, atMs: at });
        if (a.type === "image") T.setKeyframes(tl, it!.id, "scale", [{ t: 0, value: 1 }, { t: len, value: 1.08, easing: "linear" }]);
        used.add(a.id); report.brollInserts++;
      }
    }
    const mainItems = T.itemsOnTrack(tl, track.id) as MediaItem[];
    if (!mainItems.length) throw new T.OpError("NO_FOOTAGE", "None of the selected clips could be used.");
    report.clips = mainItems.length;
    // a short tail on the last shot so the music can land
    if (music) {
      const last = mainItems.at(-1)!;
      const end = last.display.to;
      const tail = (beats.find((b) => b >= end + 600 && b <= end + 1700) ?? end + 1000) - end;
      try { T.trimItem(tl, last.id, "end", tail, { assetDurationMs: last.type === "image" ? undefined : byId[last.assetId]?.durationMs }); } catch { /* no more source */ }
    }
    if (talkingIds.length && (o.captions ?? (tpl ? tpl.defaults.captionsOn : true))) {
      const ct = tl.tracks.find((t) => t.kind === "caption")!;
      const cap = T.generateCaptions(tl, byId, { trackId: ct.id, sourceItemIds: talkingIds.filter((id) => tl.items[id]), style: { ...look.style, fontSize: Math.round((look.style.fontSize ?? 70) * k) }, emphasisWords: o.plan?.emphasisWords?.length ? o.plan.emphasisWords : emphasisFrom(sentences) });
      report.captions = cap.created;
    }
    const titleText = o.hookText ?? o.plan?.hookOverlay ?? null;
    if (titleText) {
      T.addText(tl, { text: titleText, startMs: 0, durationMs: Math.min(3000, T.timelineDuration(tl)), y: -Math.round(H * 0.3), role: "title", animationIn: "pop", style: { fontFamily: "TikTok Sans", fontWeight: 800, fontSize: Math.round(64 * k), color: "#111111", textTransform: "none", strokeColor: null, strokeWidth: 0, shadow: null, lineHeight: 1.2, maxWidth: 0.8, background: { color: "#FFFFFF", paddingX: Math.round(26 * k), paddingY: Math.round(14 * k), radius: Math.round(18 * k) } } });
      report.hookOverlay = titleText;
    }
    report.hook = sentences[0]?.text ?? null;
    if (music) {
      const loops = placeBed(tl, byId, music, T.timelineDuration(tl), 0.6, 0.13, 900);
      report.music = music.name;
      if (beats.length) notes.push(`B-roll cuts land on the beat of ${music.name} (${Math.round(music.rhythm!.averageBpm)} BPM); the music dips while you talk.`);
      if (loops) notes.push(`The track is shorter than the edit, so it repeats on whole bars (${loops}×) and stays on the beat.`);
    } else notes.push("No music was chosen. A vlog usually runs on a track: pick one under Sound.");
  } else {
    // ---------- montage ----------
    const pool = (visuals.length ? visuals : o.assets.filter((a) => a.type !== "audio"));
    const ordered = o.plan?.clipOrder?.length ? o.plan.clipOrder.map((id) => byId[id]).filter((a): a is AssetDoc => !!a && a.type !== "audio") : pool;
    if (!ordered.length) throw new T.OpError("NO_FOOTAGE", "Select at least one video or image to build from.");
    const music = o.musicAsset ?? null;
    const beats = (music?.rhythm?.pulseBeats ?? []).map((b) => Math.round(b[0] * 1000));
    const maxLen = Math.min(music ? music.durationMs : Infinity, (o.targetSeconds ?? Math.round((bp?.durationMs ?? 20000) / 1000)) * 1000);
    let slots: { from: number; to: number }[] = [];
    const sameSound = !!(bp && music?.origin?.kind === "trend-sound" && bp.slots.length >= 3);
    if (sameSound) {
      slots = bp!.slots.map((s) => ({ from: s.startMs, to: s.endMs })).filter((s) => s.to <= maxLen + 50);
      notes.push("Cut points copied from the original post, so every cut sits where it does in the trend.");
    } else if (beats.length >= 4) {
      const period = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1);
      const every = Math.min(4, Math.max(1, Math.round((bp?.pacing.medianShotMs ?? period * 2) / period)));
      slots = T.beatSlots(beats, beats[0]!, Math.min(maxLen, beats[beats.length - 1]!), () => every).map((s) => ({ from: s.fromMs, to: s.toMs }));
      // the picture starts at 0 even when the first beat is a moment in
      if (slots.length && slots[0]!.from > 0) slots[0]!.from = 0;
      notes.push(`Cuts land on every ${every === 1 ? "beat" : `${every} beats`} of the track (${music?.rhythm?.averageBpm} BPM).`);
    } else {
      const len = Math.min(3000, Math.max(900, bp?.pacing.medianShotMs ?? 1500));
      for (let t = 0; t + len <= (Number.isFinite(maxLen) ? maxLen : ordered.length * len) + 1; t += len) slots.push({ from: t, to: t + len });
      if (music) notes.push("No clear beat was found in the track, so the cuts are evenly spaced.");
    }
    if (!music && Number.isFinite(maxLen) === false) slots = slots.slice(0, ordered.length * 2);
    const track = T.mainVideoTrack(tl)!;
    const usedWin = new Map<string, { from: number; to: number }[]>();
    slots.forEach((s, i) => {
      const a = ordered[i % ordered.length]!;
      const len = s.to - s.from;
      const win = bestWindow(a, len, usedWin.get(a.id) ?? []);
      const srcLen = win.to - win.from;
      T.placeMedia(tl, [{ asset: a, trimStartMs: win.from, trimEndMs: win.to, durationMs: len, playbackRate: a.type === "image" ? 1 : Math.max(0.4, Math.min(1, srcLen / len)), muted: true }], { trackId: track.id, atMs: s.from });
      const it = T.itemsOnTrack(tl, track.id).at(-1) as MediaItem;
      // keep the slot exact even when the clip was shorter than the slot
      it.display = { from: s.from, to: s.to };
      if (a.type !== "image") it.playbackRate = (it.trim.to - it.trim.from) / len;
      if (a.type === "image") T.setKeyframes(tl, it.id, "scale", [{ t: 0, value: 1 }, { t: len, value: 1.08, easing: "linear" }]);
      usedWin.set(a.id, [...(usedWin.get(a.id) ?? []), win]); used.add(a.id);
    });
    report.clips = slots.length;
    if (ordered.length > slots.length) notes.push(`${ordered.length - slots.length} clip(s) did not fit the length and were left out.`);
    const d = T.timelineDuration(tl);
    if (music) {
      const at = T.ensureTrack(tl, "audio");
      const [m] = T.placeMedia(tl, [{ asset: music, trimStartMs: 0, trimEndMs: Math.min(music.durationMs, d + 900), volume: 0.9 }], { trackId: at.id, atMs: 0 });
      m!.fadeOutMs = 600;
      report.music = music.name;
    }
    const trendHook = bp?.overlays.find((x) => x.role === "hook") ?? (bp?.hook.onScreen ? { text: bp.hook.onScreen, startMs: 0, endMs: 3000, position: "top" as const } : null);
    let overlays = o.plan?.overlays?.length ? o.plan.overlays.map((x) => ({ text: x.text, startMs: x.fromSeconds * 1000, endMs: x.toSeconds * 1000, position: x.position })) : o.hookText ? [{ text: o.hookText, startMs: 0, endMs: Math.min(3000, d), position: (trendHook?.position ?? "center") as "top" | "center" | "bottom" }] : [];
    if (!overlays.length && trendHook && o.hookText !== null) {
      overlays = [{ text: trendHook.text, startMs: trendHook.startMs, endMs: Math.max(trendHook.endMs, trendHook.startMs + 1500), position: trendHook.position }];
      notes.push("Reused the trend's on-screen line. Change the words to fit your video in the Selected panel.");
    }
    for (const ov of overlays) {
      if (ov.startMs >= d) continue;
      const tall = captionTemplate("tall-caps")!.style;
      try { T.addText(tl, { text: ov.text, startMs: ov.startMs, durationMs: Math.min(d, ov.endMs) - ov.startMs, y: ov.position === "top" ? -Math.round(H * 0.3) : ov.position === "bottom" ? Math.round(H * 0.28) : 0, role: "title", animationIn: "fade", animationOut: "fade", style: { fontFamily: tall.fontFamily!, fontWeight: 400, fontSize: Math.round(110 * k), letterSpacing: 4, textTransform: "uppercase", color: "#FFFFFF", strokeColor: null, strokeWidth: 0, shadow: { color: "rgba(0,0,0,0.75)", blur: 22, x: 0, y: 3 }, maxWidth: 0.84 } }); report.hookOverlay = report.hookOverlay ?? ov.text; } catch { /* overlapping overlay */ }
    }
  }
  T.consolidateTracks(tl);
  const problems = T.validateTimeline(tl);
  if (problems.length) notes.push(`Check: ${problems.slice(0, 3).join("; ")}`);
  report.durationSeconds = T.sec(T.timelineDuration(tl));
  report.usedAssets = [...used].map((id) => byId[id]!.name);
  const unused = o.assets.filter((a) => a.type !== "audio" && !used.has(a.id));
  if (unused.length) notes.push(`Not used: ${unused.map((a) => a.name).join(", ")}.`);
  if (!report.title) report.title = report.hookOverlay ?? (report.hook ? punchy(report.hook, 8) : "New edit");
  return { timeline: tl, report };
}

// ---------- AI planning (one request per video) ----------
function footageBrief(assets: AssetDoc[], sentences: Sentence[]): string {
  const lines: string[] = [];
  for (const a of assets) {
    if (a.type === "audio") continue;
    const sp = sentences.filter((s) => s.assetId === a.id);
    lines.push(`- ${a.id} "${a.name}" (${a.type}, ${(a.durationMs / 1000).toFixed(1)}s, ${a.width}x${a.height}): ${a.analysis?.summary ?? ""}${sp.length ? "" : ` Scenes: ${(a.analysis?.segments ?? []).slice(0, 4).map((s) => s.description).join(" / ").slice(0, 300)}`}`);
    for (const s of sp) lines.push(`    [${s.n}] ${(s.startMs / 1000).toFixed(1)}-${(s.endMs / 1000).toFixed(1)}s "${s.text}"`);
  }
  return lines.join("\n");
}
export async function aiPlan(o: RemixOptions): Promise<AiPlan | null> {
  if (llmBackend() === "none") return null;
  const sentences = inventorySentences(o.assets);
  const bp = o.blueprint;
  return jsonTask<AiPlan>({
    task: "remix-plan",
    system: "You are a short-form video editor who plans edits that hold attention. You pick the strongest hook, keep only the lines that earn their place, and write on-screen text the way creators actually write it: short, specific, no hashtags, no emoji unless the creator's niche uses them. You only use the footage listed.",
    prompt: `Plan one ${o.targetSeconds ?? Math.round((bp?.durationMs ?? 30000) / 1000)}-second vertical video from this footage.
${o.profile?.niche ? `Creator niche: ${o.profile.niche}. Audience: ${o.profile.audience || "general"}. Tone: ${o.profile.tone || "natural"}.` : ""}${o.topic ? `\nWhat the creator wants: ${o.topic}` : ""}
${bp ? `Follow this proven format: ${bp.format}, hook type "${bp.hook.type}" (${bp.hook.formula}), ${bp.pacing.label} pacing (${bp.pacing.cutsPerMinute} cuts/min). Structure: ${bp.structure.join(" | ")}. Why it works: ${bp.whyItWorks.join(" ")}` : "No reference format: use a hook-first structure."}

Footage (numbers in [brackets] are sentence ids):
${footageBrief(o.assets, sentences)}

Return JSON:
{"hookSentence": sentence id to open on (the line that would stop a scroll), "keepSentences": [sentence ids to keep after the hook, in the order to play them; drop repeats, restarts, filler and weak lines],
 "hookOverlay": "on-screen title for the first 3 seconds, max 7 words, in the creator's voice", "emphasisWords": ["up to 12 spoken words or short phrases worth highlighting in captions"],
 "broll": [{"atSentence": sentence id it should cover, "assetId": "id of a clip without speech that fits what is said"}],
 "clipOrder": ["for a montage only: asset ids in play order, strongest first"],
 "title": "short project title", "postCaption": "caption to post with it, 1-2 sentences", "hashtags": ["5-8 without #"]}
Use only ids that appear above. Leave "broll" empty if nothing fits.`,
    effort: "low",
  });
}

// ---------- what to post ----------
export function getProfile(): CreatorProfile {
  return db.get<CreatorProfile>("settings", "profile") ?? { niche: "", audience: "", platforms: ["tiktok", "instagram"], goal: "", tone: "", handle: "" };
}
function fitScore(format: TrendFormat, speech: number, visuals: number): number {
  if (format === "montage") return visuals >= 3 ? 1 : visuals > 0 ? 0.6 : 0.1;
  if (format === "voiceover-broll") return speech && visuals ? 1 : speech ? 0.6 : 0.2;
  return speech ? 1 : 0.15;
}
export function ruleIdeas(assets: AssetDoc[], profile: CreatorProfile): Idea[] {
  const speech = assets.filter(isSpeech), visuals = assets.filter((a) => a.type !== "audio" && !isSpeech(a));
  const topic = profile.niche || "your topic";
  const ideas: Idea[] = [];
  for (const t of listTrends().filter((x) => x.status === "ready" && x.blueprint).slice(0, 12)) {
    const bp = t.blueprint!;
    const fit = fitScore(bp.format, speech.length, visuals.length);
    const missing: string[] = [];
    if (bp.format !== "montage" && !speech.length) missing.push(`A ${Math.round(bp.durationMs / 1000)}-second take of you talking to camera`);
    if (bp.format !== "talking-head" && visuals.length < Math.min(3, bp.slots.length)) missing.push(`${Math.max(1, Math.min(6, bp.slots.length) - visuals.length)} more b-roll clip(s)`);
    ideas.push({
      id: db.newId("idea"), createdAt: new Date().toISOString(), trendId: t.id, format: bp.format, source: "rules",
      title: `${t.title} — your version`,
      hook: bp.hook.formula.replace(/\[topic\]/g, topic),
      why: [`${t.stats.views ? `${t.stats.views.toLocaleString()} views on the original` : "Proven format in your library"}`, ...bp.whyItWorks.slice(0, 2)].join(" "),
      shotList: bp.format === "montage" ? [`${bp.slots.length} clips, about ${(bp.pacing.medianShotMs / 1000).toFixed(1)}s each`, "Strongest shot first", bp.audio.hasMusic ? "Cut to the same sound" : "Add a track with a clear beat"] : [`Hook in the first ${bp.hook.seconds}s: ${bp.hook.type}`, ...bp.structure.slice(1, 4)],
      useAssetIds: (bp.format === "montage" ? visuals : [...speech.slice(0, 1), ...visuals]).slice(0, 8).map((a) => a.id),
      missing, caption: "", hashtags: t.niche.slice(0, 5), score: Math.round((t.viralScore * 0.5 + fit * 50)),
    });
  }
  // footage-first ideas when there is no trend library yet
  if (!ideas.length && speech.length) {
    const s = inventorySentences(speech);
    const best = [...s].sort((a, b) => hookScore(b, b.n, s.length) - hookScore(a, a.n, s.length))[0];
    if (best) ideas.push({ id: db.newId("idea"), createdAt: new Date().toISOString(), trendId: null, format: visuals.length ? "voiceover-broll" : "talking-head", source: "rules", title: `Hook-first cut: "${punchy(best.text, 8)}"`, hook: best.text, why: "Opens on your strongest line, removes the pauses and adds captions in the look most talking videos use.", shotList: ["Hook", "2-4 points in the order you said them", "End on the last useful word"], useAssetIds: [...speech, ...visuals].slice(0, 8).map((a) => a.id), missing: [], caption: "", hashtags: [], score: 60 });
  }
  if (!ideas.length && visuals.length >= 2) ideas.push({ id: db.newId("idea"), createdAt: new Date().toISOString(), trendId: null, format: "montage", source: "rules", title: "Beat-synced montage of your clips", hook: "Strongest shot on the first beat", why: "Short, loopable and cut on the beat.", shotList: [`${visuals.length} clips`, "One clip every two beats", "Hold the last shot"], useAssetIds: visuals.slice(0, 10).map((a) => a.id), missing: ["A music track with a clear beat (add one in Sounds)"], caption: "", hashtags: [], score: 50 });
  return ideas.sort((a, b) => b.score - a.score);
}
export async function suggestIdeas(assets: AssetDoc[], opts: { ai?: boolean } = {}): Promise<{ ideas: Idea[]; warning?: string }> {
  const profile = getProfile();
  const base = ruleIdeas(assets, profile);
  const trends = listTrends().filter((x) => x.status === "ready" && x.blueprint).slice(0, 10);
  if (opts.ai === false || llmBackend() === "none") { saveIdeas(base); return { ideas: base, ...(opts.ai !== false ? { warning: "No AI model is connected, so these ideas come from your trends and footage." } : {}) }; }
  const sentences = inventorySentences(assets);
  const res = await jsonTask<{ ideas: { title: string; hook: string; why: string; trendId: string | null; format: TrendFormat; shotList: string[]; useAssetIds: string[]; missing: string[]; caption: string; hashtags: string[]; score: number }[] }>({
    task: "ideas",
    system: "You advise a short-form creator on what to post next. Every idea must be makeable from the footage they already have, or say exactly what to film. You borrow structures that are already working (the trends given) and adapt them to the creator's niche; you do not copy other creators' words. Be specific, never generic.",
    prompt: `Creator: niche "${profile.niche || "not set"}", audience "${profile.audience || "not set"}", goal "${profile.goal || "grow"}", tone "${profile.tone || "natural"}", platforms ${profile.platforms.join(", ")}.

Trends in their library (formats that are performing):
${trends.length ? trends.map((t) => `- ${t.id}: "${t.title}" ${t.stats.views ? `${t.stats.views} views, ` : ""}${t.blueprint!.format}, hook "${t.blueprint!.hook.type}" (${t.blueprint!.hook.formula}), ${t.blueprint!.pacing.label} cuts, ${t.blueprint!.audio.hasMusic ? `music ${t.blueprint!.audio.bpm} BPM` : "no music"}. Why it works: ${t.blueprint!.whyItWorks.slice(0, 2).join(" ")}`).join("\n") : "(none yet)"}

Their footage:
${footageBrief(assets, sentences) || "(nothing uploaded yet)"}

Suggest 5 videos to post this week, best first. Return JSON:
{"ideas": [{"title": "...", "hook": "the exact first line or on-screen text", "why": "why this should perform, tied to a trend or to the footage", "trendId": "id of the trend it borrows from, or null", "format": "talking-head|voiceover-broll|montage|text-on-video|mixed", "shotList": ["3-5 beats"], "useAssetIds": ["asset ids from the footage list"], "missing": ["anything they still need to film, or empty"], "caption": "post caption", "hashtags": ["5-8 without #"], "score": 0-100}]}`,
    effort: "low",
  });
  const valid = new Set(assets.map((a) => a.id));
  const ai: Idea[] = (res?.ideas ?? []).filter((i) => i?.title).map((i) => ({ id: db.newId("idea"), createdAt: new Date().toISOString(), title: String(i.title), hook: String(i.hook ?? ""), why: String(i.why ?? ""), trendId: i.trendId && getTrend(i.trendId) ? i.trendId : null, format: i.format ?? "talking-head", shotList: (i.shotList ?? []).map(String), useAssetIds: (i.useAssetIds ?? []).filter((x) => valid.has(x)), missing: (i.missing ?? []).map(String), caption: String(i.caption ?? ""), hashtags: (i.hashtags ?? []).map((h) => String(h).replace(/^#/, "")), score: Math.round(Number(i.score) || 60), source: "ai" as const }));
  const out = ai.length ? ai : base;
  saveIdeas(out);
  return ai.length ? { ideas: out } : { ideas: out, warning: `AI ideas were not available (${lastLlmError() ?? "no answer"}), so these come from your trends and footage.` };
}
function saveIdeas(ideas: Idea[]) {
  for (const old of db.list<Idea>("idea")) db.del("idea", old.id);
  ideas.forEach((i, n) => db.put("idea", `${String(n).padStart(3, "0")}_${i.id}`, i));
}
export const listIdeas = () => db.list<Idea>("idea").sort((a, b) => b.score - a.score);
