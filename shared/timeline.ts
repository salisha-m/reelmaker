// Timeline operations. Pure functions over a Timeline object: the editor UI, the
// built-in agent, the MCP server and the auto-editor all go through these.
import type {
  Asset, CaptionItem, CaptionStyle, CaptionWord, Effect, ID, Item, Keyframe, KeyframeProp, MediaItem, MGLayer, MotionGraphicItem, ShapeItem,
  TextItem, TextStyle, Timeline, Track, TrackKind, Transform, Transition, TransitionKind, Transcription, TextAnimation,
} from "./types.ts";
import { DEFAULT_CAPTION_STYLE, DEFAULT_TEXT_STYLE, FILLER_WORDS } from "./catalog.ts";

export class OpError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const MIN_ITEM_MS = 40;
export const sec = (ms: number) => Math.round(ms) / 1000;
export const ms = (s: number) => Math.round(s * 1000);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: "cover" };

export function emptyTimeline(width = 1080, height = 1920, fps = 30): Timeline & { seq: number } {
  const tl: Timeline & { seq: number } = { size: { width, height }, fps, background: "#000000", tracks: [], items: {}, transitions: [], markers: [], version: 1, seq: 0 };
  addTrack(tl, "caption");
  addTrack(tl, "overlay");
  addTrack(tl, "video");
  addTrack(tl, "audio");
  return tl;
}

type TL = Timeline & { seq?: number };
function nextSeq(tl: TL): number {
  tl.seq = (tl.seq ?? Object.keys(tl.items).length + tl.tracks.length) + 1;
  return tl.seq;
}
const PREFIX: Record<string, string> = { video: "clip", image: "img", audio: "aud", text: "text", caption: "cap", shape: "shape", motionGraphic: "mg" };
export function newItemId(tl: TL, type: string): ID {
  let id: string;
  do id = `${PREFIX[type] ?? "item"}_${nextSeq(tl)}`; while (tl.items[id]);
  return id;
}

// ---------- queries ----------
export function trackOf(tl: Timeline, trackId: ID): Track {
  const t = tl.tracks.find((x) => x.id === trackId);
  if (!t) throw new OpError("TRACK_NOT_FOUND", `Track '${trackId}' does not exist. Tracks: ${tl.tracks.map((x) => x.id).join(", ")}.`);
  return t;
}
export function itemOf<T extends Item = Item>(tl: Timeline, id: ID): T {
  const it = tl.items[id];
  if (!it) throw new OpError("ITEM_NOT_FOUND", `There is no item '${id}' on the timeline. Read the timeline again for current ids.`);
  return it as T;
}
export function itemsOnTrack(tl: Timeline, trackId: ID): Item[] {
  return Object.values(tl.items).filter((i) => i.trackId === trackId).sort((a, b) => a.display.from - b.display.from || a.id.localeCompare(b.id));
}
export function timelineDuration(tl: Timeline): number {
  let end = 0;
  for (const i of Object.values(tl.items)) if (i.display.to > end) end = i.display.to;
  return end;
}
export const isMedia = (i: Item): i is MediaItem => i.type === "video" || i.type === "image" || i.type === "audio";
export const isVisual = (i: Item) => i.type !== "audio";
export function trackKindFor(type: Item["type"]): TrackKind {
  if (type === "audio") return "audio";
  if (type === "caption") return "caption";
  if (type === "video" || type === "image") return "video";
  return "overlay";
}
export function trackAccepts(track: Track, type: Item["type"]): boolean {
  if (track.kind === "audio") return type === "audio";
  if (track.kind === "caption") return type === "caption";
  if (track.kind === "video") return type === "video" || type === "image";
  // overlay tracks take anything visual except captions
  return type !== "audio" && type !== "caption";
}
/** Timeline time for a source time of a media item (may fall outside the item). */
export function sourceToTimeline(item: MediaItem, srcMs: number): number {
  return item.display.from + (srcMs - item.trim.from) / item.playbackRate;
}
export function timelineToSource(item: MediaItem, tMs: number): number {
  return item.trim.from + (tMs - item.display.from) * item.playbackRate;
}
export function mainVideoTrack(tl: Timeline): Track | undefined {
  const vids = tl.tracks.filter((t) => t.kind === "video");
  // the bottom-most video track is the main storyline
  return vids[vids.length - 1];
}

// ---------- tracks ----------
export function addTrack(tl: TL, kind: TrackKind, opts: { name?: string; index?: number; id?: string } = {}): Track {
  const n = tl.tracks.filter((t) => t.kind === kind).length + 1;
  let id = opts.id ?? `${kind}_${n}`;
  let k = n;
  while (tl.tracks.some((t) => t.id === id)) id = `${kind}_${++k}`;
  const track: Track = { id, kind, name: opts.name ?? `${kind[0]!.toUpperCase()}${kind.slice(1)} ${k}`, muted: false, hidden: false, locked: false, gain: 1 };
  if (kind === "caption") track.captionStyle = { ...DEFAULT_CAPTION_STYLE };
  // default layering: captions on top, then overlays, then video, audio last
  const order: TrackKind[] = ["caption", "overlay", "video", "audio"];
  let index = opts.index;
  if (index === undefined) {
    // new tracks of a kind go above existing tracks of that kind
    const firstSame = tl.tracks.findIndex((t) => t.kind === kind);
    if (firstSame >= 0) index = firstSame;
    else {
      const rank = order.indexOf(kind);
      index = tl.tracks.findIndex((t) => order.indexOf(t.kind) > rank);
      if (index < 0) index = tl.tracks.length;
    }
  }
  tl.tracks.splice(clamp(index, 0, tl.tracks.length), 0, track);
  return track;
}
export function removeTrack(tl: Timeline, trackId: ID, force = false) {
  const items = itemsOnTrack(tl, trackId);
  if (items.length && !force) throw new OpError("TRACK_NOT_EMPTY", `Track '${trackId}' still holds ${items.length} item(s). Delete them first or pass force.`);
  deleteItems(tl, items.map((i) => i.id));
  tl.tracks = tl.tracks.filter((t) => t.id !== trackId);
}
export function ensureTrack(tl: TL, kind: TrackKind, preferEmptyAt?: { from: number; to: number }): Track {
  const candidates = tl.tracks.filter((t) => t.kind === kind && !t.locked);
  if (preferEmptyAt) {
    for (const t of [...candidates].reverse()) if (!collides(tl, t.id, preferEmptyAt.from, preferEmptyAt.to)) return t;
    return addTrack(tl, kind);
  }
  return candidates[candidates.length - 1] ?? addTrack(tl, kind);
}
export function consolidateTracks(tl: Timeline): { removed: string[] } {
  const removed: string[] = [];
  const seen = new Set<TrackKind>();
  // keep the last (bottom) track of each kind even if empty
  for (const t of [...tl.tracks].reverse()) {
    const empty = itemsOnTrack(tl, t.id).length === 0;
    if (empty && seen.has(t.kind)) removed.push(t.id);
    seen.add(t.kind);
  }
  tl.tracks = tl.tracks.filter((t) => !removed.includes(t.id));
  return { removed };
}

// ---------- collisions ----------
export function collides(tl: Timeline, trackId: ID, from: number, to: number, ignore: ID[] = []): Item | null {
  for (const i of Object.values(tl.items)) {
    if (i.trackId !== trackId || ignore.includes(i.id)) continue;
    if (i.display.from < to - 0.5 && i.display.to > from + 0.5) return i;
  }
  return null;
}
function assertUnlocked(tl: Timeline, trackId: ID) {
  const t = trackOf(tl, trackId);
  if (t.locked) throw new OpError("TRACK_LOCKED", `Track '${trackId}' is locked. Unlock it first.`);
}
function nextFree(tl: Timeline, trackId: ID, from: number, length: number): number {
  const items = itemsOnTrack(tl, trackId);
  let t = from;
  for (const i of items) {
    if (i.display.to <= t) continue;
    if (i.display.from >= t + length) break;
    t = i.display.to;
  }
  return t;
}
function collisionError(tl: Timeline, verb: string, itemId: string, trackId: ID, from: number, to: number, blocker: Item): OpError {
  const free = nextFree(tl, trackId, from, to - from);
  return new OpError("COLLISION", `${verb}: '${itemId}' at ${sec(from)}s-${sec(to)}s would overlap '${blocker.id}' (${sec(blocker.display.from)}s-${sec(blocker.display.to)}s) on track ${trackId}. That track has room for it from ${sec(free)}s, or use ripple to push later items.`, { blockerId: blocker.id, nextFreeSeconds: sec(free) });
}

