import React, { useEffect, useMemo, useRef, useState } from "react";
import { Volume2, VolumeX, Eye, EyeOff, Lock, Unlock } from "lucide-react";
import type { CaptionItem, Item, MediaItem, Timeline as TL, Track } from "@shared/types";
import * as T from "@shared/timeline";
import { fmtTimeFine } from "../store";
import { useEditor } from "./store";

const ROW: Record<Track["kind"], number> = { caption: 30, overlay: 34, video: 56, audio: 44 };
const COLOR: Record<string, string> = { video: "#2c3550", image: "#2f4a3f", audio: "#3a2f55", text: "#5a4a1c", caption: "#27303a", shape: "#44303a", motionGraphic: "#4a2f55" };
const GUTTER = 124;

function Wave({ peaks, from, to, dur }: { peaks: number[]; from: number; to: number; dur: number }) {
  const path = useMemo(() => {
    if (!peaks.length || dur <= 0) return "";
    const a = Math.floor((from / dur) * peaks.length), b = Math.max(a + 1, Math.ceil((to / dur) * peaks.length));
    const n = Math.min(240, b - a);
    const pts: string[] = [];
    for (let i = 0; i < n; i++) { const s = a + Math.floor((i * (b - a)) / n), e = a + Math.floor(((i + 1) * (b - a)) / n); let m = 0; for (let k = s; k < Math.max(e, s + 1); k++) m = Math.max(m, peaks[k] ?? 0); pts.push(`${(i / n) * 100},${50 - m * 46} `); }
    const back = [...pts].reverse().map((p) => { const [x, y] = p.trim().split(",").map(Number); return `${x},${100 - y!} `; });
    return `M${pts.join("L")}L${back.join("L")}Z`;
  }, [peaks, from, to, dur]);
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full opacity-60"><path d={path} fill="#b9a8ff" /></svg>;
}

type Drag = { kind: "move" | "trim-start" | "trim-end"; id: string; startX: number; base: TL; ids: string[]; moved: boolean };

