// The editing tools. One registry serves the built-in chat agent, the MCP endpoint and the
// editor's own buttons, so every path edits the timeline the same way.
import { z } from "zod/v4";
import type { CaptionItem, CaptionStyle, Item, MediaItem, TextItem, Timeline, TransitionKind } from "../../../shared/types.ts";
import { CANVAS_PRESETS, CAPTION_TEMPLATES, EFFECT_INFO, EXPORT_PRESETS, FILTERS, FONT_FAMILIES, TEMPLATES, TRANSITION_KINDS, captionTemplate, resolveFamily } from "../../../shared/catalog.ts";
import * as T from "../../../shared/timeline.ts";
import * as db from "../db.ts";
import { emit } from "../events.ts";
import { getAsset, type AssetDoc } from "../pipeline.ts";
import { captureFrame } from "../render.ts";
import { getTrend, listTrends, sentencesOf } from "../trends.ts";
import { remix, templateBlueprint, templateById } from "../autopilot.ts";
import { getProject, getTimeline, saveProject, saveTimeline, projectAssets, startExport, type ProjectDoc } from "../projects.ts";

export interface ToolContext { projectId: string; selection?: string[]; playheadMs?: number; rangeMs?: { from: number; to: number } | null }
export interface ToolResult { ok: boolean; [k: string]: unknown; images?: { mime: string; data: Buffer; label: string }[] }
export interface Tool { name: string; label: string; description: string; schema: z.ZodType; mutates: boolean; run(ctx: Loaded, input: any): Promise<Record<string, unknown>> | Record<string, unknown> }
interface Loaded extends ToolContext { project: ProjectDoc; tl: Timeline; assets: Record<string, AssetDoc>; byAgent: Record<string, AssetDoc>; agentOf: Record<string, string>; names: Record<string, { agentId: string; name: string }> }

const s = (v: number) => Math.round(v) / 1000;
const ms = (v: number) => Math.round(v * 1000);
const itemIdsIn = z.union([z.string(), z.array(z.string()).min(1)]).describe("One item id or a list of ids");
const arr = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

function asset(ctx: Loaded, id: string): AssetDoc {
  const a = ctx.byAgent[id] ?? ctx.assets[id];
  if (!a) throw new T.OpError("MEDIA_NOT_FOUND", `There is no footage '${id}' in this project. Footage ids: ${Object.keys(ctx.byAgent).join(", ") || "(none)"}.`);
  return a;
}
function describe(ctx: Loaded, it: Item) { return T.describeItem(ctx.tl, it, ctx.names); }
const positionY = (tl: Timeline, p: string | undefined) => (p === "top" ? -Math.round(tl.size.height * 0.3) : p === "bottom" ? Math.round(tl.size.height * 0.28) : p === "lower-third" ? Math.round(tl.size.height * 0.2) : 0);

const tools: Tool[] = [];
const def = <S extends z.ZodType>(t: { name: string; label: string; description: string; schema: S; mutates: boolean; run: (ctx: Loaded, input: z.infer<S>) => Promise<Record<string, unknown>> | Record<string, unknown> }) => tools.push(t as unknown as Tool);