/** Shift every item starting at/after `fromMs` by `deltaMs` on the given tracks. */
function shiftFrom(tl: Timeline, trackIds: ID[], fromMs: number, deltaMs: number, exclude: ID[] = []): ID[] {
  const moved: ID[] = [];
  if (!deltaMs) return moved;
  for (const i of Object.values(tl.items)) {
    if (!trackIds.includes(i.trackId) || exclude.includes(i.id)) continue;
    if (i.type === "caption" && !(i as CaptionItem).manual) continue; // linked captions follow their clip in syncCaptions
    if (i.display.from >= fromMs - 0.5) {
      i.display = { from: Math.max(0, i.display.from + deltaMs), to: Math.max(0, i.display.from + deltaMs) + (i.display.to - i.display.from) };
      moved.push(i.id);
    }
  }
  return moved;
}
/** Tracks that move together when the storyline is rippled: everything except music/audio beds. */
function rippleTracks(tl: Timeline, trackId: ID): ID[] {
  const t = trackOf(tl, trackId);
  if (t.kind === "audio") return [trackId];
  const main = mainVideoTrack(tl);
  if (main && main.id !== trackId && t.kind !== "video") return [trackId];
  return tl.tracks.filter((x) => x.kind !== "audio" && !x.locked).map((x) => x.id);
}

// ---------- media ----------
export interface PlaceEntry {
  asset: Pick<Asset, "id" | "type" | "durationMs" | "name" | "width" | "height">;
  trimStartMs?: number;
  trimEndMs?: number;
  durationMs?: number;
  playbackRate?: number;
  volume?: number;
  muted?: boolean;
  fit?: "cover" | "contain";
  name?: string;
}
export interface PlaceOptions { trackId?: ID; atMs?: number; insertAfterItemId?: ID; ripple?: boolean }
export function placeMedia(tl: TL, entries: PlaceEntry[], opts: PlaceOptions = {}): MediaItem[] {
  if (!entries.length) throw new OpError("MISSING_PARAM", "Nothing to add.");
  const firstType = entries[0]!.asset.type;
  let track: Track;
  let cursor: number;
  let ripple = !!opts.ripple;
  if (opts.insertAfterItemId) {
    const ref = itemOf(tl, opts.insertAfterItemId);
    track = trackOf(tl, ref.trackId);
    cursor = ref.display.to;
    ripple = true;
  } else {
    track = opts.trackId ? trackOf(tl, opts.trackId) : ensureTrack(tl, trackKindFor(firstType));
    cursor = opts.atMs ?? (itemsOnTrack(tl, track.id).at(-1)?.display.to ?? 0);
  }
  assertUnlocked(tl, track.id);
  const created: MediaItem[] = [];
  const plan: { e: PlaceEntry; from: number; to: number; trim: { from: number; to: number }; rate: number }[] = [];
  let t = Math.max(0, Math.round(cursor));
  for (const e of entries) {
    if (!trackAccepts(track, e.asset.type)) throw new OpError("TRACK_INCOMPATIBLE", `A ${e.asset.type} item goes on a ${trackKindFor(e.asset.type)} track; '${track.id}' is a ${track.kind} track.`);
    const rate = e.playbackRate ?? 1;
    if (!(rate > 0.05 && rate <= 16)) throw new OpError("INVALID_VALUE", "playbackRate must be between 0.05 and 16.");
    const srcDur = e.asset.type === "image" ? Number.POSITIVE_INFINITY : e.asset.durationMs;
    let tf = Math.max(0, Math.round(e.trimStartMs ?? 0));
    let tt = e.trimEndMs !== undefined ? Math.round(e.trimEndMs) : e.asset.type === "image" ? tf + Math.round(e.durationMs ?? 3000) : srcDur;
    if (e.durationMs !== undefined && e.trimEndMs === undefined && e.asset.type !== "image") tt = tf + Math.round(e.durationMs * rate);
    if (e.asset.type !== "image") {
      if (tf >= srcDur) throw new OpError("TRIM_OUT_OF_RANGE", `trimStart ${sec(tf)}s is past the end of '${e.asset.name}' (${sec(srcDur)}s).`);
      tt = Math.min(tt, srcDur);
    }
    if (tt - tf < MIN_ITEM_MS) throw new OpError("TRIM_TOO_SHORT", `The selected range of '${e.asset.name}' is shorter than ${MIN_ITEM_MS}ms.`);
    const len = Math.round((tt - tf) / rate);
    plan.push({ e, from: t, to: t + len, trim: { from: tf, to: tt }, rate });
    t += len;
  }
  const start = plan[0]!.from;
  const total = t - start;
  if (ripple) {
    shiftFrom(tl, opts.insertAfterItemId ? rippleTracks(tl, track.id) : [track.id], start, total);
  } else {
    for (const p of plan) {
      const b = collides(tl, track.id, p.from, p.to);
      if (b) throw collisionError(tl, "Add failed", p.e.asset.name, track.id, p.from, p.to, b);
    }
  }
  for (const p of plan) {
    const id = newItemId(tl, p.e.asset.type);
    const item: MediaItem = {
      id, trackId: track.id, type: p.e.asset.type, assetId: p.e.asset.id, name: p.e.name ?? p.e.asset.name,
      display: { from: p.from, to: p.to }, trim: p.trim, playbackRate: p.rate,
      volume: p.e.volume ?? 1, muted: p.e.muted ?? false, fadeInMs: 0, fadeOutMs: 0,
      transform: { ...DEFAULT_TRANSFORM, fit: p.e.fit ?? "cover" }, effects: [], filter: null, originId: id,
    };
    tl.items[id] = item;
    created.push(item);
  }
  syncCaptions(tl);
  return created;
}

export function trimItem(tl: Timeline, itemId: ID, handle: "start" | "end", deltaMs: number, opts: { ripple?: boolean; assetDurationMs?: number } = {}): { appliedDeltaMs: number; shiftedIds: ID[] } {
  const item = itemOf(tl, itemId);
  assertUnlocked(tl, item.trackId);
  if (item.type === "caption" && !(item as CaptionItem).manual) throw new OpError("CAPTION_LINKED", `'${itemId}' is a caption linked to a clip; trim the clip and the caption follows.`);
  const media = isMedia(item) ? item : null;
  const rate = media?.playbackRate ?? 1;
  const srcMax = media && media.type !== "image" ? opts.assetDurationMs ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
  const len = item.display.to - item.display.from;
  let delta = Math.round(deltaMs);
  let shifted: ID[] = [];
  if (handle === "end") {
    // positive: extend later, negative: shorten
    if (media && media.type !== "image") delta = Math.min(delta, Math.floor((srcMax - media.trim.to) / rate));
    delta = Math.max(delta, -(len - MIN_ITEM_MS));
    if (!opts.ripple && delta > 0) {
      const next = itemsOnTrack(tl, item.trackId).find((i) => i.display.from >= item.display.to - 0.5 && i.id !== item.id);
      if (next) delta = Math.min(delta, next.display.from - item.display.to);
    }
    if (delta === 0) throw new OpError("TRIM_AT_LIMIT", `'${itemId}' cannot move its end that way: it is at the limit of its source media, its minimum length, or the next item on the track${opts.ripple ? "" : " (use ripple to push later items)"}.`);
    const oldEnd = item.display.to;
    item.display = { from: item.display.from, to: oldEnd + delta };
    if (media) media.trim = { from: media.trim.from, to: media.trim.to + Math.round(delta * rate) };
    if (opts.ripple) shifted = shiftFrom(tl, rippleTracks(tl, item.trackId), oldEnd, delta, [item.id]);
  } else {
    // positive: start later (shorten), negative: start earlier (lengthen)
    if (media && media.type !== "image") delta = Math.max(delta, -Math.floor(media.trim.from / rate));
    delta = Math.min(delta, len - MIN_ITEM_MS);
    if (!opts.ripple) {
      delta = Math.max(delta, -item.display.from);
      if (delta < 0) {
        const prev = [...itemsOnTrack(tl, item.trackId)].reverse().find((i) => i.display.to <= item.display.from + 0.5 && i.id !== item.id);
        if (prev) delta = Math.max(delta, prev.display.to - item.display.from);
      }
    }
    if (delta === 0) throw new OpError("TRIM_AT_LIMIT", `'${itemId}' cannot move its start that way: it is at the limit of its source media, its minimum length, or the previous item${opts.ripple ? "" : " (use ripple to keep its position and pull later items)"}.`);
    if (media) media.trim = { from: media.trim.from + Math.round(delta * rate), to: media.trim.to };
    if (opts.ripple) {
      // keep the start where it is, change the length, move everything after
      const oldEnd = item.display.to;
      item.display = { from: item.display.from, to: oldEnd - delta };
      shifted = shiftFrom(tl, rippleTracks(tl, item.trackId), oldEnd, -delta, [item.id]);
      rebaseKeyframes(item, -0);
    } else {
      item.display = { from: item.display.from + delta, to: item.display.to };
      rebaseKeyframes(item, -delta);
    }
  }
  pruneTransitions(tl);
  syncCaptions(tl);
  return { appliedDeltaMs: delta, shiftedIds: shifted };
}
function rebaseKeyframes(item: Item, deltaMs: number) {
  if (!item.keyframes || !deltaMs) return;
  for (const k of Object.keys(item.keyframes) as KeyframeProp[]) item.keyframes[k] = item.keyframes[k]!.map((f) => ({ ...f, t: f.t + deltaMs }));
}

