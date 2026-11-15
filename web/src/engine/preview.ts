// Live preview: the shared compositor draws to a canvas while pooled <video>/<audio> elements supply frames and sound.
import type { MediaItem, Timeline } from "@shared/types";
import { itemGainAt, layersAt, renderFrame, type FrameSource, type RenderResources } from "@shared/render";
import { isMedia, timelineDuration, timelineToSource } from "@shared/timeline";

export interface PreviewAsset { id: string; type: "video" | "audio" | "image"; durationMs: number; hasAudio: boolean; urls: { proxy: string | null; original: string } }
type El = HTMLVideoElement | HTMLAudioElement;

export class PreviewEngine {
  private ctx: CanvasRenderingContext2D;
  private els = new Map<string, { el: El; assetId: string }>();
  private images = new Map<string, HTMLImageElement>();
  private scratchPool = new Map<number, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>();
  private raf = 0;
  private playing = false;
  private t = 0;
  private wallStart = 0;
  private tStart = 0;
  private dirty = true;
  private k = 1;
  timeline: Timeline | null = null;
  assets: Record<string, PreviewAsset> = {};
  onTime: (ms: number) => void = () => undefined;
  onPlaying: (p: boolean) => void = () => undefined;
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    const loop = () => { this.tick(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  destroy() { cancelAnimationFrame(this.raf); for (const { el } of this.els.values()) { el.pause(); el.removeAttribute("src"); el.load(); } this.els.clear(); }
  setTimeline(tl: Timeline, assets: Record<string, PreviewAsset>) { this.timeline = tl; this.assets = assets; this.dirty = true; if (this.t > timelineDuration(tl)) this.seek(timelineDuration(tl)); }
  /** Size the backing store for the space available (CSS pixels). */
  resize(cssW: number, cssH: number) {
    if (!this.timeline) return;
    const { width: W, height: H } = this.timeline.size;
    const fit = Math.min(cssW / W, cssH / H);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = Math.min(1, fit * dpr);
    const w = Math.max(2, Math.round(W * k)), h = Math.max(2, Math.round(H * k));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.canvas.style.width = `${Math.round(W * fit)}px`; this.canvas.style.height = `${Math.round(H * fit)}px`;
    this.k = w / W; this.dirty = true;
  }
  get time() { return this.t; }
  get isPlaying() { return this.playing; }
  play() { if (!this.timeline) return; const d = timelineDuration(this.timeline); if (d <= 0) return; if (this.t >= d - 30) this.t = 0; this.playing = true; this.wallStart = performance.now(); this.tStart = this.t; this.onPlaying(true); }
  pause() { if (!this.playing) return; this.playing = false; for (const { el } of this.els.values()) el.pause(); this.onPlaying(false); this.dirty = true; }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  seek(ms: number) { const d = this.timeline ? timelineDuration(this.timeline) : 0; this.t = Math.min(Math.max(0, ms), d); this.wallStart = performance.now(); this.tStart = this.t; this.dirty = true; this.onTime(this.t); }

  private element(item: MediaItem): El | null {
    const a = this.assets[item.assetId];
    if (!a || a.type === "image") return null;
    let rec = this.els.get(item.id);
    if (rec && rec.assetId !== a.id) { rec.el.pause(); this.els.delete(item.id); rec = undefined; }
    if (!rec) {
      const el = a.type === "video" ? document.createElement("video") : document.createElement("audio");
      el.preload = "auto"; el.crossOrigin = "anonymous"; (el as HTMLVideoElement).playsInline = true;
      el.src = a.urls.proxy ?? a.urls.original;
      el.addEventListener("seeked", () => { this.dirty = true; });
      el.addEventListener("loadeddata", () => { this.dirty = true; });
      rec = { el, assetId: a.id };
      this.els.set(item.id, rec);
    }
    return rec.el;
  }
  private image(assetId: string): HTMLImageElement | null {
    const a = this.assets[assetId];
    if (!a) return null;
    let img = this.images.get(assetId);
    if (!img) { img = new Image(); img.crossOrigin = "anonymous"; img.src = a.urls.original; img.onload = () => { this.dirty = true; }; this.images.set(assetId, img); }
    return img.complete && img.naturalWidth ? img : null;
  }
  private res: RenderResources = {
    getFrame: (item) => {
      if (item.type === "image") { const img = this.image(item.assetId); return img ? { image: img, width: img.naturalWidth, height: img.naturalHeight } : null; }
      const el = this.els.get(item.id)?.el as HTMLVideoElement | undefined;
      return el && el.readyState >= 2 && el.videoWidth ? ({ image: el, width: el.videoWidth, height: el.videoHeight } as FrameSource) : null;
    },
    scratch: (w, h, slot) => {
      let s = this.scratchPool.get(slot);
      const pw = Math.round(w * this.k), ph = Math.round(h * this.k);
      if (!s || s.canvas.width !== pw || s.canvas.height !== ph) { const c = document.createElement("canvas"); c.width = pw; c.height = ph; const x = c.getContext("2d")!; x.setTransform(this.k, 0, 0, this.k, 0, 0); s = { canvas: c, ctx: x }; this.scratchPool.set(slot, s); }
      return s;
    },
    getImage: (assetId) => { const img = this.image(assetId); return img ? { image: img, width: img.naturalWidth, height: img.naturalHeight } : null; },
  };

  private tick() {
    const tl = this.timeline;
    if (!tl) return;
    const dur = timelineDuration(tl);
    if (this.playing) {
      this.t = this.tStart + (performance.now() - this.wallStart);
      if (this.t >= dur) { this.t = dur; this.pause(); }
      this.onTime(this.t);
    }
    // which media should be loaded: everything on screen or audible now, plus what starts within 2.5 s
    const wanted = new Set<string>();
    const active = new Set(layersAt(tl, this.t).map((l) => l.item.id));
    for (const it of Object.values(tl.items)) {
      if (!isMedia(it) || it.type === "image") continue;
      const on = this.t >= it.display.from && this.t < it.display.to;
      const soon = it.display.from > this.t && it.display.from - this.t < 2500;
      if (!(on || soon || active.has(it.id))) continue;
      const a = this.assets[it.assetId];
      if (!a) continue;
      wanted.add(it.id);
      const el = this.element(it);
      if (!el) continue;
      const live = on || active.has(it.id);
      const src = Math.min(Math.max(0, timelineToSource(it, live ? this.t : it.display.from) / 1000), Math.max(0, a.durationMs / 1000 - 0.05));
      const gain = live && on ? itemGainAt(tl, it, this.t) : 0;
      el.muted = gain <= 0.001;
      el.volume = Math.min(1, Math.max(0, gain));
      if (this.playing && live) {
        if (Math.abs(el.playbackRate - it.playbackRate) > 0.001) el.playbackRate = Math.min(16, Math.max(0.1, it.playbackRate));
        const drift = Math.abs(el.currentTime - src);
        if (el.paused) { if (drift > 0.05) el.currentTime = src; void el.play().catch(() => undefined); }
        else if (drift > 0.3) el.currentTime = src;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - src) > 0.04 && !el.seeking) el.currentTime = src;
      }
    }
    for (const [id, rec] of this.els) if (!wanted.has(id)) { rec.el.pause(); rec.el.removeAttribute("src"); rec.el.load(); this.els.delete(id); }
    if (this.playing || this.dirty) {
      this.dirty = false;
      this.ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
      renderFrame(this.ctx, tl, this.t, this.res);
    }
  }
  invalidate() { this.dirty = true; }
}
