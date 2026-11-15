import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Play, Pause, Undo2, Redo2, Scissors, Trash2, Magnet, Download, ZoomIn, ZoomOut, Sparkles, Film, Type, Captions as CaptionsIcon, SlidersHorizontal, FileText, SkipBack, Check, CloudOff, Maximize2 } from "lucide-react";
import type { RenderJob, Timeline } from "@shared/types";
import * as T from "@shared/timeline";
import { CANVAS_PRESETS } from "@shared/catalog";
import { itemBox, layersAt, type RenderResources } from "@shared/render";
import { api } from "../api";
import { fmtBytes, fmtTimeFine, go, useApp } from "../store";
import { PreviewEngine } from "../engine/preview";
import { Bar, Modal, Spinner } from "../components/ui";
import { useEditor } from "./store";
import { TimelineView } from "./Timeline";
import { CaptionsPanel, ChatPanel, FootagePanel, Inspector, ReportPanel, TextPanel } from "./Panels";

function Preview({ engineRef }: { engineRef: React.MutableRefObject<PreviewEngine | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { timeline, draft, assetMap, selection, playhead } = useEditor();
  const fontsReady = useApp((s) => s.fontsReady);
  const tl = draft ?? timeline;
  const [, force] = useState(0);
  useEffect(() => {
    const e = new PreviewEngine(canvas.current!);
    engineRef.current = e;
    e.onTime = (ms) => useEditor.setState({ playhead: ms });
    e.onPlaying = (p) => useEditor.setState({ playing: p });
    return () => { e.destroy(); engineRef.current = null; };
  }, [engineRef]);
  useEffect(() => { const e = engineRef.current; if (!e || !tl) return; e.setTimeline(tl, assetMap as any); const r = box.current!.getBoundingClientRect(); e.resize(r.width - 24, r.height - 24); force((n) => n + 1); }, [tl, assetMap, engineRef, fontsReady]);
  useEffect(() => { const ro = new ResizeObserver(() => { const e = engineRef.current; if (!e || !box.current) return; const r = box.current.getBoundingClientRect(); e.resize(r.width - 24, r.height - 24); force((n) => n + 1); }); ro.observe(box.current!); return () => ro.disconnect(); }, [engineRef]);

  // selection outline + drag to move, measured with the same layout code that draws the frame
  const measure = useMemo(() => { const c = document.createElement("canvas"); return c.getContext("2d")!; }, []);
  const res: RenderResources = useMemo(() => ({ getFrame: (item) => { const a = assetMap[item.assetId]; return a ? { image: null, width: a.width ?? 1080, height: a.height ?? 1920 } : null; }, scratch: () => ({ canvas: measure.canvas, ctx: measure }) }), [assetMap, measure]);
  const cssScale = tl && canvas.current ? (parseFloat(canvas.current.style.width) || canvas.current.clientWidth) / tl.size.width : 1;
  const boxes = tl ? selection.map((id) => tl.items[id]).filter((it) => it && playhead >= it.display.from && playhead <= it.display.to).map((it) => ({ it: it!, b: itemBox(measure, tl, it!, playhead, res) })).filter((x) => x.b) : [];
  const drag = useRef<{ id: string; x: number; y: number; base: Timeline; moved: boolean } | null>(null);
  const toCanvas = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: (e.clientX - r.left) / cssScale, y: (e.clientY - r.top) / cssScale }; };
  const onDown = (e: React.PointerEvent) => {
    if (!tl) return;
    const p = toCanvas(e);
    const layers = layersAt(tl, playhead).reverse();
    for (const { item } of layers) {
      if (T.trackOf(tl, item.trackId).locked) continue;
      const b = itemBox(measure, tl, item, playhead, res);
      if (!b) continue;
      const pad = item.type === "text" || item.type === "caption" ? 14 : 0;
      if (Math.abs(p.x - b.cx) <= b.w / 2 + pad && Math.abs(p.y - b.cy) <= b.h / 2 + pad) {
        useEditor.getState().select([item.id]);
        drag.current = { id: item.id, x: p.x, y: p.y, base: structuredClone(timeline!), moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }
    }
    useEditor.getState().select([]);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(e);
    const dx = p.x - d.x, dy = p.y - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const next = structuredClone(d.base);
    const it = next.items[d.id]!;
    if (it.type === "caption") { const tr = next.tracks.find((t) => t.id === it.trackId)!; tr.captionStyle!.position = Math.min(0.95, Math.max(0.05, d.base.tracks.find((t) => t.id === it.trackId)!.captionStyle!.position + dy / next.size.height)); }
    else if ("transform" in it) {
      let nx = it.transform.x + dx, ny = it.transform.y + dy;
      if (Math.abs(nx) < 14) nx = 0; if (Math.abs(ny) < 14) ny = 0; // snap to the centre lines
      it.transform.x = Math.round(nx); it.transform.y = Math.round(ny);
    }
    useEditor.getState().setDraft(next);
  };
  const onUp = () => { const d = drag.current; drag.current = null; if (d?.moved) useEditor.getState().commitDraft(); };
  return (
    <div ref={box} className="checker relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0e0e13]">
      <div className="relative" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <canvas ref={canvas} className="block rounded-md shadow-2xl" />
        {boxes.map(({ it, b }) => <div key={it.id} className="pointer-events-none absolute border-2 border-accent" style={{ left: (b!.cx - b!.w / 2) * cssScale, top: (b!.cy - b!.h / 2) * cssScale, width: b!.w * cssScale, height: b!.h * cssScale, transform: `rotate(${b!.rotation}deg)` }} />)}
      </div>
    </div>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const { projectId, project, timeline } = useEditor();
  const { catalog, renders, toast } = useApp();
  const [preset, setPreset] = useState("social");
  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [muteMusic, setMuteMusic] = useState(false);
  const [name, setName] = useState(project?.name ?? "export");
  const [busy, setBusy] = useState(false);
  const mine = renders.filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const p = catalog?.exportPresets.find((x) => x.id === preset);
  const hasMusic = timeline ? Object.values(timeline.items).some((i) => i.type === "audio") : false;
  const start = async () => { if (!projectId) return; setBusy(true); try { await api.exportProject(projectId, { preset, format: preset === "webm" ? "webm" : format, filename: name, muteMusic }); } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); } };
  const status = (r: RenderJob) => r.status === "completed" ? "Ready" : r.status === "failed" ? "Failed" : r.status === "cancelled" ? "Cancelled" : r.status === "queued" ? "Waiting…" : r.status === "encoding" ? "Finishing…" : `Rendering ${Math.round(r.progress * 100)}%`;
  return (
    <Modal title="Export" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {catalog?.exportPresets.map((x) => <button key={x.id} onClick={() => { setPreset(x.id); setFormat(x.format); }} className={`rounded-xl border p-3 text-left ${preset === x.id ? "border-accent bg-accent/5" : "border-line hover:border-faint"}`}><div className="text-[13px] font-semibold">{x.name}</div><div className="mt-0.5 text-[11px] text-mute">{x.description}</div></button>)}
        </div>
        <div><label className="label" htmlFor="fname">File name</label><input id="fname" className="field" value={name} onChange={(e) => setName(e.target.value)} /></div>
        {hasMusic && <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line p-3 text-[13px]"><input type="checkbox" className="mt-0.5 accent-[#c6ff3d]" checked={muteMusic} onChange={(e) => setMuteMusic(e.target.checked)} /><span><span className="font-semibold">Export without the music</span><span className="block text-[12px] leading-snug text-mute">Use this when the track is a trending sound: add the official sound inside TikTok or Instagram when you post, lined up from the start, so the post is linked to the trend and the audio is licensed.</span></span></label>}
        <button className="btn-primary w-full !py-2.5" onClick={start} disabled={busy}>{busy ? <Spinner /> : <Download size={15} />}Export {p ? `· ${p.resolution === "original" ? "full size" : p.resolution}` : ""}</button>
        {mine.length > 0 && <div><div className="label">Exports</div><div className="divide-y divide-line rounded-xl border border-line">{mine.slice(0, 6).map((r) => (
          <div key={r.id} className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{r.filename}</div><div className="text-[11px] text-mute">{r.width}×{r.height} · {(r.durationMs / 1000).toFixed(1)}s{r.sizeBytes ? ` · ${fmtBytes(r.sizeBytes)}` : ""} · <span className={r.status === "failed" ? "text-hot" : r.status === "completed" ? "text-ok" : "text-accent"}>{status(r)}</span></div>{r.error && <div className="mt-0.5 text-[11px] text-hot">{r.error}</div>}{(r.status === "rendering" || r.status === "encoding") && <Bar value={r.progress} className="mt-1.5" />}</div>
            {r.status === "completed" && r.url ? <a className="btn-ghost" href={`${r.url}?download=${encodeURIComponent(r.filename)}`}><Download size={14} />Download</a> : (r.status === "rendering" || r.status === "queued") ? <button className="btn-quiet" onClick={() => api.cancelRender(r.id)}>Cancel</button> : null}
          </div>))}</div></div>}
      </div>
    </Modal>
  );
}

const LEFT_TABS = [{ id: "ai", label: "Assistant", icon: Sparkles }, { id: "footage", label: "Footage", icon: Film }, { id: "text", label: "Text", icon: Type }] as const;
const RIGHT_TABS = [{ id: "captions", label: "Captions", icon: CaptionsIcon }, { id: "inspect", label: "Selected", icon: SlidersHorizontal }, { id: "report", label: "Summary", icon: FileText }] as const;

export function Editor({ projectId }: { projectId: string }) {
  const s = useEditor();
  const { toast } = useApp();
  const engine = useRef<PreviewEngine | null>(null);
  const [left, setLeft] = useState<(typeof LEFT_TABS)[number]["id"]>("ai");
  const [right, setRight] = useState<(typeof RIGHT_TABS)[number]["id"]>("captions");
  const [exporting, setExporting] = useState(false);
  const [timelineH, setTimelineH] = useState(250);
  useEffect(() => { void s.load(projectId); return () => { useEditor.setState({ projectId: null, timeline: null }); }; /* eslint-disable-next-line */ }, [projectId]);
  useEffect(() => { if (s.selection.length === 1) setRight("inspect"); }, [s.selection]);
  const seek = useCallback((ms: number) => engine.current?.seek(ms), []);
  const tl = s.timeline;
  const duration = tl ? T.timelineDuration(tl) : 0;

  const split = useCallback(() => {
    const st = useEditor.getState(); const t = st.timeline; if (!t) return;
    const targets = (st.selection.length ? st.selection.map((id) => t.items[id]).filter(Boolean) : Object.values(t.items)).filter((i) => i && i.type !== "caption" && st.playhead > i.display.from + 40 && st.playhead < i.display.to - 40 && !T.trackOf(t, i.trackId).locked);
    if (!targets.length) return toast("Move the playhead over a clip to split it.");
    st.mutate((x) => { for (const i of targets) T.splitItem(x as any, i!.id, st.playhead); });
  }, [toast]);
  const del = useCallback(() => {
    const st = useEditor.getState(); const t = st.timeline; if (!t || !st.selection.length) return;
    const main = T.mainVideoTrack(t)?.id;
    st.mutate((x) => { const ids = st.selection.filter((id) => x.items[id]); const ripple = ids.filter((id) => x.items[id]!.trackId === main); const plain = ids.filter((id) => x.items[id]!.trackId !== main); if (plain.length) T.deleteItems(x, plain); if (ripple.length) T.deleteItems(x, ripple, { ripple: st.magnet }); });
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") { e.preventDefault(); engine.current?.toggle(); }
      else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) useEditor.getState().redo(); else useEditor.getState().undo(); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); del(); }
      else if (e.key.toLowerCase() === "s" && !mod) { e.preventDefault(); split(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const step = e.shiftKey ? 1000 : 1000 / (useEditor.getState().timeline?.fps ?? 30); seek(useEditor.getState().playhead + (e.key === "ArrowLeft" ? -step : step)); }
      else if (e.key === "Home") seek(0);
      else if (e.key === "Escape") useEditor.getState().select([]);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [del, split, seek]);

  if (s.loadError) return <div className="flex h-full items-center justify-center text-center"><div><div className="h2">This project could not be opened</div><p className="mt-1 text-mute">{s.loadError}</p><button className="btn-ghost mt-4" onClick={() => go("/projects")}>Back to projects</button></div></div>;
  if (!tl || !s.project) return <div className="flex h-full items-center justify-center text-mute"><Spinner size={20} /></div>;
  const aspect = CANVAS_PRESETS.find((c) => c.width === tl.size.width && c.height === tl.size.height)?.id ?? "custom";
  const fit = () => { const w = window.innerWidth - 124 - 40; useEditor.setState({ pps: Math.min(400, Math.max(8, (w / Math.max(3000, duration + 1500)) * 1000)) }); };
  return (
    <div className="flex h-full flex-col">
      {/* top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <button className="btn-quiet !px-2" onClick={() => go("/projects")} aria-label="Back to projects"><ArrowLeft size={16} /></button>
        <input className="w-[280px] rounded-md bg-transparent px-2 py-1 text-[14px] font-semibold hover:bg-raised focus:bg-raised" defaultValue={s.project.name} key={s.project.id} aria-label="Project name" onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.project!.name) void api.patchProject(projectId, { name: v }); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <select className="rounded-md border border-line bg-bg px-2 py-1 text-[12px] font-medium" value={aspect} onChange={(e) => s.runTool("resizeCanvas", { aspectRatio: e.target.value })} aria-label="Canvas size">{CANVAS_PRESETS.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}{aspect === "custom" && <option value="custom">{tl.size.width}×{tl.size.height}</option>}</select>
        <div className="ml-auto flex items-center gap-2 text-[12px] text-mute" aria-live="polite">{s.saving === "saving" ? <><Spinner size={12} />Saving</> : s.saving === "error" ? <><CloudOff size={13} className="text-hot" />Not saved</> : s.saving === "saved" ? <><Check size={13} className="text-ok" />Saved</> : null}</div>
        <button className="btn-primary" onClick={() => setExporting(true)} disabled={!duration}><Download size={15} />Export</button>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* left */}
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="flex border-b border-line" role="tablist">{LEFT_TABS.map((t) => <button key={t.id} role="tab" aria-selected={left === t.id} onClick={() => setLeft(t.id)} className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12px] font-semibold ${left === t.id ? "border-b-2 border-accent text-ink" : "border-b-2 border-transparent text-mute hover:text-ink"}`}><t.icon size={13} className={t.id === "ai" && left === t.id ? "text-ai" : ""} />{t.label}</button>)}</div>
          <div className="min-h-0 flex-1">{left === "ai" ? <ChatPanel /> : left === "footage" ? <FootagePanel /> : <TextPanel />}</div>
        </aside>
        {/* centre */}
        <section className="flex min-w-0 flex-1 flex-col">
          <Preview engineRef={engine} />
          <div className="flex h-11 shrink-0 items-center gap-1 border-y border-line bg-panel px-3">
            <button className="btn-quiet !p-1.5" onClick={() => s.undo()} disabled={!s.past.length} aria-label="Undo" title="Undo (Ctrl/⌘ Z)"><Undo2 size={15} /></button>
            <button className="btn-quiet !p-1.5" onClick={() => s.redo()} disabled={!s.future.length} aria-label="Redo" title="Redo (Shift Ctrl/⌘ Z)"><Redo2 size={15} /></button>
            <span className="mx-1 h-5 w-px bg-line" />
            <button className="btn-quiet !p-1.5" onClick={split} aria-label="Split at playhead" title="Split at playhead (S)"><Scissors size={15} /></button>
            <button className="btn-quiet !p-1.5" onClick={del} disabled={!s.selection.length} aria-label="Delete selected" title="Delete (Del)"><Trash2 size={15} /></button>
            <button className={`btn-quiet !p-1.5 ${s.magnet ? "!text-accent" : ""}`} onClick={() => useEditor.setState({ magnet: !s.magnet })} aria-pressed={s.magnet} aria-label="Close gaps on the main track" title="Magnet: deleting on the main track closes the gap"><Magnet size={15} /></button>
            <div className="mx-auto flex items-center gap-2">
              <button className="btn-quiet !p-1.5" onClick={() => seek(0)} aria-label="Back to start"><SkipBack size={15} /></button>
              <button className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-bg hover:bg-white" onClick={() => engine.current?.toggle()} aria-label={s.playing ? "Pause" : "Play"} title="Play / pause (Space)">{s.playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}</button>
              <span className="w-[120px] font-mono text-[12px] tabular-nums text-mute"><span className="text-ink">{fmtTimeFine(s.playhead)}</span> / {fmtTimeFine(duration)}</span>
            </div>
            <button className="btn-quiet !p-1.5" onClick={() => useEditor.setState({ pps: Math.max(8, s.pps / 1.3) })} aria-label="Zoom out"><ZoomOut size={15} /></button>
            <input type="range" min={8} max={400} value={s.pps} onChange={(e) => useEditor.setState({ pps: Number(e.target.value) })} className="w-24 accent-[#c6ff3d]" aria-label="Timeline zoom" />
            <button className="btn-quiet !p-1.5" onClick={() => useEditor.setState({ pps: Math.min(400, s.pps * 1.3) })} aria-label="Zoom in"><ZoomIn size={15} /></button>
            <button className="btn-quiet !p-1.5" onClick={fit} aria-label="Fit timeline" title="Fit the whole edit"><Maximize2 size={14} /></button>
          </div>
          <div className="relative shrink-0" style={{ height: timelineH }}>
            <div className="absolute inset-x-0 -top-1 z-40 h-2 cursor-row-resize" onPointerDown={(e) => { const y0 = e.clientY, h0 = timelineH; const mv = (ev: PointerEvent) => setTimelineH(Math.min(520, Math.max(140, h0 + (y0 - ev.clientY)))); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); }} />
            <TimelineView onSeek={seek} />
          </div>
        </section>
        {/* right */}
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex border-b border-line" role="tablist">{RIGHT_TABS.map((t) => <button key={t.id} role="tab" aria-selected={right === t.id} onClick={() => setRight(t.id)} className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[12px] font-semibold ${right === t.id ? "border-b-2 border-accent text-ink" : "border-b-2 border-transparent text-mute hover:text-ink"}`}><t.icon size={13} />{t.label}</button>)}</div>
          <div className="min-h-0 flex-1">{right === "captions" ? <CaptionsPanel /> : right === "inspect" ? <Inspector /> : <ReportPanel />}</div>
        </aside>
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  );
}