export function splitItem(tl: TL, itemId: ID, atMs: number): { leftId: ID; rightId: ID } {
  const item = itemOf(tl, itemId);
  assertUnlocked(tl, item.trackId);
  const at = Math.round(atMs);
  if (!(at > item.display.from + MIN_ITEM_MS / 2 && at < item.display.to - MIN_ITEM_MS / 2)) {
    throw new OpError("SPLIT_OUTSIDE_ITEM", `Split was not applied: ${sec(at)}s is not inside '${itemId}', which runs ${sec(item.display.from)}s-${sec(item.display.to)}s. Split at a time between those.`);
  }
  if (item.type === "caption" && !(item as CaptionItem).manual) throw new OpError("CAPTION_LINKED", "Linked captions split with their clip.");
  const right = structuredClone(item) as Item;
  right.id = newItemId(tl, item.type);
  right.originId = item.originId ?? item.id;
  item.originId = item.originId ?? item.id;
  right.display = { from: at, to: item.display.to };
  const leftLen = at - item.display.from;
  if (isMedia(item)) {
    const cutSrc = Math.round(timelineToSource(item, at));
    (right as MediaItem).trim = { from: cutSrc, to: item.trim.to };
    item.trim = { from: item.trim.from, to: cutSrc };
    (right as MediaItem).fadeInMs = 0;
    item.fadeOutMs = 0;
  }
  if (item.keyframes) {
    for (const k of Object.keys(item.keyframes) as KeyframeProp[]) {
      const all = item.keyframes[k]!;
      const vAt = evalKeyframes(all, leftLen, undefined);
      const l = all.filter((f) => f.t < leftLen);
      const r = all.filter((f) => f.t > leftLen).map((f) => ({ ...f, t: f.t - leftLen }));
      if (vAt !== undefined && all.length) { l.push({ t: leftLen, value: vAt }); r.unshift({ t: 0, value: vAt }); }
      item.keyframes[k] = l;
      right.keyframes![k] = r;
    }
  }
  item.display = { from: item.display.from, to: at };
  tl.items[right.id] = right;
  // a transition out of the original now leaves from the right half
  for (const tr of tl.transitions) if (tr.fromItemId === item.id) tr.fromItemId = right.id;
  syncCaptions(tl);
  return { leftId: item.id, rightId: right.id };
}

export function deleteItems(tl: Timeline, ids: ID[], opts: { ripple?: boolean } = {}): { deletedIds: ID[]; shiftedIds: ID[]; alsoDeletedIds: ID[] } {
  const missing = ids.filter((id) => !tl.items[id]);
  if (missing.length) throw new OpError("ITEM_NOT_FOUND", `Delete cancelled; unknown item id(s): ${missing.join(", ")}.`);
  for (const id of ids) assertUnlocked(tl, tl.items[id]!.trackId);
  const before = new Set(Object.keys(tl.items));
  const shifted = new Set<ID>();
  // delete right-to-left so ripple offsets stay valid
  const sorted = [...ids].map((id) => tl.items[id]!).sort((a, b) => b.display.from - a.display.from);
  for (const it of sorted) {
    const { from, to } = it.display;
    const trackId = it.trackId;
    delete tl.items[it.id];
    if (opts.ripple && !(it.type === "caption")) {
      // only close the gap when nothing else on this track still covers it
      if (!collides(tl, trackId, from, to)) for (const m of shiftFrom(tl, rippleTracks(tl, trackId), to, -(to - from))) shifted.add(m);
    }
  }
  pruneTransitions(tl);
  syncCaptions(tl);
  const also = [...before].filter((id) => !ids.includes(id) && !tl.items[id]);
  return { deletedIds: ids, shiftedIds: [...shifted].filter((id) => tl.items[id]), alsoDeletedIds: also };
}

export function moveItems(tl: Timeline, ids: ID[], opts: { byMs?: number; toMs?: number; trackId?: ID }): { moved: { id: ID; trackId: ID; from: number; to: number }[] } {
  if (!ids.length) throw new OpError("MISSING_PARAM", "itemId or itemIds is required.");
  if (ids.length > 1 && opts.toMs !== undefined) throw new OpError("INVALID_COMBINATION", "Absolute 'to' is only valid for one item; use 'by' for a batch.");
  const items = ids.map((id) => itemOf(tl, id));
  const plan = items.map((it) => {
    if (it.type === "caption" && !(it as CaptionItem).manual && opts.trackId === undefined) throw new OpError("CAPTION_LINKED", `'${it.id}' is linked to a clip and follows it. Move the clip instead.`);
    const len = it.display.to - it.display.from;
    const from = Math.max(0, Math.round(opts.toMs !== undefined ? opts.toMs : it.display.from + (opts.byMs ?? 0)));
    const trackId = opts.trackId ?? it.trackId;
    const track = trackOf(tl, trackId);
    if (!trackAccepts(track, it.type)) throw new OpError("TRACK_INCOMPATIBLE", `A ${it.type} item goes on a ${trackKindFor(it.type)} track; '${trackId}' is a ${track.kind} track.`);
    assertUnlocked(tl, trackId);
    assertUnlocked(tl, it.trackId);
    return { it, from, to: from + len, trackId };
  });
  for (const p of plan) {
    const b = collides(tl, p.trackId, p.from, p.to, ids);
    if (b) throw collisionError(tl, "Move failed", p.it.id, p.trackId, p.from, p.to, b);
  }
  for (const p of plan) { p.it.display = { from: p.from, to: p.to }; p.it.trackId = p.trackId; }
  pruneTransitions(tl);
  syncCaptions(tl);
  return { moved: plan.map((p) => ({ id: p.it.id, trackId: p.trackId, from: p.from, to: p.to })) };
}

/** Reorder clips inside one track; the affected stretch of the track is re-packed without gaps. */
export function reorderItems(tl: Timeline, ids: ID[], target: { beforeId?: ID; afterId?: ID }): { order: ID[] } {
  const items = ids.map((id) => itemOf(tl, id));
  const refId = target.beforeId ?? target.afterId;
  if (!refId || (target.beforeId && target.afterId)) throw new OpError("INVALID_COMBINATION", "Provide exactly one of beforeItemId or afterItemId.");
  const ref = itemOf(tl, refId);
  if (items.some((i) => i.trackId !== ref.trackId)) throw new OpError("TRACK_MISMATCH", "Reordering works inside one track. Move items to the same track first.");
  if (ids.includes(refId)) throw new OpError("INVALID_COMBINATION", "The reference item cannot be one of the items being moved.");
  assertUnlocked(tl, ref.trackId);
  const all: Item[] = itemsOnTrack(tl, ref.trackId).filter((i) => i.type !== "caption");
  const startAt = all[0]?.display.from ?? 0;
  const rest = all.filter((i) => !ids.includes(i.id));
  const idx = rest.findIndex((i) => i.id === refId) + (target.afterId ? 1 : 0);
  const moving = ids.map((id) => tl.items[id]!);
  rest.splice(idx, 0, ...moving);
  // repack, keeping original gaps out
  let t = startAt;
  for (const it of rest) { const len = it.display.to - it.display.from; it.display = { from: t, to: t + len }; t += len; }
  pruneTransitions(tl);
  syncCaptions(tl);
  return { order: rest.map((i) => i.id) };
}

export function cloneItem(tl: TL, itemId: ID, opts: { trackId?: ID; atMs?: number } = {}): Item {
  const src = itemOf(tl, itemId);
  const trackId = opts.trackId ?? src.trackId;
  const track = trackOf(tl, trackId);
  if (!trackAccepts(track, src.type)) throw new OpError("TRACK_INCOMPATIBLE", `A ${src.type} item goes on a ${trackKindFor(src.type)} track; '${trackId}' is a ${track.kind} track.`);
  assertUnlocked(tl, trackId);
  const len = src.display.to - src.display.from;
  const from = Math.max(0, Math.round(opts.atMs ?? src.display.to));
  const b = collides(tl, trackId, from, from + len);
  if (b) throw collisionError(tl, "Clone failed", itemId, trackId, from, from + len, b);
  const copy = structuredClone(src) as Item;
  copy.id = newItemId(tl, src.type);
  copy.originId = copy.id;
  copy.trackId = trackId;
  copy.display = { from, to: from + len };
  tl.items[copy.id] = copy;
  return copy;
}

