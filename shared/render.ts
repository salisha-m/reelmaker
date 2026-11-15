// One compositor for preview and export. It only talks to a Canvas 2D context, so the
// browser canvas and the server (Skia) canvas draw the same frame from the same code.
import type { CaptionItem, CaptionStyle, Effect, Item, MediaItem, MGLayer, MotionGraphicItem, ShapeItem, TextItem, TextStyle, Timeline, Transform, Transition } from "./types.ts";
import { DEFAULT_CAPTION_STYLE, DEFAULT_TEXT_STYLE, FILTERS, fontKey } from "./catalog.ts";
import { ease, evalKeyframes, isMedia, itemsOnTrack, timelineToSource } from "./timeline.ts";

type Ctx = CanvasRenderingContext2D;
export interface FrameSource { image: unknown; width: number; height: number }
export interface RenderResources {
  /** A drawable for a media item at a source time (ms). Returns null while the frame is not available. */
  getFrame(item: MediaItem, sourceMs: number): FrameSource | null;
  /** Offscreen canvas of the given size, reused between calls. */
  scratch(width: number, height: number, slot: number): { canvas: unknown; ctx: Ctx };
  /** Image for a motion-graphic image layer. */
  getImage?(assetId: string): FrameSource | null;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ---------- per-item animated values ----------
export function animatedTransform(item: Item & { transform: Transform }, tMs: number): Transform {
  const local = tMs - item.display.from;
  const k = item.keyframes;
  const tr = item.transform;
  if (!k) return tr;
  return {
    ...tr,
    x: evalKeyframes(k.x, local, tr.x)!,
    y: evalKeyframes(k.y, local, tr.y)!,
    scale: evalKeyframes(k.scale, local, tr.scale)!,
    rotation: evalKeyframes(k.rotation, local, tr.rotation)!,
    opacity: evalKeyframes(k.opacity, local, tr.opacity)!,
  };
}
/** Linear gain of a media item at a timeline time, including fades, keyframes, mute and track gain. */
export function itemGainAt(tl: Timeline, item: MediaItem, tMs: number): number {
  const track = tl.tracks.find((t) => t.id === item.trackId);
  if (!track || track.muted || item.muted) return 0;
  const local = tMs - item.display.from;
  const len = item.display.to - item.display.from;
  let g = evalKeyframes(item.keyframes?.volume, local, item.volume) ?? item.volume;
  if (item.fadeInMs > 0 && local < item.fadeInMs) g *= clamp(local / item.fadeInMs, 0, 1);
  if (item.fadeOutMs > 0 && local > len - item.fadeOutMs) g *= clamp((len - local) / item.fadeOutMs, 0, 1);
  return Math.max(0, g * (track.gain ?? 1));
}

// ---------- effects ----------
export function resolvedEffects(item: MediaItem): Effect[] {
  const acc = new Map<string, number>();
  if (item.filter) {
    const f = FILTERS.find((x) => x.id === item.filter!.id);
    if (f) for (const e of f.effects) acc.set(e.id, (acc.get(e.id) ?? 0) + (e.value * clamp(item.filter!.strength, 0, 100)) / 100);
  }
  for (const e of item.effects ?? []) acc.set(e.id, (acc.get(e.id) ?? 0) + e.value);
  return [...acc.entries()].map(([id, value]) => ({ id, value }));
}
export function cssFilter(effects: Effect[], canvasShortSide: number, extraBlurPx = 0): string {
  const parts: string[] = [];
  let blur = extraBlurPx;
  for (const e of effects) {
    if (e.id === "brightness" && e.value) parts.push(`brightness(${(1 + e.value / 100).toFixed(3)})`);
    else if (e.id === "contrast" && e.value) parts.push(`contrast(${(1 + e.value / 100).toFixed(3)})`);
    else if (e.id === "saturation" && e.value) parts.push(`saturate(${Math.max(0, 1 + e.value / 100).toFixed(3)})`);
    else if (e.id === "grayscale" && e.value) parts.push(`grayscale(${clamp(e.value / 100, 0, 1).toFixed(3)})`);
    else if (e.id === "sepia" && e.value) parts.push(`sepia(${clamp(e.value / 100, 0, 1).toFixed(3)})`);
    else if (e.id === "hue" && e.value) parts.push(`hue-rotate(${Math.round(e.value)}deg)`);
    else if (e.id === "blur" && e.value) blur += (e.value * canvasShortSide) / 1080;
  }
  if (blur > 0.05) parts.push(`blur(${blur.toFixed(2)}px)`);
  return parts.length ? parts.join(" ") : "none";
}
const OVERLAY_EFFECTS = new Set(["temperature", "tint", "vignette", "fade"]);

// ---------- geometry ----------
export interface Box { cx: number; cy: number; w: number; h: number; rotation: number }
export function mediaBox(tl: Timeline, tr: Transform, srcW: number, srcH: number): Box & { crop: { sx: number; sy: number; sw: number; sh: number } } {
  const { width: W, height: H } = tl.size;
  const c = tr.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const sx = srcW * c.left, sy = srcH * c.top;
  const sw = Math.max(1, srcW * (1 - c.left - c.right)), sh = Math.max(1, srcH * (1 - c.top - c.bottom));
  const base = tr.fit === "contain" ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  return { cx: W / 2 + tr.x, cy: H / 2 + tr.y, w: sw * base * tr.scale, h: sh * base * tr.scale, rotation: tr.rotation, crop: { sx, sy, sw, sh } };
}

// ---------- transitions ----------
interface Mod { opacity: number; dx: number; dy: number; scale: number; blur: number; clip: null | { x: number; y: number; w: number; h: number }; wash: null | { color: string; alpha: number } }
const NO_MOD: Mod = { opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null, wash: null };
function transitionMods(tl: Timeline, tr: Transition, p: number): { a: Mod; b: Mod } {
  const { width: W, height: H } = tl.size;
  const e = ease("ease-in-out", p);
  const a: Mod = { ...NO_MOD }, b: Mod = { ...NO_MOD };
  switch (tr.kind) {
    case "crossfade": b.opacity = e; break;
    case "fade-black": case "fade-white": {
      const color = tr.kind === "fade-black" ? "#000000" : "#FFFFFF";
      if (p < 0.5) { b.opacity = 0; a.wash = { color, alpha: ease("ease-in", p * 2) }; }
      else { a.opacity = 0; b.wash = { color, alpha: 1 - ease("ease-out", (p - 0.5) * 2) }; }
      break;
    }
    case "slide-left": a.dx = -W * e; b.dx = W * (1 - e); break;
    case "slide-right": a.dx = W * e; b.dx = -W * (1 - e); break;
    case "slide-up": a.dy = -H * e; b.dy = H * (1 - e); break;
    case "slide-down": a.dy = H * e; b.dy = -H * (1 - e); break;
    case "wipe-left": b.clip = { x: W * (1 - e), y: 0, w: W * e, h: H }; break;
    case "wipe-right": b.clip = { x: 0, y: 0, w: W * e, h: H }; break;
    case "zoom-in": a.scale = 1 + 0.35 * e; a.opacity = 1; b.opacity = e; b.scale = 0.85 + 0.15 * e; break;
    case "zoom-out": a.scale = 1 - 0.2 * e; b.opacity = e; b.scale = 1.25 - 0.25 * e; break;
    case "blur": a.blur = 24 * e; b.opacity = e; b.blur = 24 * (1 - e); break;
  }
  return { a, b };
}

interface Layer { item: Item; mod: Mod }
/** Items to draw at a time, bottom layer first. Includes both sides of a running transition. */
export function layersAt(tl: Timeline, tMs: number): Layer[] {
  const out: Layer[] = [];
  for (let ti = tl.tracks.length - 1; ti >= 0; ti--) {
    const track = tl.tracks[ti]!;
    if (track.hidden || track.kind === "audio") continue;
    const items = itemsOnTrack(tl, track.id);
    const mods = new Map<string, Mod>();
    const extra = new Set<string>();
    for (const tr of tl.transitions) {
      const a = tl.items[tr.fromItemId], b = tl.items[tr.toItemId];
      if (!a || !b || a.trackId !== track.id) continue;
      const cut = b.display.from;
      const half = tr.durationMs / 2;
      if (tMs >= cut - half && tMs < cut + half) {
        const m = transitionMods(tl, tr, (tMs - (cut - half)) / tr.durationMs);
        mods.set(a.id, m.a); mods.set(b.id, m.b);
        extra.add(a.id); extra.add(b.id);
      }
    }
    const active = items.filter((i) => (tMs >= i.display.from && tMs < i.display.to) || extra.has(i.id));
    // outgoing side first so the incoming clip draws over it
    active.sort((x, y) => x.display.from - y.display.from);
    for (const it of active) out.push({ item: it, mod: mods.get(it.id) ?? NO_MOD });
  }
  return out;
}

// ---------- text ----------
function setFont(ctx: Ctx, family: string, weight: number, size: number) {
  ctx.font = `${Math.max(1, size).toFixed(2)}px "${fontKey(family, weight)}"`;
}
function setSpacing(ctx: Ctx, px: number) {
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}
function applyCase(t: string, c: TextStyle["textTransform"]): string {
  return c === "uppercase" ? t.toUpperCase() : c === "lowercase" ? t.toLowerCase() : t;
}
export interface RichWord { text: string; color?: string; scale?: number; alpha?: number; box?: { color: string; radius: number; padX: number; padY: number } }
interface BlockExtras { lineBackground?: { color: string; padX: number; padY: number; radius: number } | null; glow?: { color: string; blur: number } | null }
interface PlacedWord extends RichWord { x: number; w: number; size: number }
interface PlacedLine { words: PlacedWord[]; width: number; height: number; ascent: number }

function layoutWords(ctx: Ctx, words: RichWord[], style: TextStyle, maxWidthPx: number, maxLines = 99, maxChars = 999): PlacedLine[] {
  const lines: PlacedLine[] = [];
  let cur: PlacedWord[] = [];
  let x = 0;
  let chars = 0;
  setSpacing(ctx, style.letterSpacing);
  setFont(ctx, style.fontFamily, style.fontWeight, style.fontSize);
  const space = ctx.measureText(" ").width || style.fontSize * 0.28;
  const push = () => {
    if (!cur.length) return;
    const width = cur[cur.length - 1]!.x + cur[cur.length - 1]!.w;
    const size = Math.max(...cur.map((w) => w.size));
    lines.push({ words: cur, width, height: size * style.lineHeight, ascent: size * 0.8 });
    cur = []; x = 0; chars = 0;
  };
  for (const w of words) {
    const parts = w.text.split("\n");
    parts.forEach((part, pi) => {
      if (pi > 0) push();
      if (!part) return;
      const size = style.fontSize * (w.scale ?? 1);
      setFont(ctx, style.fontFamily, style.fontWeight, size);
      const ww = ctx.measureText(part).width;
      if (cur.length && (x + ww > maxWidthPx || chars + part.length > maxChars) && lines.length < maxLines - 1) push();
      cur.push({ ...w, text: part, x, w: ww, size });
      x += ww + space * (size / style.fontSize);
      chars += part.length + 1;
    });
  }
  push();
  return lines;
}
function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
/** Draw wrapped rich text centred on (0,0) in the current transform. Returns the block size. */
function drawTextBlock(ctx: Ctx, words: RichWord[], style: TextStyle, maxWidthPx: number, opts: { maxLines?: number; maxChars?: number; revealChars?: number } & BlockExtras = {}): { w: number; h: number } {
  const lines = layoutWords(ctx, words, style, maxWidthPx, opts.maxLines, opts.maxChars);
  if (!lines.length) return { w: 0, h: 0 };
  const blockW = Math.max(...lines.map((l) => l.width));
  const blockH = lines.reduce((s, l) => s + l.height, 0);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  const lineX = (line: PlacedLine) => (style.align === "left" ? -blockW / 2 : style.align === "right" ? blockW / 2 - line.width : -line.width / 2);
  if (style.background) {
    const b = style.background;
    ctx.save();
    ctx.fillStyle = b.color;
    roundRect(ctx, -blockW / 2 - b.paddingX, -blockH / 2 - b.paddingY, blockW + b.paddingX * 2, blockH + b.paddingY * 2, b.radius);
    ctx.fill();
    ctx.restore();
  }
  // tight per-line boxes (text typed inside the apps looks like this) and per-word boxes
  {
    let y = -blockH / 2;
    for (const line of lines) {
      const visible = line.words.filter((w) => (w.alpha ?? 1) > 0.01);
      if (opts.lineBackground && visible.length) {
        const lb = opts.lineBackground;
        const x0 = lineX(line) + visible[0]!.x, x1 = lineX(line) + visible[visible.length - 1]!.x + visible[visible.length - 1]!.w;
        ctx.save(); ctx.fillStyle = lb.color;
        roundRect(ctx, x0 - lb.padX, y - lb.padY / 2, x1 - x0 + lb.padX * 2, line.height + lb.padY, lb.radius);
        ctx.fill(); ctx.restore();
      }
      for (const w of line.words) {
        if (!w.box || (w.alpha ?? 1) <= 0.01) continue;
        const capH = w.size * 1.02;
        ctx.save(); ctx.fillStyle = w.box.color;
        roundRect(ctx, lineX(line) + w.x - w.box.padX, y + (line.height - capH) / 2 - w.box.padY, w.w + w.box.padX * 2, capH + w.box.padY * 2, w.box.radius);
        ctx.fill(); ctx.restore();
      }
      y += line.height;
    }
  }
  const reveal = opts.revealChars ?? Number.POSITIVE_INFINITY;
  const passes: ("glow" | "stroke" | "fill")[] = [];
  if (opts.glow) passes.push("glow", "glow");
  if (style.strokeColor && style.strokeWidth > 0) passes.push("stroke");
  passes.push("fill");
  const shadowPass = passes.find((x) => x !== "glow");
  for (const pass of passes) {
    let y = -blockH / 2;
    let left = reveal;
    for (const line of lines) {
      const ox = lineX(line);
      const baseline = y + (line.height - line.ascent / 0.8) / 2 + line.ascent;
      for (const w of line.words) {
        if (left <= 0) break;
        const text = left < w.text.length ? w.text.slice(0, Math.max(0, Math.floor(left))) : w.text;
        left -= w.text.length + 1;
        if ((w.alpha ?? 1) <= 0.01) continue;
        setFont(ctx, style.fontFamily, style.fontWeight, w.size);
        ctx.save();
        if (w.alpha !== undefined) ctx.globalAlpha *= w.alpha;
        if (pass === "glow") {
          ctx.shadowColor = opts.glow!.color; ctx.shadowBlur = opts.glow!.blur; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
          ctx.fillStyle = opts.glow!.color;
          ctx.fillText(text, ox + w.x, baseline);
        } else {
          if (style.shadow && pass === shadowPass && !w.box) {
            ctx.shadowColor = style.shadow.color; ctx.shadowBlur = style.shadow.blur; ctx.shadowOffsetX = style.shadow.x; ctx.shadowOffsetY = style.shadow.y;
          }
          if (pass === "stroke") {
            if (!w.box) {
              ctx.strokeStyle = style.strokeColor!;
              ctx.lineWidth = style.strokeWidth * 2 * (w.size / style.fontSize);
              ctx.strokeText(text, ox + w.x, baseline);
            }
          } else {
            ctx.fillStyle = w.color ?? style.color;
            ctx.fillText(text, ox + w.x, baseline);
          }
        }
        ctx.restore();
      }
      y += line.height;
    }
  }
  return { w: blockW, h: blockH };
}
export function measureTextBlock(ctx: Ctx, words: RichWord[], style: TextStyle, maxWidthPx: number, maxLines?: number, maxChars?: number): { w: number; h: number } {
  const lines = layoutWords(ctx, words, style, maxWidthPx, maxLines, maxChars);
  if (!lines.length) return { w: 0, h: 0 };
  return { w: Math.max(...lines.map((l) => l.width)), h: lines.reduce((s, l) => s + l.height, 0) };
}

function inOut(kindIn: string, kindOut: string, durMs: number, local: number, len: number): { alpha: number; dx: number; dy: number; scale: number; reveal: number } {
  const r = { alpha: 1, dx: 0, dy: 0, scale: 1, reveal: 1 };
  const d = Math.max(1, Math.min(durMs, len / 2));
  const apply = (kind: string, p: number, entering: boolean) => {
    const q = entering ? p : 1 - p; // q goes 0 -> 1 as the text becomes fully visible
    switch (kind) {
      case "fade": r.alpha *= ease("ease-out", q); break;
      case "slide-up": r.alpha *= ease("ease-out", q); r.dy += (1 - ease("ease-out", q)) * (entering ? 60 : -60); break;
      case "slide-left": r.alpha *= ease("ease-out", q); r.dx += (1 - ease("ease-out", q)) * (entering ? 120 : -120); break;
      case "pop": r.scale *= entering ? 0.6 + 0.4 * ease("back-out", q) : 0.6 + 0.4 * ease("ease-in", q); r.alpha *= clamp(q * 3, 0, 1); break;
      case "typewriter": case "word-reveal": if (entering) r.reveal = q; else r.alpha *= q; break;
    }
  };
  if (kindIn !== "none" && local < d) apply(kindIn, local / d, true);
  else if ((kindIn === "typewriter" || kindIn === "word-reveal")) {
    // these reveal across a longer span: up to 60% of the item
    const span = Math.min(len * 0.6, Math.max(d, 1200));
    if (local < span) r.reveal = local / span;
  }
  if (kindOut !== "none" && local > len - d) apply(kindOut, (local - (len - d)) / d, false);
  return r;
}

function drawText(ctx: Ctx, tl: Timeline, item: TextItem, tMs: number, mod: Mod) {
  const tr = animatedTransform(item, tMs);
  const local = tMs - item.display.from, len = item.display.to - item.display.from;
  const a = inOut(item.animation.in, item.animation.out, item.animation.durationMs, local, len);
  const style = { ...DEFAULT_TEXT_STYLE, ...item.style };
  const text = applyCase(item.text, style.textTransform);
  let words: RichWord[] = text.split(/ +/).map((t) => ({ text: t }));
  let revealChars: number | undefined;
  if (a.reveal < 1) {
    if (item.animation.in === "word-reveal") { const n = Math.ceil(words.length * a.reveal); words = words.map((w, i) => ({ ...w, alpha: i < n ? 1 : 0 })); }
    else revealChars = Math.floor(text.length * a.reveal);
  }
  ctx.save();
  ctx.globalAlpha *= clamp(tr.opacity * a.alpha * mod.opacity, 0, 1);
  ctx.translate(tl.size.width / 2 + tr.x + a.dx + mod.dx, tl.size.height / 2 + tr.y + a.dy + mod.dy);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  const s = tr.scale * a.scale * mod.scale;
  if (s !== 1) ctx.scale(s, s);
  drawTextBlock(ctx, words, style, tl.size.width * style.maxWidth, { revealChars });
  ctx.restore();
}

// ---------- captions ----------
export function captionStyleFor(tl: Timeline, cap: CaptionItem): CaptionStyle {
  const track = tl.tracks.find((t) => t.id === cap.trackId);
  return { ...DEFAULT_CAPTION_STYLE, ...(track?.captionStyle ?? {}), ...(cap.override ?? {}) } as CaptionStyle;
}
/** Timeline time of a caption word. Linked captions map source time through their clip. */
export function captionWordTimes(tl: Timeline, cap: CaptionItem): { from: number; to: number }[] {
  if (cap.manual) return cap.words.map((w) => ({ from: cap.display.from + w.s, to: cap.display.from + w.e }));
  const clip = tl.items[cap.linkedItemId];
  if (!clip || !isMedia(clip)) return cap.words.map(() => ({ ...cap.display }));
  return cap.words.map((w) => ({ from: clip.display.from + (w.s - clip.trim.from) / clip.playbackRate, to: clip.display.from + (w.e - clip.trim.from) / clip.playbackRate }));
}
function drawCaption(ctx: Ctx, tl: Timeline, cap: CaptionItem, tMs: number) {
  const style = captionStyleFor(tl, cap);
  const times = captionWordTimes(tl, cap);
  let active = -1;
  for (let i = 0; i < times.length; i++) if (tMs >= times[i]!.from - 20) active = i;
  const spoken = active;
  if (active < 0) active = 0;
  const cased = cap.words.map((w) => applyCase(w.text, style.textTransform));
  const upcoming = style.upcomingOpacity ?? 1;
  const boxMode = style.mode === "highlight" && style.highlightStyle === "box" && style.highlightBox;
  let words: RichWord[];
  if (style.mode === "word") {
    const w = cap.words[active]!;
    words = [{ text: cased[active]!, color: w.emphasis ? style.emphasisColor : undefined, scale: w.emphasis ? style.emphasisScale : 1 }];
  } else {
    words = cap.words.map((w, i) => {
      const isActive = style.mode === "highlight" && i === spoken;
      const rw: RichWord = { text: cased[i]!, scale: (w.emphasis ? style.emphasisScale : 1) * (isActive ? style.activeScale ?? 1 : 1) };
      if (isActive && boxMode) { rw.box = { color: style.highlightBox!.color, radius: style.highlightBox!.radius, padX: style.highlightBox!.padX, padY: style.highlightBox!.padY }; rw.color = style.highlightBox!.textColor ?? style.color; }
      else if (isActive) rw.color = style.highlightColor;
      else if (w.emphasis) rw.color = style.emphasisColor;
      if (style.mode === "highlight" && i > spoken && upcoming < 1) rw.alpha = upcoming;
      return rw;
    });
  }
  const scale = cap.override?.scale ?? 1;
  const local = style.mode === "word" ? tMs - times[active]!.from : tMs - cap.display.from;
  let alpha = 1, s = scale, dy = 0;
  if (style.animation === "pop") { const p = clamp(local / 130, 0, 1); s *= 0.72 + 0.28 * ease("back-out", p); alpha = clamp(p * 4, 0, 1); }
  else if (style.animation === "fade") alpha = clamp(local / 160, 0, 1);
  else if (style.animation === "slide-up") { const p = clamp(local / 180, 0, 1); dy = (1 - ease("ease-out", p)) * style.fontSize * 0.45; alpha = clamp(p * 3, 0, 1); }
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(tl.size.width / 2, tl.size.height * style.position + dy);
  if (style.tilt) ctx.rotate((style.tilt * Math.PI) / 180);
  if (s !== 1) ctx.scale(s, s);
  drawTextBlock(ctx, words, style, tl.size.width * style.maxWidth, { maxLines: style.mode === "word" ? 1 : style.maxLines, maxChars: style.maxCharsPerLine, lineBackground: style.lineBackground, glow: style.glow });
  ctx.restore();
}

// ---------- shapes ----------
function drawShape(ctx: Ctx, tl: Timeline, item: ShapeItem, tMs: number, mod: Mod) {
  const tr = animatedTransform(item, tMs);
  ctx.save();
  ctx.globalAlpha *= clamp(tr.opacity * mod.opacity, 0, 1);
  ctx.translate(tl.size.width / 2 + tr.x + mod.dx, tl.size.height / 2 + tr.y + mod.dy);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  const s = tr.scale * mod.scale;
  if (s !== 1) ctx.scale(s, s);
  const w = item.width, h = item.height;
  ctx.beginPath();
  if (item.shape === "ellipse") ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (item.shape === "line") { ctx.moveTo(-w / 2, 0); ctx.lineTo(w / 2, 0); }
  else roundRect(ctx, -w / 2, -h / 2, w, h, (item.roundness / 100) * Math.min(w, h) / 2);
  if (item.fill && item.shape !== "line") { ctx.fillStyle = item.fill; ctx.fill(); }
  if (item.strokeColor && (item.strokeWidth > 0 || item.shape === "line")) { ctx.strokeStyle = item.strokeColor; ctx.lineWidth = Math.max(1, item.strokeWidth || h); ctx.lineCap = "round"; ctx.stroke(); }
  ctx.restore();
}

// ---------- motion graphics ----------
function layerValue(layer: MGLayer, prop: string, base: number, local: number): number {
  let v = base;
  for (const a of layer.anims ?? []) {
    if (a.prop !== prop) continue;
    if (local < a.startMs) { v = a.from; break; }
    const p = a.durationMs <= 0 ? 1 : clamp((local - a.startMs) / a.durationMs, 0, 1);
    v = a.from + (a.to - a.from) * ease(a.easing ?? "ease-out", p);
  }
  return v;
}
function drawMotionGraphic(ctx: Ctx, tl: Timeline, item: MotionGraphicItem, tMs: number, mod: Mod, res: RenderResources) {
  const { width: W, height: H } = tl.size;
  const local = tMs - item.display.from, len = item.display.to - item.display.from;
  const tr = animatedTransform(item, tMs);
  ctx.save();
  ctx.globalAlpha *= clamp(tr.opacity * mod.opacity, 0, 1);
  ctx.translate(W / 2 + tr.x + mod.dx, H / 2 + tr.y + mod.dy);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  const gs = tr.scale * mod.scale;
  if (gs !== 1) ctx.scale(gs, gs);
  ctx.translate(-W / 2, -H / 2);
  for (const layer of item.layers) {
    const from = layer.showFromMs ?? 0, to = layer.hideAtMs ?? len;
    if (local < from || local >= to) continue;
    const ll = local - from;
    let opacity = layerValue(layer, "opacity", layer.opacity ?? 1, ll);
    let x = layerValue(layer, "x", layer.x, ll) * W, y = layerValue(layer, "y", layer.y, ll) * H;
    let scale = layerValue(layer, "scale", layer.scale ?? 1, ll);
    const rotation = layerValue(layer, "rotation", layer.rotation ?? 0, ll);
    const reveal = layerValue(layer, "reveal", 1, ll);
    if (layer.exit) {
      const d = Math.max(1, layer.exit.durationMs);
      const p = clamp((local - (to - d)) / d, 0, 1);
      if (p > 0) {
        const e = ease("ease-in", p);
        if (layer.exit.kind === "fade") opacity *= 1 - e;
        else if (layer.exit.kind === "slide-left") { x -= e * W * 0.25; opacity *= 1 - e; }
        else if (layer.exit.kind === "slide-down") { y += e * H * 0.08; opacity *= 1 - e; }
        else if (layer.exit.kind === "scale") { scale *= 1 - 0.4 * e; opacity *= 1 - e; }
      }
    }
    if (opacity <= 0.002) continue;
    const anchor = layer.anchor ?? "center";
    ctx.save();
    ctx.globalAlpha *= clamp(opacity, 0, 1);
    ctx.translate(x, y);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    if (scale !== 1) ctx.scale(scale, scale);
    if (layer.kind === "text") {
      const style: TextStyle = { ...DEFAULT_TEXT_STYLE, shadow: null, ...(layer.style ?? {}) };
      style.align = anchor.includes("left") ? "left" : anchor.includes("right") ? "right" : style.align ?? "center";
      const text = applyCase(layer.text ?? "", style.textTransform);
      const words: RichWord[] = text.split(/ +/).map((t) => ({ text: t }));
      const maxW = (layer.width ?? W * style.maxWidth);
      const m = measureTextBlock(ctx, words, style, maxW);
      const ox = anchor.includes("left") ? m.w / 2 : anchor.includes("right") ? -m.w / 2 : 0;
      const oy = anchor.startsWith("top") ? m.h / 2 : anchor.startsWith("bottom") ? -m.h / 2 : 0;
      ctx.translate(ox, oy);
      drawTextBlock(ctx, words, style, maxW, { revealChars: reveal < 1 ? Math.floor(text.length * reveal) : undefined });
    } else {
      const w = layerValue(layer, "width", layer.width ?? 200, ll), h = layerValue(layer, "height", layer.height ?? 200, ll);
      const ox = anchor.includes("left") ? 0 : anchor.includes("right") ? -w : -w / 2;
      const oy = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? -h : -h / 2;
      const rw = w * clamp(reveal, 0, 1);
      if (layer.kind === "image") {
        const img = layer.assetId ? res.getImage?.(layer.assetId) : null;
        if (img) { ctx.save(); if (layer.roundness) { roundRect(ctx, ox, oy, w, h, (layer.roundness / 100) * Math.min(w, h) / 2); ctx.clip(); } ctx.drawImage(img.image as CanvasImageSource, ox, oy, w, h); ctx.restore(); }
      } else {
        ctx.beginPath();
        if (layer.kind === "ellipse") ctx.ellipse(ox + w / 2, oy + h / 2, rw / 2, h / 2, 0, 0, Math.PI * 2);
        else if (layer.kind === "line") { ctx.moveTo(ox, oy + h / 2); ctx.lineTo(ox + rw, oy + h / 2); }
        else roundRect(ctx, ox, oy, rw, h, ((layer.roundness ?? 0) / 100) * Math.min(w, h) / 2);
        if (layer.fill && layer.kind !== "line") { ctx.fillStyle = layer.fill; ctx.fill(); }
        if (layer.strokeColor && ((layer.strokeWidth ?? 0) > 0 || layer.kind === "line")) { ctx.strokeStyle = layer.strokeColor; ctx.lineWidth = Math.max(1, layer.strokeWidth ?? h); ctx.lineCap = "round"; ctx.stroke(); }
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

// ---------- media ----------
function drawMedia(ctx: Ctx, tl: Timeline, item: MediaItem, tMs: number, mod: Mod, res: RenderResources) {
  if (item.type === "audio") return;
  const frame = res.getFrame(item, timelineToSource(item, tMs));
  if (!frame) return;
  const { width: W, height: H } = tl.size;
  const tr = animatedTransform(item, tMs);
  const box = mediaBox(tl, tr, frame.width, frame.height);
  const fx = resolvedEffects(item);
  const overlay = fx.filter((e) => OVERLAY_EFFECTS.has(e.id) && e.value);
  const opacity = clamp(tr.opacity * mod.opacity, 0, 1);
  if (opacity <= 0.002) return;
  const filter = cssFilter(fx, Math.min(W, H), mod.blur * (Math.min(W, H) / 1080));
  const paint = (c: Ctx) => {
    c.save();
    if (mod.clip) { c.beginPath(); c.rect(mod.clip.x, mod.clip.y, mod.clip.w, mod.clip.h); c.clip(); }
    c.translate(box.cx + mod.dx, box.cy + mod.dy);
    if (box.rotation) c.rotate((box.rotation * Math.PI) / 180);
    const sc = mod.scale;
    if (sc !== 1 || tr.flipH) c.scale(tr.flipH ? -sc : sc, sc);
    if (filter !== "none") c.filter = filter;
    c.imageSmoothingEnabled = true;
    (c as unknown as { imageSmoothingQuality: string }).imageSmoothingQuality = "high";
    c.drawImage(frame.image as CanvasImageSource, box.crop.sx, box.crop.sy, box.crop.sw, box.crop.sh, -box.w / 2, -box.h / 2, box.w, box.h);
    c.filter = "none";
    // colour passes that plain CSS filters cannot express, confined to the picture
    for (const e of overlay) {
      c.save();
      c.beginPath(); c.rect(-box.w / 2, -box.h / 2, box.w, box.h); c.clip();
      if (e.id === "temperature" || e.id === "tint") {
        const a = clamp(Math.abs(e.value) / 100, 0, 1) * 0.55;
        c.globalCompositeOperation = "soft-light";
        c.fillStyle = e.id === "temperature" ? (e.value > 0 ? `rgba(255,150,40,${a})` : `rgba(40,130,255,${a})`) : e.value > 0 ? `rgba(255,60,220,${a})` : `rgba(60,255,110,${a})`;
        c.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
      } else if (e.id === "fade") {
        c.globalCompositeOperation = "screen";
        const v = Math.round(clamp(e.value / 100, 0, 1) * 70);
        c.fillStyle = `rgb(${v},${v},${v})`;
        c.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
      } else if (e.id === "vignette") {
        const r = Math.hypot(box.w, box.h) / 2;
        const g = c.createRadialGradient(0, 0, r * 0.45, 0, 0, r);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, `rgba(0,0,0,${(clamp(e.value / 100, 0, 1) * 0.85).toFixed(3)})`);
        c.fillStyle = g;
        c.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
      }
      c.restore();
    }
    c.restore();
  };
  if (overlay.length && opacity < 0.999) {
    // blend passes must not touch the layers underneath a half-transparent clip: paint to a scratch canvas first
    const s = res.scratch(W, H, 0);
    s.ctx.save(); s.ctx.setTransform(1, 0, 0, 1, 0, 0); s.ctx.clearRect(0, 0, W, H); s.ctx.restore();
    paint(s.ctx);
    ctx.save(); ctx.globalAlpha *= opacity; ctx.drawImage(s.canvas as CanvasImageSource, 0, 0); ctx.restore();
  } else {
    ctx.save(); ctx.globalAlpha *= opacity; paint(ctx); ctx.restore();
  }
  if (mod.wash && mod.wash.alpha > 0) { ctx.save(); ctx.globalAlpha = mod.wash.alpha; ctx.fillStyle = mod.wash.color; ctx.fillRect(0, 0, W, H); ctx.restore(); }
}

// ---------- frame ----------
export function renderFrame(ctx: Ctx, tl: Timeline, tMs: number, res: RenderResources, opts: { skipCaptions?: boolean } = {}) {
  const { width: W, height: H } = tl.size;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.fillStyle = tl.background || "#000000";
  ctx.fillRect(0, 0, W, H);
  for (const { item, mod } of layersAt(tl, tMs)) {
    switch (item.type) {
      case "video": case "image": drawMedia(ctx, tl, item, tMs, mod, res); break;
      case "text": drawText(ctx, tl, item, tMs, mod); break;
      case "shape": drawShape(ctx, tl, item, tMs, mod); break;
      case "motionGraphic": drawMotionGraphic(ctx, tl, item, tMs, mod, res); break;
      case "caption": if (!opts.skipCaptions) drawCaption(ctx, tl, item, tMs); break;
    }
  }
  ctx.restore();
}

/** Bounding box of an item on the canvas at a time, for selection handles and hit-testing. */
export function itemBox(ctx: Ctx, tl: Timeline, item: Item, tMs: number, res: RenderResources): Box | null {
  const { width: W, height: H } = tl.size;
  if (item.type === "video" || item.type === "image") {
    const f = res.getFrame(item, timelineToSource(item, tMs));
    const tr = animatedTransform(item, tMs);
    const b = mediaBox(tl, tr, f?.width ?? W, f?.height ?? H);
    return { cx: b.cx, cy: b.cy, w: b.w, h: b.h, rotation: b.rotation };
  }
  if (item.type === "text") {
    const tr = animatedTransform(item, tMs);
    const style = { ...DEFAULT_TEXT_STYLE, ...item.style };
    const m = measureTextBlock(ctx, applyCase(item.text, style.textTransform).split(/ +/).map((t) => ({ text: t })), style, W * style.maxWidth);
    const px = style.background?.paddingX ?? 0, py = style.background?.paddingY ?? 0;
    return { cx: W / 2 + tr.x, cy: H / 2 + tr.y, w: (m.w + px * 2) * tr.scale, h: (m.h + py * 2) * tr.scale, rotation: tr.rotation };
  }
  if (item.type === "shape") {
    const tr = animatedTransform(item, tMs);
    return { cx: W / 2 + tr.x, cy: H / 2 + tr.y, w: item.width * tr.scale, h: Math.max(item.height, item.strokeWidth) * tr.scale, rotation: tr.rotation };
  }
  if (item.type === "caption") {
    const style = captionStyleFor(tl, item);
    const m = measureTextBlock(ctx, item.words.map((w) => ({ text: applyCase(w.text, style.textTransform), scale: w.emphasis ? style.emphasisScale : 1 })), style, W * style.maxWidth, style.maxLines, style.maxCharsPerLine);
    return { cx: W / 2, cy: H * style.position, w: m.w, h: m.h, rotation: 0 };
  }
  if (item.type === "motionGraphic") {
    const tr = animatedTransform(item, tMs);
    return { cx: W / 2 + tr.x, cy: H / 2 + tr.y, w: W * tr.scale, h: H * tr.scale, rotation: tr.rotation };
  }
  return null;
}