export function TimelineView({ onSeek }: { onSeek: (ms: number) => void }) {
  const { timeline, draft, selection, playhead, pps, assetMap, magnet } = useEditor();
  const { select, setDraft, commitDraft, mutate, set } = useEditor.getState();
  const tl = draft ?? timeline;
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [scrub, setScrub] = useState(false);
  const duration = tl ? T.timelineDuration(tl) : 0;
  const width = Math.max(800, ((duration + 4000) / 1000) * pps);
  const xToMs = (clientX: number) => { const r = scroller.current!.getBoundingClientRect(); return Math.max(0, ((clientX - r.left + scroller.current!.scrollLeft - GUTTER) / pps) * 1000); };

  // keep the playhead in view while playing
  useEffect(() => { const el = scroller.current; if (!el) return; const x = (playhead / 1000) * pps + GUTTER; if (x > el.scrollLeft + el.clientWidth - 60) el.scrollLeft = x - 200; else if (x < el.scrollLeft + GUTTER) el.scrollLeft = Math.max(0, x - GUTTER - 40); }, [playhead, pps]);

  if (!tl) return null;
  const snapPoints = (ignore: string[]) => { const pts = [0, playhead]; for (const it of Object.values(tl.items)) if (!ignore.includes(it.id) && it.type !== "caption") pts.push(it.display.from, it.display.to); return pts; };
  const snap = (ms: number, pts: number[]) => { const tol = (8 / pps) * 1000; let best = ms, d = tol; for (const p of pts) if (Math.abs(p - ms) < d) { d = Math.abs(p - ms); best = p; } return best; };

  const onItemDown = (e: React.PointerEvent, it: Item, kind: Drag["kind"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const already = selection.includes(it.id);
    if (!already || additive) select([it.id], additive);
    const locked = T.trackOf(tl, it.trackId).locked;
    if (locked || (it.type === "caption" && !(it as CaptionItem).manual)) return;
    const ids = kind === "move" && already && selection.length > 1 ? selection.filter((id) => { const x = tl.items[id]; return x && !(x.type === "caption" && !(x as CaptionItem).manual); }) : [it.id];
    drag.current = { kind, id: it.id, startX: e.clientX, base: structuredClone(timeline!), ids, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onItemMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const next = structuredClone(d.base);
    const item = d.base.items[d.id]!;
    let deltaMs = (dx / pps) * 1000;
    const pts = snapPoints(d.ids);
    try {
      if (d.kind === "move") {
        const target = snap(item.display.from + deltaMs, pts);
        const endSnap = snap(item.display.to + deltaMs, pts);
        deltaMs = Math.abs(target - (item.display.from + deltaMs)) <= Math.abs(endSnap - (item.display.to + deltaMs)) ? target - item.display.from : endSnap - item.display.to;
        const minFrom = Math.min(...d.ids.map((id) => d.base.items[id]!.display.from));
        deltaMs = Math.max(-minFrom, deltaMs);
        // dropping on another track of the same kind moves the item there
        let trackId: string | undefined;
        if (d.ids.length === 1) { const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-track]") as HTMLElement | null; const tid = el?.dataset.track; if (tid && tid !== item.trackId && T.trackAccepts(T.trackOf(next, tid), item.type)) trackId = tid; }
        T.moveItems(next, d.ids, { byMs: Math.round(deltaMs), trackId });
      } else {
        const edge = d.kind === "trim-start" ? item.display.from : item.display.to;
        const snapped = snap(edge + deltaMs, pts);
        const delta = Math.round(snapped - edge);
        if (delta !== 0) T.trimItem(next, d.id, d.kind === "trim-start" ? "start" : "end", delta, { assetDurationMs: T.isMedia(item) ? assetMap[item.assetId]?.durationMs : undefined });
      }
      T.syncCaptions(next);
      setDraft(next);
    } catch { /* blocked by a neighbour or the end of the media: keep the last valid position */ }
  };
  const onItemUp = () => { const d = drag.current; drag.current = null; if (d?.moved) commitDraft(); else setDraft(null); };

  const ticks = useMemo(() => { const step = pps > 160 ? 0.5 : pps > 70 ? 1 : pps > 30 ? 2 : pps > 14 ? 5 : 10; const out: number[] = []; for (let s = 0; s <= (duration + 4000) / 1000; s += step) out.push(s); return { step, out }; }, [pps, duration]);
  const toggle = (track: Track, key: "muted" | "hidden" | "locked") => mutate((x) => { const t = T.trackOf(x, track.id); t[key] = !t[key]; });

  return (
    <div ref={scroller} className="relative h-full overflow-auto bg-bg" onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); set({ pps: Math.min(400, Math.max(8, pps * (e.deltaY < 0 ? 1.15 : 0.87))) }); } }}>
      <div style={{ width: width + GUTTER }} className="relative min-h-full">
        {/* ruler */}
        <div className="sticky top-0 z-20 flex h-7 border-b border-line bg-panel">
          <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-panel" style={{ width: GUTTER }} />
          <div className="relative flex-1 cursor-col-resize select-none" onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setScrub(true); select([]); onSeek(xToMs(e.clientX)); }} onPointerMove={(e) => { if (scrub) onSeek(xToMs(e.clientX)); }} onPointerUp={() => setScrub(false)}>
            {ticks.out.map((s) => <div key={s} className="absolute top-0 h-full border-l border-line/70 pl-1 text-[10px] leading-7 text-faint" style={{ left: s * pps }}>{Number.isInteger(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : ""}</div>)}
          </div>
        </div>
        {/* tracks */}
        {tl.tracks.map((track) => (
          <div key={track.id} className="flex border-b border-line/60" style={{ height: ROW[track.kind] }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-panel px-2" style={{ width: GUTTER }}>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-mute" title={track.id}>{track.name}</span>
              {(track.kind === "audio" || track.kind === "video") && <button className="text-faint hover:text-ink" onClick={() => toggle(track, "muted")} aria-label={track.muted ? "Unmute track" : "Mute track"}>{track.muted ? <VolumeX size={13} className="text-hot" /> : <Volume2 size={13} />}</button>}
              {track.kind !== "audio" && <button className="text-faint hover:text-ink" onClick={() => toggle(track, "hidden")} aria-label={track.hidden ? "Show track" : "Hide track"}>{track.hidden ? <EyeOff size={13} className="text-hot" /> : <Eye size={13} />}</button>}
              <button className="text-faint hover:text-ink" onClick={() => toggle(track, "locked")} aria-label={track.locked ? "Unlock track" : "Lock track"}>{track.locked ? <Lock size={12} className="text-warn" /> : <Unlock size={12} />}</button>
            </div>
            <div data-track={track.id} className={`relative flex-1 ${track.hidden || track.muted ? "opacity-50" : ""}`} onPointerDown={(e) => { if (e.target === e.currentTarget) { select([]); onSeek(xToMs(e.clientX)); } }}>
              {T.itemsOnTrack(tl, track.id).map((it) => {
                const left = (it.display.from / 1000) * pps, w = Math.max(3, ((it.display.to - it.display.from) / 1000) * pps);
                const sel = selection.includes(it.id);
                const a = T.isMedia(it) ? assetMap[it.assetId] : undefined;
                const linked = it.type === "caption" && !(it as CaptionItem).manual;
                const label = T.isMedia(it) ? a?.name ?? it.name ?? it.id : it.type === "text" ? it.text : it.type === "caption" ? T.captionText(it as CaptionItem) : it.type === "motionGraphic" ? it.title : it.type;
                const trans = tl.transitions.find((x) => x.toItemId === it.id);
                return (
                  <div key={it.id} className={`group absolute top-[3px] bottom-[3px] overflow-hidden rounded-md border text-[10px] leading-tight ${sel ? "z-[5] border-accent ring-1 ring-accent" : "border-black/40"} ${linked ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"}`}
                    style={{ left, width: w, background: COLOR[it.type], backgroundImage: (it.type === "video" || it.type === "image") && a?.urls.thumbnail ? `linear-gradient(rgba(10,10,14,.35),rgba(10,10,14,.35)),url(${a.urls.thumbnail})` : undefined, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }}
                    onPointerDown={(e) => onItemDown(e, it, "move")} onPointerMove={onItemMove} onPointerUp={onItemUp} onPointerCancel={onItemUp} title={`${label}\n${fmtTimeFine(it.display.from)} – ${fmtTimeFine(it.display.to)}`}>
                    {it.type === "audio" && a?.waveform && <Wave peaks={a.waveform} from={(it as MediaItem).trim.from} to={(it as MediaItem).trim.to} dur={a.durationMs} />}
                    <div className="pointer-events-none relative truncate px-1.5 pt-[3px] font-medium text-white/90 drop-shadow">{trans && <span className="mr-1 rounded bg-accent px-1 text-[9px] font-bold text-accentink">{trans.kind}</span>}{label}{T.isMedia(it) && it.playbackRate !== 1 && <span className="ml-1 text-accent">{it.playbackRate.toFixed(2)}×</span>}</div>
                    {!linked && w > 14 && <>
                      <div className="absolute inset-y-0 left-0 w-[7px] cursor-ew-resize bg-accent/0 hover:bg-accent/80 group-hover:bg-white/25" onPointerDown={(e) => onItemDown(e, it, "trim-start")} onPointerMove={onItemMove} onPointerUp={onItemUp} />
                      <div className="absolute inset-y-0 right-0 w-[7px] cursor-ew-resize bg-accent/0 hover:bg-accent/80 group-hover:bg-white/25" onPointerDown={(e) => onItemDown(e, it, "trim-end")} onPointerMove={onItemMove} onPointerUp={onItemUp} />
                    </>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {/* playhead */}
        <div className="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-accent" style={{ left: GUTTER + (playhead / 1000) * pps }}><div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[8px] border-x-transparent border-t-accent" /></div>
      </div>
      {!Object.keys(tl.items).length && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-faint" style={{ paddingLeft: GUTTER }}>Add clips from the Footage tab, or ask the assistant to build the edit.</div>}
      <span className="sr-only" aria-live="polite">{magnet ? "" : ""}</span>
    </div>
  );
}