export function slipItem(tl: Timeline, itemId: ID, slipMs: number, assetDurationMs: number): { slippedMs: number } {
  const item = itemOf<MediaItem>(tl, itemId);
  if (!isMedia(item) || item.type === "image") throw new OpError("INVALID_ITEM", "Slip applies to video and audio clips.");
  assertUnlocked(tl, item.trackId);
  const d = clamp(Math.round(slipMs), -item.trim.from, assetDurationMs - item.trim.to);
  if (d === 0) throw new OpError("SLIP_AT_LIMIT", `'${itemId}' has no source media left on that side (source ${sec(assetDurationMs)}s, using ${sec(item.trim.from)}s-${sec(item.trim.to)}s).`);
  item.trim = { from: item.trim.from + d, to: item.trim.to + d };
  syncCaptions(tl);
  return { slippedMs: d };
}

export function setPlaybackRate(tl: Timeline, itemId: ID, rate: number, opts: { ripple?: boolean } = {}): { from: number; to: number; clamped: boolean } {
  const item = itemOf<MediaItem>(tl, itemId);
  if (!isMedia(item) || item.type === "image") throw new OpError("INVALID_ITEM", "Speed applies to video and audio clips.");
  if (!(rate >= 0.1 && rate <= 16)) throw new OpError("INVALID_VALUE", "playbackRate must be between 0.1 and 16.");
  assertUnlocked(tl, item.trackId);
  const srcLen = item.trim.to - item.trim.from;
  const oldEnd = item.display.to;
  let newEnd = item.display.from + Math.max(MIN_ITEM_MS, Math.round(srcLen / rate));
  let clamped = false;
  if (!opts.ripple && newEnd > oldEnd) {
    const next = itemsOnTrack(tl, item.trackId).find((i) => i.display.from >= oldEnd - 0.5 && i.id !== item.id);
    if (next && newEnd > next.display.from) { newEnd = next.display.from; clamped = true; }
  }
  item.playbackRate = rate;
  item.display = { from: item.display.from, to: newEnd };
  if (clamped) item.trim = { from: item.trim.from, to: item.trim.from + Math.round((newEnd - item.display.from) * rate) };
  if (opts.ripple) shiftFrom(tl, rippleTracks(tl, item.trackId), oldEnd, newEnd - oldEnd, [item.id]);
  syncCaptions(tl);
  return { from: item.display.from, to: item.display.to, clamped };
}

// ---------- text, shapes, motion graphics ----------
export interface AddTextInput { text: string; startMs: number; durationMs: number; trackId?: ID; style?: Partial<TextStyle>; x?: number; y?: number; role?: TextItem["role"]; animationIn?: TextAnimation; animationOut?: TextAnimation; animationMs?: number; scale?: number; rotation?: number; opacity?: number }
export function addText(tl: TL, input: AddTextInput): TextItem {
  if (!input.text?.trim()) throw new OpError("MISSING_PARAM", "textContent is required.");
  const from = Math.max(0, Math.round(input.startMs));
  const to = from + Math.max(MIN_ITEM_MS, Math.round(input.durationMs));
  const track = input.trackId ? trackOf(tl, input.trackId) : ensureTrack(tl, "overlay", { from, to });
  if (!trackAccepts(track, "text")) throw new OpError("TRACK_INCOMPATIBLE", `Text goes on an overlay track; '${track.id}' is a ${track.kind} track.`);
  assertUnlocked(tl, track.id);
  const b = collides(tl, track.id, from, to);
  if (b) throw collisionError(tl, "Add text failed", "text", track.id, from, to, b);
  const id = newItemId(tl, "text");
  const scaleFont = Math.min(tl.size.width, tl.size.height) / 1080;
  const item: TextItem = {
    id, trackId: track.id, type: "text", display: { from, to }, text: input.text, role: input.role,
    style: { ...DEFAULT_TEXT_STYLE, fontSize: Math.round(DEFAULT_TEXT_STYLE.fontSize * scaleFont), ...clean(input.style) },
    transform: { ...DEFAULT_TRANSFORM, x: input.x ?? 0, y: input.y ?? 0, scale: input.scale ?? 1, rotation: input.rotation ?? 0, opacity: input.opacity ?? 1 },
    animation: { in: input.animationIn ?? "none", out: input.animationOut ?? "none", durationMs: input.animationMs ?? 350 },
  };
  tl.items[id] = item;
  return item;
}
function clean<T extends object>(o?: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export interface AddShapeInput { shape: ShapeItem["shape"]; startMs: number; durationMs: number; width: number; height: number; fill?: string | null; strokeColor?: string | null; strokeWidth?: number; roundness?: number; x?: number; y?: number; opacity?: number; rotation?: number; trackId?: ID }
export function addShape(tl: TL, input: AddShapeInput): ShapeItem {
  const from = Math.max(0, Math.round(input.startMs));
  const to = from + Math.max(MIN_ITEM_MS, Math.round(input.durationMs));
  const track = input.trackId ? trackOf(tl, input.trackId) : ensureTrack(tl, "overlay", { from, to });
  if (!trackAccepts(track, "shape")) throw new OpError("TRACK_INCOMPATIBLE", `Shapes go on an overlay track; '${track.id}' is a ${track.kind} track.`);
  const b = collides(tl, track.id, from, to);
  if (b) throw collisionError(tl, "Add shape failed", "shape", track.id, from, to, b);
  const id = newItemId(tl, "shape");
  const item: ShapeItem = {
    id, trackId: track.id, type: "shape", display: { from, to }, shape: input.shape, width: input.width, height: input.height,
    fill: input.fill === undefined ? "#FFFFFF" : input.fill, strokeColor: input.strokeColor ?? null, strokeWidth: input.strokeWidth ?? 0, roundness: input.roundness ?? 0,
    transform: { ...DEFAULT_TRANSFORM, x: input.x ?? 0, y: input.y ?? 0, opacity: input.opacity ?? 1, rotation: input.rotation ?? 0 },
  };
  tl.items[id] = item;
  return item;
}

export function addMotionGraphic(tl: TL, input: { title: string; description?: string; layers: MGLayer[]; startMs: number; durationMs: number; trackId?: ID }): MotionGraphicItem {
  if (!Array.isArray(input.layers) || !input.layers.length) throw new OpError("MISSING_PARAM", "A motion graphic needs at least one layer.");
  const from = Math.max(0, Math.round(input.startMs));
  const to = from + Math.max(MIN_ITEM_MS, Math.round(input.durationMs));
  const track = input.trackId ? trackOf(tl, input.trackId) : ensureTrack(tl, "overlay", { from, to });
  if (!trackAccepts(track, "motionGraphic")) throw new OpError("TRACK_INCOMPATIBLE", `Motion graphics go on an overlay track; '${track.id}' is a ${track.kind} track.`);
  const b = collides(tl, track.id, from, to);
  if (b) throw collisionError(tl, "Add motion graphic failed", "motion graphic", track.id, from, to, b);
  const id = newItemId(tl, "motionGraphic");
  const item: MotionGraphicItem = { id, trackId: track.id, type: "motionGraphic", display: { from, to }, title: input.title, description: input.description ?? "", layers: input.layers.map((l, i) => ({ ...l, id: l.id || `layer_${i + 1}` })), transform: { ...DEFAULT_TRANSFORM } };
  tl.items[id] = item;
  return item;
}

// ---------- keyframes ----------
export function ease(e: string | undefined, p: number): number {
  p = clamp(p, 0, 1);
  switch (e) {
    case "ease-in": return p * p * p;
    case "ease-out": return 1 - Math.pow(1 - p, 3);
    case "ease-in-out": return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case "hold": return p >= 1 ? 1 : 0;
    case "back-out": { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
    case "spring": return 1 - Math.cos(p * Math.PI * 3.2) * Math.exp(-p * 5.5);
    default: return p;
  }
}
export function evalKeyframes(frames: Keyframe[] | undefined, tMs: number, fallback: number | undefined): number | undefined {
  if (!frames || !frames.length) return fallback;
  if (tMs <= frames[0]!.t) return frames[0]!.value;
  const last = frames[frames.length - 1]!;
  if (tMs >= last.t) return last.value;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i]!, b = frames[i + 1]!;
    if (tMs >= a.t && tMs <= b.t) {
      const p = b.t === a.t ? 1 : (tMs - a.t) / (b.t - a.t);
      return a.value + (b.value - a.value) * ease(b.easing ?? "linear", p);
    }
  }
  return last.value;
}
export function setKeyframes(tl: Timeline, itemId: ID, prop: KeyframeProp, frames: Keyframe[] | null) {
  const item = itemOf(tl, itemId);
  item.keyframes = item.keyframes ?? {};
  if (!frames || !frames.length) delete item.keyframes[prop];
  else item.keyframes[prop] = [...frames].map((f) => ({ t: Math.round(f.t), value: f.value, easing: f.easing })).sort((a, b) => a.t - b.t);
}