// ---------- reading ----------
def({
  name: "context", label: "Reading the timeline", mutates: false,
  description: "Read the timeline: canvas, tracks and every item with ids, times (seconds) and key properties, plus what the user has selected, where the playhead is and any highlighted range. Call this before editing and again after the user may have changed things. Pass a time range to list captions in detail.",
  schema: z.object({ startSeconds: z.number().optional(), endSeconds: z.number().optional(), types: z.array(z.string()).optional().describe("Only these item types, e.g. ['video','text']") }),
  run: (ctx, i) => ({
    ...T.timelineOverview(ctx.tl, ctx.names, { startMs: i.startSeconds !== undefined ? ms(i.startSeconds) : undefined, endMs: i.endSeconds !== undefined ? ms(i.endSeconds) : undefined }, i.types),
    selectedItems: ctx.selection ?? [], playheadSeconds: ctx.playheadMs !== undefined ? s(ctx.playheadMs) : undefined,
    ...(ctx.rangeMs ? { selectedRange: { startSeconds: s(ctx.rangeMs.from), endSeconds: s(ctx.rangeMs.to), note: "The user highlighted this range; treat it as the scope unless they say otherwise." } } : {}),
    project: { name: ctx.project.name, trend: ctx.project.trendId ? getTrend(ctx.project.trendId)?.title : undefined },
  }),
});
def({
  name: "listFootage", label: "Looking at the footage", mutates: false,
  description: "List the footage in this project: id, file name, type, length, size, whether it has speech, a summary of what it shows and its tags. Music tracks include BPM.",
  schema: z.object({}),
  run: (ctx) => ({
    footage: Object.entries(ctx.byAgent).map(([id, a]) => ({
      id, name: a.name, type: a.type, kind: a.contentType, seconds: s(a.durationMs), size: a.width ? `${a.width}x${a.height}` : undefined, ready: a.status === "ready",
      speech: a.transcription ? `${a.transcription.segments.flatMap((x) => x.words).length} words (${a.transcription.language})` : "none",
      ...(a.rhythm && (a.contentType === "music" || a.type === "audio") ? { bpm: a.rhythm.averageBpm, beats: a.rhythm.pulseBeats.length } : {}),
      summary: a.analysis?.summary, tags: a.analysis?.tags,
      onTimeline: Object.values(ctx.tl.items).filter((x) => T.isMedia(x) && x.assetId === a.id).length,
    })),
  }),
});
def({
  name: "viewFootage", label: "Reading a clip", mutates: false,
  description: "Read one piece of footage in detail: its transcript as sentences with start/end seconds (word-level times on request), its scenes with descriptions, and for music its beat grid. Use this to choose exact in and out points.",
  schema: z.object({ assetId: z.string(), include: z.array(z.enum(["transcript", "words", "scenes", "beats"])).optional().describe("Default: transcript and scenes"), fromSeconds: z.number().optional(), toSeconds: z.number().optional() }),
  run: (ctx, i) => {
    const a = asset(ctx, i.assetId);
    const inc = new Set(i.include ?? ["transcript", "scenes"]);
    const a0 = i.fromSeconds ?? 0, b0 = i.toSeconds ?? a.durationMs / 1000;
    const out: Record<string, unknown> = { id: ctx.agentOf[a.id], name: a.name, seconds: s(a.durationMs), summary: a.analysis?.summary };
    if (inc.has("transcript")) out.transcript = a.transcription ? sentencesOf(a).filter((x) => x.endMs / 1000 >= a0 && x.startMs / 1000 <= b0).map((x) => ({ from: s(x.startMs), to: s(x.endMs), text: x.text })) : "No speech in this clip.";
    if (inc.has("words")) out.words = (a.transcription?.segments.flatMap((x) => x.words) ?? []).filter((w) => w.end >= a0 && w.start <= b0).map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.word}`);
    if (inc.has("scenes")) out.scenes = (a.analysis?.segments ?? []).filter((x) => x.end_time >= a0 && x.start_time <= b0).map((x) => ({ from: x.start_time, to: x.end_time, description: x.description, audio: x.audio }));
    if (inc.has("beats")) out.beats = a.rhythm ? { bpm: a.rhythm.averageBpm, tempo: a.rhythm.tempoType, beatSeconds: a.rhythm.pulseBeats.map((b) => b[0]).filter((t) => t >= a0 && t <= b0), downbeatSeconds: a.rhythm.downbeats.map((b) => b[0]).filter((t) => t >= a0 && t <= b0) } : "No beat analysis for this file.";
    return out;
  },
});
def({
  name: "searchFootage", label: "Searching the footage", mutates: false,
  description: "Find moments in the project's footage by what was said or what is shown. Returns matching transcript lines and scenes with the footage id and seconds.",
  schema: z.object({ query: z.string().describe("Words to look for, e.g. 'pricing', 'coffee', 'laughing'") }),
  run: (ctx, i) => ({ query: i.query, hits: searchAssets(Object.values(ctx.byAgent), i.query).slice(0, 20).map((h) => ({ ...h, assetId: ctx.agentOf[h.assetId] })) }),
});
def({
  name: "captureFrame", label: "Looking at the frame", mutates: false,
  description: "Render what the canvas shows at one or more times so you can check framing, text placement and captions. Returns the images.",
  schema: z.object({ seconds: z.array(z.number()).min(1).max(4) }),
  run: async (ctx, i) => {
    const images = [];
    for (const t of i.seconds) images.push({ mime: "image/jpeg", data: await captureFrame(ctx.tl, ctx.assets, ms(t), 560), label: `Frame at ${t}s` });
    return { captured: i.seconds, images };
  },
});
def({
  name: "listLooks", label: "Checking the looks", mutates: false,
  description: "List what can be applied: templates (structures such as Short Talking Head or Vlog), caption looks (with where each is commonly seen), fonts, colour filters, effects, transitions, canvas sizes and export presets.",
  schema: z.object({}),
  run: () => ({
    templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, bestFor: t.bestFor, length: t.length, aspect: t.aspect })),
    captionLooks: CAPTION_TEMPLATES.map((c) => ({ id: c.id, name: c.name, seenIn: c.seenIn, description: c.description })), fonts: FONT_FAMILIES,
    filters: FILTERS.map((f) => ({ id: f.id, name: f.name, description: f.description })), effects: Object.entries(EFFECT_INFO).map(([id, e]) => ({ id, range: `${e.min}..${e.max}${e.unit}`, description: e.description })),
    transitions: TRANSITION_KINDS, canvas: CANVAS_PRESETS.map((c) => c.id), exportPresets: EXPORT_PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description })),
  }),
});
def({
  name: "listTrends", label: "Checking the trends", mutates: false,
  description: "List the analysed trend posts in the library with their format, hook, pacing, caption look and sound. Use applyTrend to build an edit from one.",
  schema: z.object({}),
  run: () => ({ trends: listTrends().filter((t) => t.blueprint).slice(0, 20).map((t) => ({ id: t.id, title: t.title, views: t.stats.views, format: t.blueprint!.format, seconds: s(t.blueprint!.durationMs), hook: t.blueprint!.hook, pacing: t.blueprint!.pacing.label, cuts: t.blueprint!.pacing.cuts, captionLook: t.blueprint!.captions.look, music: t.blueprint!.audio.hasMusic ? `${t.blueprint!.audio.bpm} BPM` : "none", whyItWorks: t.blueprint!.whyItWorks, recreate: t.blueprint!.recreate })) }),
});

// ---------- building ----------
def({
  name: "addMedia", label: "Adding clips", mutates: true,
  description: "Put footage on the timeline. Several items are placed back to back in the order given. Choose the part of each clip with trimStart/trimEnd (seconds in the source), or with transcriptRange to cut by the words spoken. Without a position they go at the end of the track. insertAfterItemId places them right after that item and pushes later items along.",
  schema: z.object({
    items: z.array(z.object({
      assetId: z.string(), trimStart: z.number().optional(), trimEnd: z.number().optional(), duration: z.number().optional().describe("Length on the timeline in seconds (images, or to shorten a clip)"),
      transcriptRange: z.object({ text: z.string().optional().describe("An exact phrase to use on its own"), from: z.string().optional().describe("First words of the part to keep"), to: z.string().optional().describe("Last words of the part to keep"), occurrence: z.number().int().optional() }).optional(),
      speed: z.number().optional(), muted: z.boolean().optional(), volume: z.number().optional(), fit: z.enum(["cover", "contain"]).optional(),
    })).min(1),
    trackId: z.string().optional(), timelineStart: z.number().optional().describe("Seconds"), insertAfterItemId: z.string().optional(), ripple: z.boolean().optional().describe("Push later items instead of failing on a collision"),
  }),
  run: (ctx, i) => {
    const resolved: unknown[] = [];
    const entries = i.items.map((e) => {
      const a = asset(ctx, e.assetId);
      let ts = e.trimStart !== undefined ? ms(e.trimStart) : undefined, te = e.trimEnd !== undefined ? ms(e.trimEnd) : undefined;
      if (e.transcriptRange) {
        if (e.trimStart !== undefined || e.trimEnd !== undefined) throw new T.OpError("INVALID_COMBINATION", "transcriptRange cannot be combined with trimStart or trimEnd.");
        const r = T.findTranscriptRange(a.transcription, e.transcriptRange);
        if (!r.ok) throw new T.OpError(r.code, r.message, r.candidates ? { candidates: r.candidates } : undefined);
        ts = r.startMs; te = Math.min(a.durationMs, r.endMs);
        resolved.push({ assetId: e.assetId, trimStart: s(ts), trimEnd: s(te), matchedText: r.matchedText });
      }
      return { asset: a, trimStartMs: ts, trimEndMs: te, durationMs: e.duration !== undefined ? ms(e.duration) : undefined, playbackRate: e.speed, muted: e.muted, volume: e.volume, fit: e.fit };
    });
    let trackId = i.trackId;
    if (!trackId && !i.insertAfterItemId) trackId = (entries[0]!.asset.type === "audio" ? T.ensureTrack(ctx.tl, "audio") : T.mainVideoTrack(ctx.tl) ?? T.ensureTrack(ctx.tl, "video")).id;
    const created = T.placeMedia(ctx.tl, entries, { trackId, atMs: i.timelineStart !== undefined ? ms(i.timelineStart) : undefined, insertAfterItemId: i.insertAfterItemId, ripple: i.ripple });
    return { added: created.map((c) => describe(ctx, c)), ...(resolved.length ? { resolvedTranscriptRanges: resolved } : {}), durationSeconds: s(T.timelineDuration(ctx.tl)) };
  },
});
def({
  name: "trimItem", label: "Trimming", mutates: true,
  description: "Move the start or end of an item. deltaSeconds is positive to move that edge later, negative to move it earlier. With ripple, later items move so no gap or overlap is left.",
  schema: z.object({ itemId: z.string(), handle: z.enum(["start", "end"]), deltaSeconds: z.number(), ripple: z.boolean().optional() }),
  run: (ctx, i) => {
    const it = T.itemOf(ctx.tl, i.itemId);
    const r = T.trimItem(ctx.tl, i.itemId, i.handle, ms(i.deltaSeconds), { ripple: i.ripple, assetDurationMs: T.isMedia(it) ? ctx.assets[it.assetId]?.durationMs : undefined });
    return { item: describe(ctx, ctx.tl.items[i.itemId]!), appliedDeltaSeconds: s(r.appliedDeltaMs), shiftedItems: r.shiftedIds.length };
  },
});
def({
  name: "splitItem", label: "Splitting", mutates: true,
  description: "Cut an item in two at a timeline time (seconds).",
  schema: z.object({ itemId: z.string(), atSeconds: z.number() }),
  run: (ctx, i) => { const r = T.splitItem(ctx.tl, i.itemId, ms(i.atSeconds)); return { leftItemId: r.leftId, rightItemId: r.rightId }; },
});
def({
  name: "deleteItems", label: "Deleting", mutates: true,
  description: "Remove items. With ripple, the gap closes and everything after moves earlier. Captions linked to a deleted clip go with it.",
  schema: z.object({ itemIds: itemIdsIn, ripple: z.boolean().optional() }),
  run: (ctx, i) => { const r = T.deleteItems(ctx.tl, arr(i.itemIds), { ripple: i.ripple }); return { deleted: r.deletedIds, alsoDeleted: r.alsoDeletedIds, shiftedItems: r.shiftedIds.length, durationSeconds: s(T.timelineDuration(ctx.tl)) }; },
});
def({
  name: "moveItem", label: "Moving", mutates: true,
  description: "Move items in time (by seconds, or one item to an absolute time) and/or to another track. Fails with the free position if it would overlap.",
  schema: z.object({ itemIds: itemIdsIn, bySeconds: z.number().optional(), toSeconds: z.number().optional(), trackId: z.string().optional() }),
  run: (ctx, i) => ({ moved: T.moveItems(ctx.tl, arr(i.itemIds), { byMs: i.bySeconds !== undefined ? ms(i.bySeconds) : undefined, toMs: i.toSeconds !== undefined ? ms(i.toSeconds) : undefined, trackId: i.trackId }).moved.map((m) => ({ id: m.id, track: m.trackId, from: s(m.from), to: s(m.to) })) }),
});
def({
  name: "reorderItems", label: "Reordering", mutates: true,
  description: "Change the order of clips on a track: place the given items right before or after another item. The track is re-packed without gaps.",
  schema: z.object({ itemIds: itemIdsIn, beforeItemId: z.string().optional(), afterItemId: z.string().optional() }),
  run: (ctx, i) => ({ order: T.reorderItems(ctx.tl, arr(i.itemIds), { beforeId: i.beforeItemId, afterId: i.afterItemId }).order }),
});
def({
  name: "setSpeed", label: "Changing speed", mutates: true,
  description: "Speed a clip up or slow it down (1 is normal, 2 is double speed, 0.5 is half).",
  schema: z.object({ itemId: z.string(), speed: z.number(), ripple: z.boolean().optional() }),
  run: (ctx, i) => { const r = T.setPlaybackRate(ctx.tl, i.itemId, i.speed, { ripple: i.ripple }); return { from: s(r.from), to: s(r.to), ...(r.clamped ? { note: "The next clip kept it from growing, so it shows less of its footage. Use ripple to push later clips." } : {}) }; },
});
def({
  name: "editProperties", label: "Adjusting", mutates: true,
  description: "Change properties of one or more items. Media: volume (0-2), muted, fadeIn/fadeOut (seconds), x/y (pixels from centre), scale (1 = fills the frame), rotation, opacity, fit. Text: text, fontFamily, fontWeight, fontSize, color, strokeColor, strokeWidth, backgroundColor, uppercase, x/y, scale, animationIn/animationOut. Captions: text (to fix a word) and scale. Only the properties you pass change.",
  schema: z.object({ itemIds: itemIdsIn, properties: z.object({
    volume: z.number().optional(), muted: z.boolean().optional(), fadeIn: z.number().optional(), fadeOut: z.number().optional(),
    x: z.number().optional(), y: z.number().optional(), scale: z.number().optional(), rotation: z.number().optional(), opacity: z.number().optional(), fit: z.enum(["cover", "contain"]).optional(), flipH: z.boolean().optional(),
    text: z.string().optional(), fontFamily: z.string().optional(), fontWeight: z.number().optional(), fontSize: z.number().optional(), color: z.string().optional(), strokeColor: z.string().nullable().optional(), strokeWidth: z.number().optional(),
    backgroundColor: z.string().nullable().optional(), uppercase: z.boolean().optional(), align: z.enum(["left", "center", "right"]).optional(), animationIn: z.string().optional(), animationOut: z.string().optional(),
  }) }),
  run: (ctx, i) => {
    const p = i.properties;
    const done: unknown[] = [];
    for (const id of arr(i.itemIds)) {
      const it = T.itemOf(ctx.tl, id);
      if (T.isMedia(it)) {
        if (p.volume !== undefined) { if (it.type === "image") throw new T.OpError("INVALID_PROPERTY", "Only video and audio items have volume."); it.volume = Math.min(2, Math.max(0, p.volume)); delete it.keyframes?.volume; }
        if (p.muted !== undefined) it.muted = p.muted;
        if (p.fadeIn !== undefined) it.fadeInMs = ms(Math.max(0, p.fadeIn));
        if (p.fadeOut !== undefined) it.fadeOutMs = ms(Math.max(0, p.fadeOut));
      }
      if ("transform" in it) {
        const tr = it.transform;
        if (p.x !== undefined) tr.x = p.x; if (p.y !== undefined) tr.y = p.y; if (p.scale !== undefined) tr.scale = Math.max(0.05, p.scale);
        if (p.rotation !== undefined) tr.rotation = p.rotation; if (p.opacity !== undefined) tr.opacity = Math.min(1, Math.max(0, p.opacity));
        if (p.fit !== undefined) tr.fit = p.fit; if (p.flipH !== undefined) tr.flipH = p.flipH;
      }
      if (it.type === "text") {
        const t = it as TextItem;
        if (p.text !== undefined) t.text = p.text;
        if (p.fontFamily !== undefined) { const f = resolveFamily(p.fontFamily); if (f.toLowerCase() !== p.fontFamily.toLowerCase().trim()) throw new T.OpError("FONT_NOT_FOUND", `Font '${p.fontFamily}' is not available. Fonts: ${FONT_FAMILIES.join(", ")}.`); t.style.fontFamily = f; }
        if (p.fontWeight !== undefined) t.style.fontWeight = p.fontWeight; if (p.fontSize !== undefined) t.style.fontSize = p.fontSize; if (p.color !== undefined) t.style.color = p.color;
        if (p.strokeColor !== undefined) t.style.strokeColor = p.strokeColor; if (p.strokeWidth !== undefined) t.style.strokeWidth = p.strokeWidth;
        if (p.backgroundColor !== undefined) t.style.background = p.backgroundColor ? { color: p.backgroundColor, paddingX: Math.round(t.style.fontSize * 0.4), paddingY: Math.round(t.style.fontSize * 0.22), radius: Math.round(t.style.fontSize * 0.28) } : null;
        if (p.uppercase !== undefined) t.style.textTransform = p.uppercase ? "uppercase" : "none"; if (p.align !== undefined) t.style.align = p.align;
        if (p.animationIn !== undefined) t.animation.in = p.animationIn as TextItem["animation"]["in"]; if (p.animationOut !== undefined) t.animation.out = p.animationOut as TextItem["animation"]["out"];
      } else if (it.type === "caption") {
        const c = it as CaptionItem;
        if (p.text !== undefined) {
          const words = p.text.trim().split(/\s+/);
          if (words.length === c.words.length) c.words.forEach((w, k) => { w.text = words[k]!; });
          else { const a0 = c.words[0]!.s, b0 = c.words[c.words.length - 1]!.e; c.words = words.map((w, k) => ({ text: w, s: Math.round(a0 + ((b0 - a0) * k) / words.length), e: Math.round(a0 + ((b0 - a0) * (k + 1)) / words.length) })); }
        }
        if (p.scale !== undefined) c.override = { ...(c.override ?? {}), scale: p.scale };
        if (p.color !== undefined) c.override = { ...(c.override ?? {}), color: p.color };
      } else if (p.text !== undefined || p.fontFamily !== undefined) throw new T.OpError("INVALID_PROPERTY", `'${id}' is a ${it.type} item; text properties apply to text and caption items.`);
      done.push(describe(ctx, it));
    }
    return { updated: done };
  },
});
def({
  name: "addText", label: "Adding text", mutates: true,
  description: "Add a title, label or lower third. position is a quick placement (top, center, lower-third, bottom); x/y in pixels from the centre override it. Style it with font, size, colours and an optional background box.",
  schema: z.object({
    text: z.string(), startSeconds: z.number(), durationSeconds: z.number(), position: z.enum(["top", "center", "lower-third", "bottom"]).optional(), x: z.number().optional(), y: z.number().optional(),
    fontFamily: z.string().optional(), fontWeight: z.number().optional(), fontSize: z.number().optional(), color: z.string().optional(), strokeColor: z.string().nullable().optional(), strokeWidth: z.number().optional(),
    backgroundColor: z.string().nullable().optional(), uppercase: z.boolean().optional(), animationIn: z.enum(["none", "fade", "slide-up", "slide-left", "pop", "typewriter", "word-reveal"]).optional(), animationOut: z.enum(["none", "fade", "slide-up", "slide-left", "pop"]).optional(), role: z.enum(["title", "lower-third", "label", "body"]).optional(), trackId: z.string().optional(),
  }),
  run: (ctx, i) => {
    const k = Math.min(ctx.tl.size.width, ctx.tl.size.height) / 1080;
    const size = i.fontSize ?? Math.round((i.role === "lower-third" || i.position === "lower-third" ? 46 : 84) * k);
    const it = T.addText(ctx.tl, {
      text: i.text, startMs: ms(i.startSeconds), durationMs: ms(i.durationSeconds), trackId: i.trackId, x: i.x ?? 0, y: i.y ?? positionY(ctx.tl, i.position), role: i.role, animationIn: i.animationIn ?? "pop", animationOut: i.animationOut ?? "none",
      style: { fontFamily: i.fontFamily ? resolveFamily(i.fontFamily) : "Montserrat", fontWeight: i.fontWeight ?? 900, fontSize: size, color: i.color ?? "#FFFFFF", textTransform: i.uppercase ? "uppercase" : "none", strokeColor: i.strokeColor === undefined ? "#000000" : i.strokeColor, strokeWidth: i.strokeWidth ?? Math.round(size * 0.09),
        background: i.backgroundColor ? { color: i.backgroundColor, paddingX: Math.round(size * 0.4), paddingY: Math.round(size * 0.22), radius: Math.round(size * 0.28) } : null, ...(i.backgroundColor ? { strokeColor: null, strokeWidth: 0, shadow: null } : {}) },
    });
    return { added: describe(ctx, it) };
  },
});
def({
  name: "addCaptions", label: "Adding captions", mutates: true,
  description: "Caption the speech on the timeline from the transcript. Pick a look (see listLooks) and adjust it: mode ('word' one word at a time, 'phrase' a few words, 'highlight' phrase with the spoken word marked), wordsPerPhrase, position (0 top .. 1 bottom), colours, font. emphasisWords are shown in the emphasis colour and a little larger. Limit to some clips or a time range if needed. Running it again replaces the captions in scope.",
  schema: z.object({
    look: z.string().optional().describe("Caption look id"), mode: z.enum(["word", "phrase", "highlight"]).optional(), wordsPerPhrase: z.number().int().min(1).max(10).optional(), position: z.number().min(0.05).max(0.95).optional(),
    fontFamily: z.string().optional(), fontSize: z.number().optional(), color: z.string().optional(), highlightColor: z.string().optional(), emphasisColor: z.string().optional(), uppercase: z.boolean().optional(),
    emphasisWords: z.array(z.string()).optional(), spellings: z.record(z.string(), z.string()).optional().describe("Corrections, e.g. {'jesso': 'gesso'}"), sourceItemIds: z.array(z.string()).optional(), startSeconds: z.number().optional(), endSeconds: z.number().optional(),
  }),
  run: (ctx, i) => {
    const k = Math.min(ctx.tl.size.width, ctx.tl.size.height) / 1080;
    const style: Partial<CaptionStyle> = {};
    if (i.look) { const t = captionTemplate(i.look); if (!t) throw new T.OpError("LOOK_NOT_FOUND", `There is no caption look '${i.look}'. Looks: ${CAPTION_TEMPLATES.map((c) => c.id).join(", ")}.`); Object.assign(style, t.style, { fontSize: Math.round((t.style.fontSize ?? 70) * k) }); }
    if (i.fontFamily) style.fontFamily = resolveFamily(i.fontFamily);
    if (i.fontSize) style.fontSize = i.fontSize; if (i.color) style.color = i.color; if (i.highlightColor) style.highlightColor = i.highlightColor; if (i.emphasisColor) style.emphasisColor = i.emphasisColor;
    if (i.uppercase !== undefined) style.textTransform = i.uppercase ? "uppercase" : "none"; if (i.position !== undefined) style.position = i.position;
    const r = T.generateCaptions(ctx.tl, ctx.assets, { style, mode: i.mode, maxWordsPerPhrase: i.wordsPerPhrase, emphasisWords: i.emphasisWords, spellings: i.spellings, sourceItemIds: i.sourceItemIds, startMs: i.startSeconds !== undefined ? ms(i.startSeconds) : undefined, endMs: i.endSeconds !== undefined ? ms(i.endSeconds) : undefined });
    if (!r.created) return { created: 0, note: "No speech was found on the timeline in that scope, so there is nothing to caption.", skipped: r.skipped };
    const caps = T.itemsOnTrack(ctx.tl, r.trackId);
    return { created: r.created, track: r.trackId, look: i.look ?? "current", first: caps.slice(0, 3).map((c) => T.captionText(c as CaptionItem)), ...(r.skipped.length ? { skipped: r.skipped } : {}) };
  },
});
def({
  name: "editCaptions", label: "Restyling captions", mutates: true,
  description: "Change captions that already exist: switch look, change style values, emphasise or un-emphasise words, or remove captions in a time range. Style changes apply to the whole caption track.",
  schema: z.object({
    look: z.string().optional(), mode: z.enum(["word", "phrase", "highlight"]).optional(), position: z.number().min(0.05).max(0.95).optional(), fontFamily: z.string().optional(), fontSize: z.number().optional(), color: z.string().optional(), highlightColor: z.string().optional(), emphasisColor: z.string().optional(),
    uppercase: z.boolean().optional(), strokeWidth: z.number().optional(), animation: z.enum(["none", "pop", "fade", "slide-up"]).optional(), emphasize: z.array(z.string()).optional(), removeEmphasis: z.array(z.string()).optional(), removeFromSeconds: z.number().optional(), removeToSeconds: z.number().optional(),
  }),
  run: (ctx, i) => {
    const track = ctx.tl.tracks.find((t) => t.kind === "caption" && T.itemsOnTrack(ctx.tl, t.id).length) ?? ctx.tl.tracks.find((t) => t.kind === "caption");
    if (!track) throw new T.OpError("NO_CAPTIONS", "There are no captions yet. Use addCaptions first.");
    const k = Math.min(ctx.tl.size.width, ctx.tl.size.height) / 1080;
    const st = (track.captionStyle = { ...(track.captionStyle as CaptionStyle) });
    const regroup = !!(i.look || i.mode);
    if (i.look) { const t = captionTemplate(i.look); if (!t) throw new T.OpError("LOOK_NOT_FOUND", `There is no caption look '${i.look}'.`); Object.assign(st, t.style, { fontSize: Math.round((t.style.fontSize ?? 70) * k) }); }
    if (i.mode) st.mode = i.mode; if (i.position !== undefined) st.position = i.position; if (i.fontFamily) st.fontFamily = resolveFamily(i.fontFamily); if (i.fontSize) st.fontSize = i.fontSize;
    if (i.color) st.color = i.color; if (i.highlightColor) st.highlightColor = i.highlightColor; if (i.emphasisColor) st.emphasisColor = i.emphasisColor; if (i.uppercase !== undefined) st.textTransform = i.uppercase ? "uppercase" : "none";
    if (i.strokeWidth !== undefined) st.strokeWidth = i.strokeWidth; if (i.animation) st.animation = i.animation;
    let regrouped = 0;
    if (regroup) {
      // a new look may group words differently: rebuild from the transcript, keeping emphasis
      const emph = (T.itemsOnTrack(ctx.tl, track.id) as CaptionItem[]).flatMap((c) => c.words.filter((w) => w.emphasis).map((w) => w.text));
      regrouped = T.generateCaptions(ctx.tl, ctx.assets, { trackId: track.id, emphasisWords: emph }).created;
    }
    const marked = i.emphasize?.length ? T.markEmphasis(ctx.tl, track.id, i.emphasize, true) : 0;
    const cleared = i.removeEmphasis?.length ? T.markEmphasis(ctx.tl, track.id, i.removeEmphasis, false) : 0;
    let removed = 0;
    if (i.removeFromSeconds !== undefined && i.removeToSeconds !== undefined) {
      const ids = T.itemsOnTrack(ctx.tl, track.id).filter((c) => c.display.from >= ms(i.removeFromSeconds!) - 1 && c.display.to <= ms(i.removeToSeconds!) + 1).map((c) => c.id);
      if (ids.length) { T.deleteItems(ctx.tl, ids); removed = ids.length; }
    }
    return { track: track.id, captions: T.itemsOnTrack(ctx.tl, track.id).length, ...(regrouped ? { regrouped } : {}), ...(marked ? { emphasised: marked } : {}), ...(cleared ? { emphasisRemoved: cleared } : {}), ...(removed ? { removed } : {}), ...(i.emphasize?.length && !marked ? { note: "None of those words were found in the captions." } : {}) };
  },
});
def({
  name: "cutDeadSpace", label: "Tightening the cut", mutates: true,
  description: "Remove pauses, filler words (um, uh) and restarted sentences from speech clips using the transcript, closing the gaps. Returns every cut with its time so it can be reviewed. Without itemIds it tightens all speech on the timeline.",
  schema: z.object({ itemIds: z.array(z.string()).optional(), minPauseSeconds: z.number().min(0.1).max(5).optional().describe("Pauses longer than this are cut. Default 0.5"), removeFillers: z.boolean().optional(), removeRestarts: z.boolean().optional(), keepRanges: z.array(z.object({ fromSeconds: z.number(), toSeconds: z.number() })).optional().describe("Timeline ranges to leave untouched") }),
  run: (ctx, i) => {
    let protect: { from: number; to: number }[] | undefined;
    if (i.keepRanges?.length) {
      protect = [];
      for (const r of i.keepRanges) for (const it of Object.values(ctx.tl.items)) if (T.isMedia(it) && it.display.to > ms(r.fromSeconds) && it.display.from < ms(r.toSeconds)) protect.push({ from: T.timelineToSource(it, ms(r.fromSeconds)), to: T.timelineToSource(it, ms(r.toSeconds)) });
    }
    const before = T.timelineDuration(ctx.tl);
    const r = T.cutDeadSpace(ctx.tl, ctx.assets, i.itemIds, { minPauseMs: ms(i.minPauseSeconds ?? 0.5), removeFillers: i.removeFillers ?? true, removeRestarts: i.removeRestarts ?? true, protectRanges: protect });
    return { cuts: r.cuts.length, removedSeconds: r.removedSeconds, durationBefore: s(before), durationAfter: s(T.timelineDuration(ctx.tl)), cutList: r.cuts.slice(0, 60).map((c) => `${c.fromSeconds}-${c.toSeconds}s ${c.reason}${c.text ? ` "${c.text}"` : ""}`), ...(r.cuts.length ? {} : { note: "Nothing to remove at that threshold." }) };
  },
});
def({
  name: "addMusic", label: "Adding music", mutates: true,
  description: "Put a music track under the edit. It is trimmed to the edit's length, faded out at the end and, with duckUnderSpeech, turned down automatically whenever someone is speaking.",
  schema: z.object({ assetId: z.string(), volume: z.number().min(0).max(2).optional().describe("Level when nobody speaks. Default 0.3 with speech, 0.9 without"), duckUnderSpeech: z.boolean().optional(), duckedVolume: z.number().min(0).max(1).optional(), startAtSeconds: z.number().optional().describe("Where in the song to start"), fadeOutSeconds: z.number().optional() }),
  run: (ctx, i) => {
    const a = asset(ctx, i.assetId);
    if (!a.hasAudio) throw new T.OpError("NO_AUDIO", `'${i.assetId}' has no audio.`);
    const d = T.timelineDuration(ctx.tl);
    if (d <= 0) throw new T.OpError("EMPTY_TIMELINE", "Add clips before music so the track can be cut to the edit's length.");
    const hasSpeech = T.speechRanges(ctx.tl, ctx.assets).length > 0;
    const base = i.volume ?? (hasSpeech ? 0.3 : 0.9);
    const from = ms(i.startAtSeconds ?? 0);
    const track = T.ensureTrack(ctx.tl, "audio", { from: 0, to: d });
    const [m] = T.placeMedia(ctx.tl, [{ asset: a, trimStartMs: from, trimEndMs: Math.min(a.durationMs, from + d + 400), volume: base }], { trackId: track.id, atMs: 0 });
    m!.fadeOutMs = ms(i.fadeOutSeconds ?? 0.7);
    const duck = i.duckUnderSpeech ?? hasSpeech;
    const dips = duck ? T.duckUnderSpeech(ctx.tl, ctx.assets, m!.id, { baseVolume: base, duckedVolume: i.duckedVolume ?? Math.min(base, 0.09) }).dips : 0;
    return { added: describe(ctx, m!), ducked: duck, dips, ...(a.durationMs - from < d ? { note: "The track is shorter than the edit and ends early." } : {}) };
  },
});
def({
  name: "syncToBeats", label: "Cutting to the beat", mutates: true,
  description: "Build or rebuild the main track so every cut lands on the beat of a music track. Give the clips in play order; each gets one slot of everyBeats beats. Use sections to change density over time (e.g. every 2 beats in the verse, every beat in the chorus). The music is added if it is not on the timeline yet.",
  schema: z.object({
    musicAssetId: z.string(), clipAssetIds: z.array(z.string()).min(1), everyBeats: z.number().int().min(1).max(16).optional(), sections: z.array(z.object({ fromSeconds: z.number(), everyBeats: z.number().int().min(1).max(16) })).optional(),
    lengthSeconds: z.number().optional(), startOnDownbeat: z.boolean().optional(), replace: z.boolean().optional().describe("Clear the main video track first. Default true"), keepClipAudio: z.boolean().optional(),
  }),
  run: (ctx, i) => {
    const music = asset(ctx, i.musicAssetId);
    const beats = (music.rhythm?.pulseBeats ?? []).map((b) => Math.round(b[0] * 1000));
    if (beats.length < 4) throw new T.OpError("NO_BEATS", `No beat grid was found in '${i.musicAssetId}'. Use a track with a clear pulse, or place clips by time.`);
    const clips = i.clipAssetIds.map((id) => asset(ctx, id));
    const first = i.startOnDownbeat ? Math.round((music.rhythm!.downbeats[0]?.[0] ?? beats[0]! / 1000) * 1000) : beats[0]!;
    const end = Math.min(music.durationMs, i.lengthSeconds !== undefined ? ms(i.lengthSeconds) : beats[beats.length - 1]!);
    const sections = [...(i.sections ?? [])].sort((a, b) => a.fromSeconds - b.fromSeconds);
    const every = (t: number) => { let e = i.everyBeats ?? 2; for (const sec of sections) if (t + first >= ms(sec.fromSeconds)) e = sec.everyBeats; return e; };
    let slots = T.beatSlots(beats, first, end, every);
    if (!slots.length) throw new T.OpError("NO_SLOTS", "No beat slots fit in that length.");
    const main = T.mainVideoTrack(ctx.tl) ?? T.ensureTrack(ctx.tl, "video");
    if (i.replace !== false) T.deleteItems(ctx.tl, T.itemsOnTrack(ctx.tl, main.id).map((x) => x.id));
    if (slots[0]!.fromMs > 0 && slots[0]!.fromMs < 700) slots[0] = { ...slots[0]!, fromMs: 0 };
    const usedWin: Record<string, number> = {};
    const placed: string[] = [];
    slots.forEach((sl, n) => {
      const a = clips[n % clips.length]!;
      const len = sl.toMs - sl.fromMs;
      const offset = a.type === "image" ? 0 : Math.min(Math.max(0, a.durationMs - len), (usedWin[a.id] ?? Math.max(0, (a.durationMs - len) / 2 - (a.durationMs > len * 3 ? len : 0))));
      usedWin[a.id] = offset + len;
      if (usedWin[a.id]! + len > a.durationMs) usedWin[a.id] = 0;
      const [it] = T.placeMedia(ctx.tl, [{ asset: a, trimStartMs: offset, trimEndMs: Math.min(a.durationMs || len, offset + len), durationMs: len, muted: !i.keepClipAudio }], { trackId: main.id, atMs: sl.fromMs });
      it!.display = { from: sl.fromMs, to: sl.toMs };
      if (a.type !== "image") it!.playbackRate = (it!.trim.to - it!.trim.from) / len;
      placed.push(`${s(sl.fromMs)}-${s(sl.toMs)} ${ctx.agentOf[a.id]}`);
    });
    const total = T.timelineDuration(ctx.tl);
    let musicItem = Object.values(ctx.tl.items).find((x) => T.isMedia(x) && x.assetId === music.id) as MediaItem | undefined;
    if (!musicItem) { const at = T.ensureTrack(ctx.tl, "audio", { from: 0, to: total }); [musicItem] = T.placeMedia(ctx.tl, [{ asset: music, trimStartMs: 0, trimEndMs: Math.min(music.durationMs, total + 800), volume: 0.9 }], { trackId: at.id, atMs: 0 }); musicItem!.fadeOutMs = 600; }
    return { slots: slots.length, bpm: music.rhythm!.averageBpm, durationSeconds: s(total), placed: placed.slice(0, 40), music: musicItem!.id };
  },
});
def({
  name: "applyTransition", label: "Adding a transition", mutates: true,
  description: "Put a transition on the cut into an item (from the item before it on the same track).",
  schema: z.object({ toItemId: z.string(), kind: z.enum(TRANSITION_KINDS), durationSeconds: z.number().min(0.08).max(3).optional() }),
  run: (ctx, i) => { const t = T.applyTransition(ctx.tl, { toItemId: i.toItemId, kind: i.kind as TransitionKind, durationMs: i.durationSeconds !== undefined ? ms(i.durationSeconds) : undefined }); return { transition: t.id, kind: t.kind, from: t.fromItemId, to: t.toItemId, seconds: s(t.durationMs) }; },
});
def({
  name: "setLook", label: "Grading", mutates: true,
  description: "Colour: apply a named filter at a strength (0-100) and/or individual effects (brightness, contrast, saturation, temperature, tint, blur, vignette, grayscale, sepia, hue, fade) to clips. Use all: true for every clip. filterId null removes the filter.",
  schema: z.object({ itemIds: z.array(z.string()).optional(), all: z.boolean().optional(), filterId: z.string().nullable().optional(), strength: z.number().min(0).max(100).optional(), effects: z.array(z.object({ id: z.enum(Object.keys(EFFECT_INFO) as [string, ...string[]]), value: z.number() })).optional(), clearEffects: z.boolean().optional() }),
  run: (ctx, i) => {
    const ids = i.all ? Object.values(ctx.tl.items).filter((x) => x.type === "video" || x.type === "image").map((x) => x.id) : i.itemIds ?? [];
    if (!ids.length) throw new T.OpError("MISSING_PARAM", "Name the clips with itemIds, or pass all: true.");
    if (i.filterId !== undefined) {
      if (i.filterId !== null && !FILTERS.some((f) => f.id === i.filterId)) throw new T.OpError("FILTER_UNKNOWN", `No filter named '${i.filterId}'. Filters: ${FILTERS.map((f) => f.id).join(", ")}.`);
      for (const id of ids) { const it = T.itemOf<MediaItem>(ctx.tl, id); if (it.type !== "video" && it.type !== "image") throw new T.OpError("FILTER_UNSUPPORTED_ITEM", `Filters go on video and image clips; '${id}' is a ${it.type} item.`); it.filter = i.filterId ? { id: i.filterId, strength: i.strength ?? 100 } : null; }
    }
    if (i.effects?.length || i.clearEffects) T.writeEffects(ctx.tl, ids, { set: i.effects, clear: i.clearEffects });
    return { clips: ids.length, filter: i.filterId, effects: i.effects?.map((e) => `${e.id}:${e.value}`) };
  },
});
def({
  name: "resizeCanvas", label: "Resizing the canvas", mutates: true,
  description: "Change the frame: 9:16 (TikTok, Reels, Shorts), 16:9, 1:1 or 4:5, or an exact width and height. Clips re-fit automatically; text and captions scale.",
  schema: z.object({ aspectRatio: z.enum(["9:16", "16:9", "1:1", "4:5"]).optional(), width: z.number().optional(), height: z.number().optional() }),
  run: (ctx, i) => { const p = i.aspectRatio ? CANVAS_PRESETS.find((c) => c.id === i.aspectRatio)! : null; if (!p && !(i.width && i.height)) throw new T.OpError("MISSING_PARAM", "Give aspectRatio, or width and height."); return T.resizeCanvas(ctx.tl, p?.width ?? i.width!, p?.height ?? i.height!); },
});
def({
  name: "applyTrend", label: "Building from a trend", mutates: true,
  description: "Rebuild this project's edit from a trend blueprint and the project's footage: hook first, the trend's cut rhythm and caption look, its sound when available. Replaces the current timeline.",
  schema: z.object({ trendId: z.string(), assetIds: z.array(z.string()).optional().describe("Footage to use. Default: everything in the project"), musicAssetId: z.string().optional(), targetSeconds: z.number().optional(), captionLook: z.string().optional(), hookText: z.string().nullable().optional() }),
  run: (ctx, i) => {
    const t = getTrend(i.trendId);
    if (!t?.blueprint) throw new T.OpError("TREND_NOT_FOUND", `There is no analysed trend '${i.trendId}'. Use listTrends.`);
    const use = (i.assetIds?.length ? i.assetIds.map((id) => asset(ctx, id)) : Object.values(ctx.byAgent)).filter((a) => a.contentType !== "music");
    const music = i.musicAssetId ? asset(ctx, i.musicAssetId) : Object.values(ctx.byAgent).find((a) => a.contentType === "music") ?? null;
    const r = remix({ blueprint: t.blueprint, assets: use, musicAsset: music, targetSeconds: i.targetSeconds, captionLook: i.captionLook, hookText: i.hookText });
    const keepVersion = ctx.tl.version;
    for (const k of Object.keys(ctx.tl) as (keyof Timeline)[]) delete (ctx.tl as unknown as Record<string, unknown>)[k];
    Object.assign(ctx.tl, r.timeline, { version: keepVersion });
    return { built: r.report };
  },
});
def({
  name: "applyTemplate", label: "Applying a template", mutates: true,
  description: "Rebuild this project's edit with a built-in template (see listLooks): short-talking-head, vlog, long-podcast or beat-montage. The template sets the structure, pacing, captions and music behaviour. Replaces the current timeline.",
  schema: z.object({ templateId: z.string(), assetIds: z.array(z.string()).optional().describe("Footage to use. Default: everything in the project"), musicAssetId: z.string().optional(), targetSeconds: z.number().optional(), captionLook: z.string().optional(), hookText: z.string().nullable().optional() }),
  run: (ctx, i) => {
    const t = templateById(i.templateId);
    if (!t) throw new T.OpError("TEMPLATE_NOT_FOUND", `There is no template '${i.templateId}'. Templates: ${TEMPLATES.map((x) => x.id).join(", ")}.`);
    const use = (i.assetIds?.length ? i.assetIds.map((id) => asset(ctx, id)) : Object.values(ctx.byAgent)).filter((a) => a.contentType !== "music");
    const music = i.musicAssetId ? asset(ctx, i.musicAssetId) : t.defaults.musicOn ? Object.values(ctx.byAgent).find((a) => a.contentType === "music") ?? null : null;
    const r = remix({ blueprint: templateBlueprint(t), template: t, assets: use, musicAsset: music, targetSeconds: i.targetSeconds, captionLook: i.captionLook, hookText: i.hookText });
    const keepVersion = ctx.tl.version;
    for (const k of Object.keys(ctx.tl) as (keyof Timeline)[]) delete (ctx.tl as unknown as Record<string, unknown>)[k];
    Object.assign(ctx.tl, r.timeline, { version: keepVersion });
    ctx.project.templateId = t.id; ctx.project.trendId = null; saveProject(ctx.project);
    return { built: r.report };
  },
});
def({
  name: "exportProject", label: "Exporting", mutates: false,
  description: "Render the edit to a video file. Returns a render id; the file appears in the Exports list when it is done.",
  schema: z.object({ preset: z.enum(EXPORT_PRESETS.map((p) => p.id) as [string, ...string[]]).optional(), resolution: z.enum(["480p", "720p", "1080p", "1440p", "4k", "original"]).optional(), format: z.enum(["mp4", "webm"]).optional() }),
  run: (ctx, i) => { const p = EXPORT_PRESETS.find((x) => x.id === (i.preset ?? "social"))!; const job = startExport(ctx.projectId, { preset: p.id, resolution: i.resolution ?? p.resolution, bitrateMbps: p.bitrateMbps, format: i.format ?? p.format }); return { renderId: job.id, status: job.status, size: `${job.width}x${job.height}`, seconds: s(job.durationMs) }; },
});

export function searchAssets(assets: AssetDoc[], query: string): { assetId: string; name: string; kind: "said" | "shown"; fromSeconds: number; toSeconds: number; text: string; score: number }[] {
  const q = query.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter((w) => w.length > 1);
  const hits: ReturnType<typeof searchAssets> = [];
  if (!q.length) return hits;
  const score = (text: string) => { const t = text.toLowerCase(); let n = 0; for (const w of q) if (t.includes(w)) n++; return n / q.length + (t.includes(query.toLowerCase()) ? 0.5 : 0); };
  for (const a of assets) {
    for (const x of sentencesOf(a)) { const sc = score(x.text); if (sc >= 0.5) hits.push({ assetId: a.id, name: a.name, kind: "said", fromSeconds: s(x.startMs), toSeconds: s(x.endMs), text: x.text, score: sc }); }
    for (const x of a.analysis?.segments ?? []) { const sc = score(x.description); if (sc >= 0.5) hits.push({ assetId: a.id, name: a.name, kind: "shown", fromSeconds: x.start_time, toSeconds: x.end_time, text: x.description, score: sc * 0.95 }); }
    const nameScore = score(`${a.name.replace(/[_.-]/g, " ")} ${(a.analysis?.tags ?? []).join(" ")}`);
    if (nameScore >= 0.5) hits.push({ assetId: a.id, name: a.name, kind: "shown", fromSeconds: 0, toSeconds: s(a.durationMs), text: a.analysis?.summary ?? a.name, score: nameScore * 0.8 });
  }
  return hits.sort((a, b) => b.score - a.score);
}

export const TOOLS = tools;
export const toolByName = (n: string) => tools.find((t) => t.name === n);
export const toolJsonSchema = (t: Tool) => { const j = z.toJSONSchema(t.schema) as Record<string, unknown>; delete j.$schema; return j; };

export function loadContext(ctx: ToolContext): Loaded {
  const project = getProject(ctx.projectId);
  if (!project) throw new T.OpError("PROJECT_NOT_FOUND", `There is no project '${ctx.projectId}'.`);
  const tl = getTimeline(ctx.projectId)!;
  const pa = projectAssets(project);
  const assets: Record<string, AssetDoc> = {}, byAgent: Record<string, AssetDoc> = {}, agentOf: Record<string, string> = {}, names: Loaded["names"] = {};
  for (const { asset: a, agentId } of pa) { assets[a.id] = a; byAgent[agentId] = a; agentOf[a.id] = agentId; names[a.id] = { agentId, name: a.name }; }
  // items may reference assets that were removed from the project list; keep them resolvable
  for (const it of Object.values(tl.items)) if (T.isMedia(it) && !assets[it.assetId]) { const a = getAsset(it.assetId); if (a) assets[a.id] = a; }
  return { ...ctx, project, tl, assets, byAgent, agentOf, names };
}

/** Run one tool against a project. Mutating tools commit the timeline and announce it; a failed tool changes nothing. */
export async function runTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolResult> {
  const tool = toolByName(name);
  if (!tool) return { ok: false, code: "UNKNOWN_TOOL", error: `There is no tool '${name}'. Tools: ${tools.map((t) => t.name).join(", ")}.` };
  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT", error: `Invalid input for ${name}: ${parsed.error.issues.slice(0, 4).map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; ")}` };
  try {
    const loaded = loadContext(ctx);
    const before = tool.mutates ? JSON.stringify(loaded.tl) : "";
    const out = await tool.run(loaded, parsed.data);
    if (tool.mutates) {
      const problems = T.validateTimeline(loaded.tl);
      if (problems.length) return { ok: false, code: "INVALID_RESULT", error: `${name} was not applied because it would leave the timeline inconsistent: ${problems.slice(0, 3).join("; ")}` };
      if (JSON.stringify(loaded.tl) !== before) { loaded.tl.version = (loaded.tl.version ?? 0) + 1; saveTimeline(ctx.projectId, loaded.tl); emit({ type: "timeline", projectId: ctx.projectId, timeline: loaded.tl, by: "tool", tool: name }); }
    }
    const { images, ...rest } = out as { images?: ToolResult["images"] };
    return { ok: true, ...rest, ...(images ? { images } : {}) };
  } catch (e) {
    if (e instanceof T.OpError) return { ok: false, code: e.code, error: e.message, ...(e.details ?? {}) };
    console.error(`[tool ${name}]`, e);
    return { ok: false, code: "TOOL_FAILED", error: (e as Error).message };
  }
}