// ---------- transitions ----------
export function applyTransition(tl: TL, input: { fromItemId?: ID; toItemId: ID; kind: TransitionKind; durationMs?: number }): Transition {
  const to = itemOf(tl, input.toItemId);
  let from: Item | undefined = input.fromItemId ? itemOf(tl, input.fromItemId) : undefined;
  if (!from) from = [...itemsOnTrack(tl, to.trackId)].reverse().find((i) => i.display.to <= to.display.from + 1 && i.id !== to.id);
  if (!from) throw new OpError("NO_PREVIOUS_ITEM", `'${to.id}' has no item before it on its track to transition from. For a fade from black at the start use a fade-in instead.`);
  if (from.trackId !== to.trackId) throw new OpError("TRACK_MISMATCH", "A transition joins two neighbouring items on the same track.");
  if (Math.abs(from.display.to - to.display.from) > 2) throw new OpError("NOT_ADJACENT", `'${from.id}' ends at ${sec(from.display.to)}s and '${to.id}' starts at ${sec(to.display.from)}s. Close the gap first; a transition needs the two items to touch.`);
  const maxDur = Math.min(from.display.to - from.display.from, to.display.to - to.display.from) * 0.9;
  const durationMs = Math.round(clamp(input.durationMs ?? 400, 80, Math.max(80, maxDur)));
  tl.transitions = tl.transitions.filter((t) => !(t.fromItemId === from!.id && t.toItemId === to.id));
  const tr: Transition = { id: `tr_${nextSeq(tl)}`, kind: input.kind, fromItemId: from.id, toItemId: to.id, durationMs };
  tl.transitions.push(tr);
  return tr;
}
export function pruneTransitions(tl: Timeline) {
  tl.transitions = tl.transitions.filter((t) => {
    const a = tl.items[t.fromItemId], b = tl.items[t.toItemId];
    return a && b && a.trackId === b.trackId && Math.abs(a.display.to - b.display.from) <= 2;
  });
}

// ---------- captions ----------
export interface CaptionGenOptions {
  trackId?: ID;
  sourceItemIds?: ID[];
  startMs?: number;
  endMs?: number;
  mode?: CaptionStyle["mode"];
  maxWordsPerPhrase?: number;
  maxCharsPerLine?: number;
  style?: Partial<CaptionStyle>;
  emphasisWords?: string[];
  replace?: boolean;
  spellings?: Record<string, string>;
}
const normWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Words of an asset transcript that fall inside a clip's trim range. */
export function clipWords(item: MediaItem, tr: Transcription | null | undefined): { text: string; s: number; e: number }[] {
  if (!tr) return [];
  const out: { text: string; s: number; e: number }[] = [];
  for (const seg of tr.segments) {
    for (const w of seg.words ?? []) {
      const s = Math.round(w.start * 1000), e = Math.round(w.end * 1000);
      const mid = (s + e) / 2;
      if (!(mid >= item.trim.from && mid <= item.trim.to)) continue;
      const text = w.word.trim();
      const prev = out[out.length - 1];
      // the recogniser sometimes splits "80%" or "$5" into two tokens; a symbol-only token belongs to its neighbour
      if (prev && /^[%°.,!?;:)\]]+$/.test(text)) { prev.text += text; prev.e = e; continue; }
      out.push({ text, s, e });
    }
  }
  return out;
}

export function groupWords(words: { text: string; s: number; e: number }[], maxWords: number, maxChars: number, pauseMs = 550): { text: string; s: number; e: number }[][] {
  const groups: { text: string; s: number; e: number }[][] = [];
  let cur: { text: string; s: number; e: number }[] = [];
  let chars = 0;
  const flush = () => { if (cur.length) groups.push(cur); cur = []; chars = 0; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.s - prev.e;
      const endsSentence = /[.!?…]$/.test(prev.text);
      const endsClause = /[,;:]$/.test(prev.text);
      if (cur.length >= maxWords || chars + w.text.length + 1 > maxChars * 2 || gap > pauseMs || endsSentence || (endsClause && cur.length >= Math.max(2, Math.ceil(maxWords / 2)))) flush();
    }
    cur.push(w);
    chars += w.text.length + 1;
  }
  flush();
  // avoid a dangling single word after a longer phrase when it belongs to the same sentence
  for (let i = groups.length - 1; i > 0; i--) {
    const g = groups[i]!, p = groups[i - 1]!;
    if (maxWords > 2 && g.length === 1 && p.length >= 3 && g[0]!.s - p[p.length - 1]!.e < pauseMs && !/[.!?…]$/.test(p[p.length - 1]!.text)) {
      g.unshift(p.pop()!);
    }
  }
  return groups;
}

export function generateCaptions(tl: TL, assets: Record<ID, Pick<Asset, "id" | "transcription">>, opts: CaptionGenOptions = {}): { created: number; trackId: ID; sources: ID[]; skipped: { itemId: ID; reason: string }[] } {
  let track = opts.trackId ? trackOf(tl, opts.trackId) : tl.tracks.find((t) => t.kind === "caption");
  if (!track) track = addTrack(tl, "caption");
  if (track.kind !== "caption") throw new OpError("INVALID_TRACK", `'${track.id}' is a ${track.kind} track. Captions go on a caption track.`);
  const style: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...(track.captionStyle ?? {}), ...clean(opts.style) };
  if (opts.mode) style.mode = opts.mode;
  if (opts.maxWordsPerPhrase) style.maxWordsPerPhrase = opts.maxWordsPerPhrase;
  if (opts.maxCharsPerLine) style.maxCharsPerLine = opts.maxCharsPerLine;
  if (style.mode === "word") style.maxWordsPerPhrase = 1;
  track.captionStyle = style;

  const speechItems = Object.values(tl.items).filter((i): i is MediaItem => (i.type === "video" || i.type === "audio") && (!opts.sourceItemIds || opts.sourceItemIds.includes(i.id)));
  const skipped: { itemId: ID; reason: string }[] = [];
  const sources: ID[] = [];
  const emph = new Set((opts.emphasisWords ?? []).flatMap((p) => p.split(/\s+/)).map(normWord).filter(Boolean));
  const emphPhrases = (opts.emphasisWords ?? []).map((p) => p.split(/\s+/).map(normWord).filter(Boolean)).filter((p) => p.length > 1);
  const spell = new Map(Object.entries(opts.spellings ?? {}).map(([k, v]) => [normWord(k), v]));
  let created = 0;
  for (const item of speechItems.sort((a, b) => a.display.from - b.display.from)) {
    const tOk = (opts.startMs === undefined || item.display.to > opts.startMs) && (opts.endMs === undefined || item.display.from < opts.endMs);
    if (!tOk) continue;
    const src = trackOf(tl, item.trackId);
    if (item.muted || item.volume <= 0 || src.muted) { if (opts.sourceItemIds) skipped.push({ itemId: item.id, reason: "muted, so it is not heard in the edit" }); continue; }
    const tr = assets[item.assetId]?.transcription;
    let words = clipWords(item, tr);
    if (!words.length) { if (opts.sourceItemIds) skipped.push({ itemId: item.id, reason: "no speech found in this range" }); continue; }
    if (opts.startMs !== undefined || opts.endMs !== undefined) {
      words = words.filter((w) => { const t = sourceToTimeline(item, (w.s + w.e) / 2); return (opts.startMs === undefined || t >= opts.startMs) && (opts.endMs === undefined || t <= opts.endMs); });
    }
    if (opts.replace !== false) {
      for (const c of Object.values(tl.items)) {
        if (c.type !== "caption" || c.trackId !== track.id) continue;
        const cc = c as CaptionItem;
        if (cc.linkedItemId !== item.id || cc.manual) continue;
        if (opts.startMs !== undefined || opts.endMs !== undefined) {
          const mid = (c.display.from + c.display.to) / 2;
          if ((opts.startMs !== undefined && mid < opts.startMs) || (opts.endMs !== undefined && mid > opts.endMs)) continue;
        }
        delete tl.items[c.id];
      }
    }
    const groups = groupWords(words, style.maxWordsPerPhrase, style.maxCharsPerLine);
    for (const g of groups) {
      const id = newItemId(tl, "caption");
      const cw: CaptionWord[] = g.map((w) => {
        const n = normWord(w.text);
        const fixed = spell.get(n);
        return { text: fixed ? w.text.replace(/[\p{L}\p{N}']+/u, fixed) : w.text, s: w.s, e: w.e, ...(emph.has(n) && emphPhrases.length === 0 ? { emphasis: true } : {}) };
      });
      tl.items[id] = { id, trackId: track.id, type: "caption", display: { from: 0, to: 0 }, linkedItemId: item.id, words: cw } as CaptionItem;
      created++;
    }
    sources.push(item.id);
  }
  // multi-word emphasis phrases and single words
  if (emph.size) markEmphasis(tl, track.id, opts.emphasisWords ?? []);
  syncCaptions(tl);
  return { created, trackId: track.id, sources, skipped };
}

export function markEmphasis(tl: Timeline, trackId: ID, phrases: string[], on = true): number {
  const caps = itemsOnTrack(tl, trackId).filter((i) => i.type === "caption") as CaptionItem[];
  const flat: { cap: CaptionItem; idx: number; n: string }[] = [];
  for (const c of caps) c.words.forEach((w, idx) => flat.push({ cap: c, idx, n: normWord(w.text) }));
  let hits = 0;
  for (const p of phrases) {
    const parts = p.split(/\s+/).map(normWord).filter(Boolean);
    if (!parts.length) continue;
    for (let i = 0; i + parts.length <= flat.length; i++) {
      if (parts.every((x, k) => flat[i + k]!.n === x)) {
        for (let k = 0; k < parts.length; k++) { const f = flat[i + k]!; f.cap.words[f.idx]!.emphasis = on || undefined; }
        hits++;
      }
    }
  }
  return hits;
}

/** Recompute every linked caption's timeline position from its clip. Captions whose words fell out of the clip are trimmed or removed. */
export function syncCaptions(tl: Timeline) {
  const clips = Object.values(tl.items).filter(isMedia);
  for (const c of Object.values(tl.items)) {
    if (c.type !== "caption") continue;
    const cap = c as CaptionItem;
    if (cap.manual) continue;
    let clip = tl.items[cap.linkedItemId] as MediaItem | undefined;
    const mid = cap.words.length ? (cap.words[0]!.s + cap.words[cap.words.length - 1]!.e) / 2 : 0;
    const covers = (m: MediaItem) => mid >= m.trim.from - 1 && mid <= m.trim.to + 1;
    if (!clip || !isMedia(clip) || !covers(clip)) {
      // the clip was split or replaced: look for a sibling from the same origin that now holds these words
      const origin = clip?.originId ?? cap.linkedItemId;
      const assetId = clip?.assetId;
      const sib = clips.find((m) => (m.originId === origin || m.id === origin) && (!assetId || m.assetId === assetId) && covers(m));
      if (sib) { cap.linkedItemId = sib.id; clip = sib; }
      else if (!clip || !isMedia(clip)) { delete tl.items[cap.id]; continue; }
    }
    const inside = cap.words.filter((w) => { const m = (w.s + w.e) / 2; return m >= clip!.trim.from - 1 && m <= clip!.trim.to + 1; });
    if (!inside.length) { delete tl.items[cap.id]; continue; }
    cap.words = inside;
    const from = Math.max(clip.display.from, sourceToTimeline(clip, inside[0]!.s));
    const to = Math.min(clip.display.to, sourceToTimeline(clip, inside[inside.length - 1]!.e));
    cap.display = { from: Math.round(from), to: Math.round(Math.max(from + MIN_ITEM_MS, to)) };
  }
  // Hold each caption until the next one starts (up to a limit) so text does not flicker between words.
  for (const t of tl.tracks) {
    if (t.kind !== "caption") continue;
    const caps = itemsOnTrack(tl, t.id).filter((i) => i.type === "caption");
    for (let i = 0; i < caps.length; i++) {
      const cur = caps[i]!, next = caps[i + 1];
      const clip = tl.items[(cur as CaptionItem).linkedItemId];
      let limit = clip ? clip.display.to : cur.display.to;
      if (next) limit = Math.min(limit, next.display.from);
      if ((cur as CaptionItem).manual) continue;
      const hold = Math.min(limit, cur.display.to + 400);
      if (next && next.display.from < cur.display.to) cur.display = { from: cur.display.from, to: Math.max(cur.display.from + MIN_ITEM_MS, next.display.from) };
      else if (hold > cur.display.to) cur.display = { from: cur.display.from, to: hold };
    }
  }
}

export function captionText(cap: CaptionItem, style?: Pick<CaptionStyle, "textTransform">): string {
  const t = cap.words.map((w) => w.text).join(" ");
  return style?.textTransform === "uppercase" ? t.toUpperCase() : style?.textTransform === "lowercase" ? t.toLowerCase() : t;
}

// ---------- transcript-driven cleanup ----------
export interface CleanupOptions { minPauseMs: number; paddingMs?: number; removeFillers?: boolean; removeRestarts?: boolean; trimEdges?: boolean; protectRanges?: { from: number; to: number }[] }
export interface CutRecord { itemId: ID; fromSeconds: number; toSeconds: number; durationSeconds: number; reason: "pause" | "filler" | "restart" | "leading-silence" | "trailing-silence"; text?: string }

/** Source ranges (ms) of a clip worth keeping, from word timings. */
export function keepRanges(item: MediaItem, tr: Transcription | null | undefined, o: CleanupOptions): { keep: { from: number; to: number }[]; cuts: { from: number; to: number; reason: CutRecord["reason"]; text?: string }[] } {
  const pad = o.paddingMs ?? 90;
  const all = clipWords(item, tr);
  if (!all.length) return { keep: [{ ...item.trim }], cuts: [] };
  const drop = new Set<number>();
  const reasons = new Map<number, CutRecord["reason"]>();
  if (o.removeFillers) all.forEach((w, i) => { if (FILLER_WORDS.has(normWord(w.text))) { drop.add(i); reasons.set(i, "filler"); } });
  if (o.removeRestarts) {
    // a restart: the same 2-4 word opening said twice within a short span; keep the later attempt
    for (let i = 0; i < all.length; i++) {
      if (drop.has(i)) continue;
      for (const n of [4, 3, 2]) {
        if (i + n * 2 > all.length) continue;
        const a = all.slice(i, i + n).map((w) => normWord(w.text)).join(" ");
        if (a.replace(/ /g, "").length < 5) continue;
        for (let j = i + n; j <= Math.min(i + n + 6, all.length - n); j++) {
          const b = all.slice(j, j + n).map((w) => normWord(w.text)).join(" ");
          if (a === b && all[j]!.s - all[i]!.s < 9000) {
            for (let k = i; k < j; k++) { if (!drop.has(k)) { drop.add(k); reasons.set(k, "restart"); } }
            break;
          }
        }
        if (drop.has(i)) break;
      }
    }
  }
  const kept = all.map((w, i) => ({ ...w, i })).filter((w) => !drop.has(w.i));
  const cuts: { from: number; to: number; reason: CutRecord["reason"]; text?: string }[] = [];
  if (!kept.length) return { keep: [], cuts: [{ from: item.trim.from, to: item.trim.to, reason: "filler" }] };
  const keep: { from: number; to: number }[] = [];
  const isProtected = (a: number, b: number) => (o.protectRanges ?? []).some((r) => a < r.to && b > r.from);
  const startEdge = o.trimEdges === false ? item.trim.from : Math.max(item.trim.from, kept[0]!.s - Math.max(pad, 120));
  let curFrom = startEdge;
  if (startEdge - item.trim.from > 250) cuts.push({ from: item.trim.from, to: startEdge, reason: "leading-silence" });
  else curFrom = item.trim.from;
  for (let k = 0; k < kept.length - 1; k++) {
    const a = kept[k]!, b = kept[k + 1]!;
    const gap = b.s - a.e;
    const skippedWords = b.i - a.i > 1;
    if ((gap > o.minPauseMs || skippedWords) && !isProtected(a.e, b.s)) {
      const cutFrom = Math.min(a.e + pad, b.s);
      const cutTo = Math.max(b.s - pad, cutFrom);
      if (cutTo - cutFrom >= 60) {
        keep.push({ from: curFrom, to: cutFrom });
        const dropped = all.slice(a.i + 1, b.i);
        const reason = skippedWords ? reasons.get(a.i + 1) ?? "filler" : "pause";
        cuts.push({ from: cutFrom, to: cutTo, reason, text: dropped.length ? dropped.map((w) => w.text).join(" ") : undefined });
        curFrom = cutTo;
      }
    }
  }
  const last = kept[kept.length - 1]!;
  const endEdge = o.trimEdges === false ? item.trim.to : Math.min(item.trim.to, last.e + Math.max(pad, 160));
  if (item.trim.to - endEdge > 250) { keep.push({ from: curFrom, to: endEdge }); cuts.push({ from: endEdge, to: item.trim.to, reason: "trailing-silence" }); }
  else keep.push({ from: curFrom, to: item.trim.to });
  return { keep: keep.filter((r) => r.to - r.from >= MIN_ITEM_MS), cuts };
}

/** Remove pauses / fillers / restarts from speech clips by cutting them into kept ranges and closing the gaps. */
export function cutDeadSpace(tl: TL, assets: Record<ID, Pick<Asset, "id" | "transcription">>, itemIds: ID[] | undefined, o: CleanupOptions): { cuts: CutRecord[]; removedSeconds: number; itemsAfter: ID[] } {
  const targets = (itemIds ? itemIds.map((id) => itemOf<MediaItem>(tl, id)) : Object.values(tl.items).filter((i): i is MediaItem => i.type === "video" || i.type === "audio"))
    .filter((i) => isMedia(i) && i.type !== "image" && assets[i.assetId]?.transcription?.segments?.length)
    .sort((a, b) => b.display.from - a.display.from); // right to left so earlier positions stay valid
  const records: CutRecord[] = [];
  const itemsAfter: ID[] = [];
  let removed = 0;
  for (const item of targets) {
    assertUnlocked(tl, item.trackId);
    const { keep, cuts } = keepRanges(item, assets[item.assetId]!.transcription, o);
    if (!cuts.length) { itemsAfter.push(item.id); continue; }
    for (const c of cuts) records.push({ itemId: item.id, fromSeconds: sec(sourceToTimeline(item, c.from)), toSeconds: sec(sourceToTimeline(item, c.to)), durationSeconds: sec((c.to - c.from) / item.playbackRate), reason: c.reason, text: c.text });
    const oldLen = item.display.to - item.display.from;
    const tracks = rippleTracks(tl, item.trackId);
    const start = item.display.from;
    const oldEnd = item.display.to;
    const base = structuredClone(item);
    delete tl.items[item.id];
    let t = start;
    const ids: ID[] = [];
    keep.forEach((r, idx) => {
      const piece = structuredClone(base) as MediaItem;
      piece.id = idx === 0 ? base.id : newItemId(tl, base.type);
      piece.originId = base.originId ?? base.id;
      piece.trim = { from: r.from, to: r.to };
      const len = Math.round((r.to - r.from) / base.playbackRate);
      piece.display = { from: t, to: t + len };
      piece.fadeInMs = idx === 0 ? base.fadeInMs : 0;
      piece.fadeOutMs = idx === keep.length - 1 ? base.fadeOutMs : 0;
      delete piece.keyframes;
      tl.items[piece.id] = piece;
      ids.push(piece.id);
      t += len;
    });
    const newLen = t - start;
    removed += oldLen - newLen;
    shiftFrom(tl, tracks, oldEnd, newLen - oldLen, ids);
    itemsAfter.push(...ids);
  }
  pruneTransitions(tl);
  syncCaptions(tl);
  records.sort((a, b) => a.fromSeconds - b.fromSeconds);
  return { cuts: records, removedSeconds: sec(removed), itemsAfter };
}

/** Find a spoken phrase inside an asset transcript; returns the source range that covers it. */
export function findTranscriptRange(tr: Transcription | null | undefined, q: { from?: string; to?: string; text?: string; occurrence?: number }): { ok: true; startMs: number; endMs: number; wordCount: number; matchedText: string } | { ok: false; code: string; message: string; candidates?: string[] } {
  if (!tr?.segments?.length) return { ok: false, code: "NO_TRANSCRIPT", message: "This asset has no transcript." };
  const words = tr.segments.flatMap((s) => s.words ?? []);
  const norm = words.map((w) => normWord(w.word));
  const find = (phrase: string, startAt = 0, nth = 1): number[] => {
    const parts = phrase.split(/\s+/).map(normWord).filter(Boolean);
    const hits: number[] = [];
    if (!parts.length) return hits;
    for (let i = startAt; i + parts.length <= norm.length; i++) if (parts.every((p, k) => norm[i + k] === p)) hits.push(i);
    return nth > 0 ? hits : hits;
  };
  const near = (phrase: string): string[] => {
    const first = normWord(phrase.split(/\s+/)[0] ?? "");
    const out: string[] = [];
    norm.forEach((n, i) => { if (n === first && out.length < 5) out.push(words.slice(i, i + 8).map((w) => w.word.trim()).join(" ")); });
    return out;
  };
  let a: number, b: number;
  if (q.text) {
    const hits = find(q.text);
    if (!hits.length) return { ok: false, code: "PHRASE_NOT_FOUND", message: `"${q.text}" was not found in the transcript. Quote the words exactly as transcribed.`, candidates: near(q.text) };
    a = hits[Math.min(hits.length, q.occurrence ?? 1) - 1]!;
    b = a + q.text.split(/\s+/).map(normWord).filter(Boolean).length - 1;
  } else {
    if (!q.from || !q.to) return { ok: false, code: "MISSING_PARAM", message: "transcriptRange needs either 'text' or both 'from' and 'to'." };
    const fh = find(q.from);
    if (!fh.length) return { ok: false, code: "PHRASE_NOT_FOUND", message: `Start phrase "${q.from}" was not found in the transcript.`, candidates: near(q.from) };
    a = fh[Math.min(fh.length, q.occurrence ?? 1) - 1]!;
    const th = find(q.to, a);
    if (!th.length) return { ok: false, code: "PHRASE_NOT_FOUND", message: `End phrase "${q.to}" was not found after "${q.from}".`, candidates: near(q.to) };
    b = th[0]! + q.to.split(/\s+/).map(normWord).filter(Boolean).length - 1;
  }
  const startMs = Math.max(0, Math.round(words[a]!.start * 1000) - 80);
  const endMs = Math.round(words[b]!.end * 1000) + 140;
  return { ok: true, startMs, endMs, wordCount: b - a + 1, matchedText: words.slice(a, b + 1).map((w) => w.word.trim()).join(" ") };
}

// ---------- audio ----------
/** Timeline ranges (ms) where someone is speaking, from the transcripts of audible clips. */
export function speechRanges(tl: Timeline, assets: Record<ID, Pick<Asset, "id" | "transcription">>, opts: { exclude?: ID[]; mergeGapMs?: number } = {}): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (const it of Object.values(tl.items)) {
    if (!(it.type === "video" || it.type === "audio")) continue;
    const m = it as MediaItem;
    if (opts.exclude?.includes(m.id) || m.muted || m.volume <= 0) continue;
    const tr = trackOf(tl, m.trackId);
    if (tr.muted) continue;
    const words = clipWords(m, assets[m.assetId]?.transcription);
    for (const w of words) ranges.push({ from: Math.max(m.display.from, sourceToTimeline(m, w.s)), to: Math.min(m.display.to, sourceToTimeline(m, w.e)) });
  }
  ranges.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  const gap = opts.mergeGapMs ?? 600;
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.from - last.to <= gap) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.to - r.from > 80);
}

/** Write volume keyframes on a music item so it dips while people speak. */
export function duckUnderSpeech(tl: Timeline, assets: Record<ID, Pick<Asset, "id" | "transcription">>, itemId: ID, opts: { baseVolume: number; duckedVolume: number; fadeMs?: number }): { dips: number } {
  const item = itemOf<MediaItem>(tl, itemId);
  if (!(item.type === "audio" || item.type === "video")) throw new OpError("INVALID_ITEM", "Ducking applies to audio or video clips.");
  const fade = opts.fadeMs ?? 280;
  const ranges = speechRanges(tl, assets, { exclude: [itemId] }).filter((r) => r.to > item.display.from && r.from < item.display.to);
  const frames: Keyframe[] = [];
  const len = item.display.to - item.display.from;
  const push = (t: number, v: number) => { const tt = clamp(Math.round(t), 0, len); const last = frames[frames.length - 1]; if (last && tt <= last.t) { if (tt === last.t) last.value = Math.min(last.value, v); return; } frames.push({ t: tt, value: v, easing: "ease-in-out" }); };
  item.volume = opts.baseVolume;
  if (!ranges.length) { setKeyframes(tl, itemId, "volume", null); return { dips: 0 }; }
  push(0, ranges[0]!.from - item.display.from <= fade ? opts.duckedVolume : opts.baseVolume);
  for (const r of ranges) {
    const a = r.from - item.display.from, b = r.to - item.display.from;
    push(a - fade, opts.baseVolume);
    push(a, opts.duckedVolume);
    push(b, opts.duckedVolume);
    push(b + fade, opts.baseVolume);
  }
  setKeyframes(tl, itemId, "volume", frames);
  return { dips: ranges.length };
}

// ---------- beat sync ----------
export interface BeatSlot { index: number; fromMs: number; toMs: number }
/** Cut points on the music's beat grid, in timeline ms, from `startMs` for `lengthMs`. `pattern` maps a time (ms from start) to "every N beats". */
export function beatSlots(beatsMs: number[], startMs: number, endMs: number, everyAt: (tFromStartMs: number, beatIndex: number) => number, minSlotMs = 180): BeatSlot[] {
  const beats = beatsMs.filter((b) => b >= startMs - 5 && b <= endMs + 5);
  const slots: BeatSlot[] = [];
  if (beats.length < 2) return slots;
  let i = 0;
  let idx = 0;
  while (i < beats.length - 1) {
    const n = Math.max(1, Math.round(everyAt(beats[i]! - startMs, i)));
    const j = Math.min(beats.length - 1, i + n);
    const from = Math.round(beats[i]!), to = Math.round(beats[j]!);
    if (to - from >= minSlotMs) slots.push({ index: idx++, fromMs: from, toMs: to });
    i = j;
  }
  return slots;
}

// ---------- canvas ----------
export function resizeCanvas(tl: Timeline, width: number, height: number): { from: string; to: string } {
  width = Math.round(width / 2) * 2; height = Math.round(height / 2) * 2;
  if (!(width >= 320 && width <= 3840 && height >= 320 && height <= 3840)) throw new OpError("INVALID_SIZE", "Canvas sides must be even numbers from 320 to 3840.");
  const old = { ...tl.size };
  const sx = width / old.width, sy = height / old.height;
  const s = Math.min(width, height) / Math.min(old.width, old.height);
  for (const it of Object.values(tl.items)) {
    if ("transform" in it && it.transform) { it.transform.x = Math.round(it.transform.x * sx); it.transform.y = Math.round(it.transform.y * sy); }
    if (it.type === "text") it.style.fontSize = Math.round(it.style.fontSize * s);
    if (it.type === "shape") { it.width = Math.round(it.width * s); it.height = Math.round(it.height * s); }
    if (it.keyframes?.x) it.keyframes.x = it.keyframes.x.map((f) => ({ ...f, value: f.value * sx }));
    if (it.keyframes?.y) it.keyframes.y = it.keyframes.y.map((f) => ({ ...f, value: f.value * sy }));
  }
  for (const t of tl.tracks) if (t.captionStyle) t.captionStyle.fontSize = Math.round(t.captionStyle.fontSize * s);
  tl.size = { width, height };
  return { from: `${old.width}x${old.height}`, to: `${width}x${height}` };
}

// ---------- effects ----------
export function writeEffects(tl: Timeline, ids: ID[], patch: { set?: Effect[]; remove?: string[]; clear?: boolean }): { itemId: ID; effects: Effect[] }[] {
  const out: { itemId: ID; effects: Effect[] }[] = [];
  for (const id of ids) {
    const it = itemOf<MediaItem>(tl, id);
    if (!(it.type === "video" || it.type === "image")) throw new OpError("EFFECT_UNSUPPORTED_ITEM", `Effects go on video and image clips; '${id}' is a ${it.type} item.`);
    let fx = patch.clear ? [] : [...(it.effects ?? [])];
    for (const r of patch.remove ?? []) fx = fx.filter((e) => e.id !== r);
    for (const e of patch.set ?? []) { fx = fx.filter((x) => x.id !== e.id); fx.push({ id: e.id, value: e.value }); }
    it.effects = fx;
    out.push({ itemId: id, effects: fx });
  }
  return out;
}

// ---------- summaries for the agent ----------
export function describeItem(tl: Timeline, it: Item, assets: Record<ID, { agentId?: string; name?: string }>): Record<string, unknown> {
  const base: Record<string, unknown> = { id: it.id, type: it.type, track: it.trackId, from: sec(it.display.from), to: sec(it.display.to), duration: sec(it.display.to - it.display.from) };
  if (isMedia(it)) {
    base.asset = assets[it.assetId]?.agentId ?? it.assetId;
    base.name = assets[it.assetId]?.name ?? it.name;
    if (it.type !== "image") { base.sourceIn = sec(it.trim.from); base.sourceOut = sec(it.trim.to); }
    if (it.playbackRate !== 1) base.speed = it.playbackRate;
    if (it.type !== "image") { if (it.muted) base.muted = true; else if (it.volume !== 1) base.volume = it.volume; }
    if (it.keyframes?.volume?.length) base.volumeKeyframes = it.keyframes.volume.length;
    if (it.transform.scale !== 1 || it.transform.x || it.transform.y) base.transform = { scale: it.transform.scale, x: it.transform.x, y: it.transform.y };
    if (it.transform.fit !== "cover") base.fit = it.transform.fit;
    if (it.effects?.length) base.effects = it.effects.map((e) => `${e.id}:${e.value}`).join(", ");
    if (it.filter) base.filter = `${it.filter.id}@${it.filter.strength}`;
    if (it.fadeInMs) base.fadeIn = sec(it.fadeInMs);
    if (it.fadeOutMs) base.fadeOut = sec(it.fadeOutMs);
  } else if (it.type === "text") {
    base.text = it.text; base.font = `${it.style.fontFamily} ${it.style.fontWeight} ${it.style.fontSize}px`; base.color = it.style.color; base.position = { x: it.transform.x, y: it.transform.y };
    if (it.role) base.role = it.role;
  } else if (it.type === "caption") {
    base.text = captionText(it); base.linkedTo = it.linkedItemId;
    if (it.words.some((w) => w.emphasis)) base.emphasis = it.words.filter((w) => w.emphasis).map((w) => w.text).join(" ");
  } else if (it.type === "shape") {
    base.shape = it.shape; base.size = `${it.width}x${it.height}`; base.fill = it.fill;
  } else if (it.type === "motionGraphic") {
    base.title = it.title; base.layers = it.layers.length;
  }
  return base;
}

export function timelineOverview(tl: Timeline, assets: Record<ID, { agentId?: string; name?: string }>, range?: { startMs?: number; endMs?: number }, types?: string[]): Record<string, unknown> {
  const inRange = (it: Item) => (range?.startMs === undefined || it.display.to > range.startMs) && (range?.endMs === undefined || it.display.from < range.endMs) && (!types || types.includes(it.type));
  const tracks = tl.tracks.map((t, idx) => {
    const items = itemsOnTrack(tl, t.id).filter(inRange);
    const out: Record<string, unknown> = { id: t.id, kind: t.kind, layer: tl.tracks.length - idx, ...(t.muted ? { muted: true } : {}), ...(t.hidden ? { hidden: true } : {}), ...(t.locked ? { locked: true } : {}) };
    if (t.kind === "caption") {
      const caps = items as CaptionItem[];
      out.captionCount = caps.length;
      if (t.captionStyle && caps.length) out.captionStyle = { mode: t.captionStyle.mode, font: `${t.captionStyle.fontFamily} ${t.captionStyle.fontWeight} ${t.captionStyle.fontSize}px`, color: t.captionStyle.color, position: t.captionStyle.position, textTransform: t.captionStyle.textTransform };
      // captions are many; show a compact list
      out.items = caps.length > 40 && !range ? [...caps.slice(0, 12), ...caps.slice(-6)].map((c) => `${c.id} ${sec(c.display.from)}-${sec(c.display.to)} "${captionText(c)}"`).concat([`(${caps.length - 18} more; pass startSeconds/endSeconds to list a range)`]) : caps.map((c) => `${c.id} ${sec(c.display.from)}-${sec(c.display.to)} "${captionText(c)}"${c.words.some((w) => w.emphasis) ? " [emphasis]" : ""}`);
    } else out.items = items.map((i) => describeItem(tl, i, assets));
    return out;
  });
  return {
    canvas: `${tl.size.width}x${tl.size.height}`, fps: tl.fps, durationSeconds: sec(timelineDuration(tl)), version: tl.version,
    tracks,
    ...(tl.transitions.length ? { transitions: tl.transitions.map((t) => ({ id: t.id, kind: t.kind, from: t.fromItemId, to: t.toItemId, seconds: sec(t.durationMs) })) } : {}),
    ...(tl.markers.length ? { markers: tl.markers.map((m) => ({ id: m.id, at: sec(m.timeMs), label: m.label })) } : {}),
  };
}

/** Structural checks used after every agent edit and in tests. */
export function validateTimeline(tl: Timeline): string[] {
  const problems: string[] = [];
  for (const it of Object.values(tl.items)) {
    const t = tl.tracks.find((x) => x.id === it.trackId);
    if (!t) { problems.push(`${it.id}: track ${it.trackId} missing`); continue; }
    if (!trackAccepts(t, it.type)) problems.push(`${it.id}: ${it.type} on ${t.kind} track`);
    if (!(it.display.to > it.display.from)) problems.push(`${it.id}: empty or negative duration`);
    if (it.display.from < 0) problems.push(`${it.id}: starts before 0`);
    if (isMedia(it) && it.type !== "image") {
      const expect = (it.trim.to - it.trim.from) / it.playbackRate;
      if (Math.abs(expect - (it.display.to - it.display.from)) > 3) problems.push(`${it.id}: display length ${it.display.to - it.display.from} does not match source range ${Math.round(expect)}`);
    }
  }
  for (const t of tl.tracks) {
    if (t.kind === "caption") continue;
    const items = itemsOnTrack(tl, t.id);
    for (let i = 1; i < items.length; i++) if (items[i]!.display.from < items[i - 1]!.display.to - 1) problems.push(`${items[i - 1]!.id} overlaps ${items[i]!.id} on ${t.id}`);
  }
  return problems;
}
