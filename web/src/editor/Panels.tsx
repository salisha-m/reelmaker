import React, { useEffect, useRef, useState } from "react";
import { Send, Square, Sparkles, Undo2, Check, CircleAlert, Plus, Music2, Scissors, Type as TypeIcon, Wand2, Copy, Trash2 } from "lucide-react";
import type { Asset, CaptionItem, CaptionStyle, ChatMessage, ChatSegment, MediaItem, TextItem } from "@shared/types";
import * as T from "@shared/timeline";
import { api, streamChat, upload } from "../api";
import { fmtTime, useApp } from "../store";
import { Dropzone, Spinner } from "../components/ui";
import { CaptionPreview } from "../components/CaptionPreview";
import { useEditor } from "./store";

// ---------------- assistant ----------------
const SUGGESTIONS = [
  "Cut this down to the strongest 30 seconds, hook first",
  "Remove every pause, um and restart",
  "Make the captions word by word and highlight the key numbers",
  "Add the music at low volume and duck it under my voice",
];
function Segments({ segs }: { segs: ChatSegment[] }) {
  return <>{segs.map((s, i) => s.type === "text" ? <p key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed">{s.text}</p>
    : s.type === "tool" ? <div key={i} className="flex items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12px]">{s.status === "running" ? <Spinner size={12} /> : s.status === "error" ? <CircleAlert size={12} className="text-warn" /> : <Check size={12} className="text-ok" />}<span className="font-medium">{s.label}</span>{s.summary && s.status !== "running" && <span className="truncate text-mute">{s.summary}</span>}</div>
    : s.type === "notice" ? <p key={i} className="rounded-lg bg-warn/10 px-2.5 py-1.5 text-[12px] text-warn">{s.text}</p> : null)}</>;
}
export function ChatPanel() {
  const { projectId, selection, playhead } = useEditor();
  const { status, toast } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<ChatSegment[] | null>(null);
  const [text, setText] = useState("");
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const ai = status?.ai.backend !== "none";
  useEffect(() => { if (projectId) api.chat(projectId).then((r) => setMessages(r.messages)).catch(() => undefined); }, [projectId]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages, live]);
  const send = async (msg: string) => {
    if (!projectId || !msg.trim() || live) return;
    setText("");
    setMessages((m) => [...m, { id: `tmp${Date.now()}`, role: "user", createdAt: new Date().toISOString(), segments: [{ type: "text", text: msg }] }]);
    const segs: ChatSegment[] = [];
    setLive([]);
    abort.current = new AbortController();
    try {
      await streamChat(projectId, { message: msg, selection, playheadMs: playhead }, (e) => {
        if (e.type === "text") { const last = segs[segs.length - 1]; if (last?.type === "text") last.text += e.delta; else segs.push({ type: "text", text: e.delta }); }
        else if (e.type === "tool") { const cur = segs.find((x) => x.type === "tool" && x.id === e.id) as Extract<ChatSegment, { type: "tool" }> | undefined; if (cur) { cur.status = e.status; cur.summary = e.summary; } else segs.push({ type: "tool", id: e.id, name: e.name, label: e.label, status: e.status, summary: e.summary }); }
        else if (e.type === "done") { setMessages((m) => [...m, e.message]); setLive(null); return; }
        else if (e.type === "error") { toast(e.message, "error"); setLive(null); return; }
        setLive([...segs]);
      }, abort.current.signal);
    } catch (e) { if ((e as Error).name !== "AbortError") toast((e as Error).message, "error"); }
    setLive(null);
  };
  const revert = async (turnId: string) => { if (!projectId) return; try { const r = await api.revert(projectId, turnId); setMessages(r.messages); useEditor.getState().applyServer(r.timeline); } catch (e) { toast((e as Error).message, "error"); } };
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {!messages.length && !live && (
          <div className="pt-2">
            <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold"><Sparkles size={15} className="text-ai" />Tell me the edit</div>
            <p className="mb-3 text-[12px] leading-relaxed text-mute">{ai ? "I have read every word and every shot of your footage. Say what you want in plain words and watch the timeline change. Select a clip or move the playhead to point at something." : "No AI model is connected on this server, so the assistant is off. Autopilot, captions, beat sync and export all work without it."}</p>
            {ai && <div className="space-y-1.5">{SUGGESTIONS.map((s) => <button key={s} onClick={() => void send(s)} className="block w-full rounded-lg border border-line bg-bg px-3 py-2 text-left text-[12px] leading-snug text-mute hover:border-faint hover:text-ink">{s}</button>)}</div>}
          </div>
        )}
        {messages.map((m) => m.role === "user" ? <div key={m.id} className="ml-6 rounded-2xl rounded-br-md bg-raised px-3 py-2 text-[13px] leading-relaxed">{m.segments.map((s) => (s.type === "text" ? s.text : "")).join("")}</div> : (
          <div key={m.id} className={`space-y-1.5 ${m.reverted ? "opacity-50" : ""}`}>
            <Segments segs={m.segments} />
            {m.revertable && m.turnId && <button onClick={() => revert(m.turnId!)} className="flex items-center gap-1.5 text-[11px] font-medium text-mute hover:text-ink"><Undo2 size={11} />Undo this change</button>}
          </div>
        ))}
        {live && <div className="space-y-1.5"><Segments segs={live} />{!live.length && <div className="flex items-center gap-2 text-[12px] text-mute"><span className="dot-pulse inline-block h-1.5 w-1.5 rounded-full bg-ai" />Reading the timeline…</div>}</div>}
        <div ref={end} />
      </div>
      <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        {selection.length > 0 && <div className="mb-1.5 text-[11px] text-mute">Pointing at: <span className="text-accent">{selection.slice(0, 3).join(", ")}{selection.length > 3 ? ` +${selection.length - 3}` : ""}</span></div>}
        <div className="flex items-end gap-2">
          <textarea className="field max-h-32 min-h-[40px] flex-1 resize-none" rows={1} placeholder={ai ? "Describe the edit…" : "Assistant unavailable"} disabled={!ai} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} aria-label="Message the assistant" />
          {live ? <button type="button" className="btn-ghost !px-2.5" onClick={() => abort.current?.abort()} aria-label="Stop"><Square size={14} /></button> : <button className="btn-ai !px-2.5" disabled={!text.trim() || !ai} aria-label="Send"><Send size={14} /></button>}
        </div>
      </form>
    </div>
  );
}

// ---------------- footage / sound / text ----------------
export function FootagePanel() {
  const { assets, projectId, playhead, timeline } = useEditor();
  const { toast } = useApp();
  const [busy, setBusy] = useState<number | null>(null);
  const run = useEditor.getState().runTool;
  const onFiles = async (files: File[]) => {
    if (!projectId) return;
    setBusy(0);
    try { const r = await upload<{ assets: Asset[] }>("/api/assets", files, { projectId }, setBusy); const p = await api.project(projectId); useEditor.getState().setAssets(p.assets); toast(`${r.assets.length} file${r.assets.length === 1 ? "" : "s"} added. They can be used once processed.`, "ok"); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  };
  const add = async (a: (typeof assets)[number], where: "end" | "playhead") => {
    if (a.type === "audio") { await run("addMusic", { assetId: a.agentId }); return; }
    const main = timeline ? T.mainVideoTrack(timeline) : null;
    if (where === "end" || !timeline || !main) await run("addMedia", { items: [{ assetId: a.agentId }] });
    else { const under = T.itemsOnTrack(timeline, main.id).find((i) => playhead > i.display.from && playhead < i.display.to); await run("addMedia", { items: [{ assetId: a.agentId, ...(a.type === "image" ? { duration: 3 } : {}) }], trackId: main.id, timelineStart: (under ? under.display.to : playhead) / 1000, ripple: true }); }
  };
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <Dropzone onFiles={onFiles} accept="video/*,image/*,audio/*" label="Add files" compact busy={busy} />
      {assets.map((a) => {
        const used = timeline ? Object.values(timeline.items).filter((i) => T.isMedia(i) && i.assetId === a.id).length : 0;
        return (
          <div key={a.id} className="flex gap-2.5 rounded-xl border border-line bg-bg p-2">
            <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-black">{a.urls.thumbnail ? <img src={a.urls.thumbnail} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-faint"><Music2 size={16} /></div>}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium">{a.name}</div>
              <div className="text-[10px] text-mute">{a.agentId} · {a.type === "image" ? "image" : fmtTime(a.durationMs)}{used ? ` · used ${used}×` : ""}</div>
              {a.status !== "ready" ? <div className="mt-1 flex items-center gap-1.5 text-[10px] text-accent"><Spinner size={10} />processing {Math.round(a.progress * 100)}%</div> : (
                <div className="mt-1 flex gap-1"><button className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold hover:bg-line" onClick={() => add(a, "end")}>{a.type === "audio" ? "Use as music" : "Add at end"}</button>{a.type !== "audio" && <button className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold hover:bg-line" onClick={() => add(a, "playhead")}>Insert at playhead</button>}</div>
              )}
            </div>
          </div>
        );
      })}
      {!assets.length && <p className="text-center text-[12px] text-mute">This project has no footage yet.</p>}
    </div>
  );
}

const TEXT_PRESETS: { name: string; input: Record<string, unknown> }[] = [
  { name: "Hook box", input: { position: "top", fontFamily: "TikTok Sans", fontWeight: 800, fontSize: 64, color: "#111111", backgroundColor: "#FFFFFF", animationIn: "pop" } },
  { name: "Bold title", input: { position: "center", fontFamily: "Montserrat", fontWeight: 900, fontSize: 110, uppercase: true, color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 10, animationIn: "pop" } },
  { name: "Tall caps", input: { position: "center", fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 150, uppercase: true, color: "#FFFFFF", strokeColor: null, animationIn: "fade" } },
  { name: "Yellow label", input: { position: "top", fontFamily: "Montserrat", fontWeight: 900, fontSize: 60, uppercase: true, color: "#111111", backgroundColor: "#FFE600", animationIn: "slide-up" } },
  { name: "Lower third", input: { position: "lower-third", role: "lower-third", fontFamily: "Inter", fontWeight: 700, fontSize: 44, color: "#FFFFFF", backgroundColor: "rgba(12,12,12,0.85)", animationIn: "slide-left" } },
  { name: "Soft serif", input: { position: "center", fontFamily: "Instrument Serif Italic", fontWeight: 400, fontSize: 96, color: "#FBF6EC", strokeColor: null, animationIn: "fade" } },
];
export function TextPanel() {
  const { playhead, timeline } = useEditor();
  const [text, setText] = useState("Your text here");
  const k = timeline ? Math.min(timeline.size.width, timeline.size.height) / 1080 : 1;
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <div><label className="label" htmlFor="newtext">Text</label><textarea id="newtext" className="field min-h-[56px] resize-none" value={text} onChange={(e) => setText(e.target.value)} /></div>
      <div className="grid grid-cols-2 gap-2">
        {TEXT_PRESETS.map((p) => (
          <button key={p.name} className="rounded-xl border border-line bg-bg p-3 text-left hover:border-faint" onClick={() => useEditor.getState().runTool("addText", { ...p.input, fontSize: Math.round((p.input.fontSize as number) * k), text: text.trim() || "Your text here", startSeconds: playhead / 1000, durationSeconds: 3 })}>
            <TypeIcon size={15} className="text-accent" /><div className="mt-2 text-[12px] font-semibold">{p.name}</div>
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-mute">Text is added at the playhead for 3 seconds. Drag it on the canvas to place it, and its edges on the timeline to change how long it shows.</p>
    </div>
  );
}

// ---------------- right side: captions, inspector, report ----------------
export function CaptionsPanel() {
  const { timeline } = useEditor();
  const { catalog } = useApp();
  const run = useEditor.getState().runTool;
  const [busy, setBusy] = useState<string | null>(null);
  const track = timeline?.tracks.find((t) => t.kind === "caption");
  const count = timeline && track ? T.itemsOnTrack(timeline, track.id).length : 0;
  const st = track?.captionStyle as CaptionStyle | undefined;
  const current = catalog?.captionLooks.find((c) => st && c.style.fontFamily === st.fontFamily && c.style.mode === st.mode && (c.style.highlightStyle ?? "color") === (st.highlightStyle ?? "color") && !!c.style.lineBackground === !!st.lineBackground)?.id;
  const apply = async (id: string) => { setBusy(id); await run(count ? "editCaptions" : "addCaptions", { look: id }); setBusy(null); };
  const patch = (p: Partial<CaptionStyle>) => useEditor.getState().mutate((tl) => { const t = tl.tracks.find((x) => x.kind === "caption"); if (t?.captionStyle) Object.assign(t.captionStyle, p); });
  return (
    <div className="h-full space-y-4 overflow-y-auto p-3">
      <div className="flex items-center justify-between"><div className="text-[12px] text-mute">{count ? `${count} captions on the timeline` : "No captions yet"}</div>{count > 0 && <button className="text-[11px] font-medium text-mute hover:text-hot" onClick={() => useEditor.getState().mutate((tl) => { for (const i of Object.values(tl.items)) if (i.type === "caption") delete tl.items[i.id]; })}>Remove all</button>}</div>
      <div className="grid grid-cols-2 gap-2">
        {catalog?.captionLooks.map((c) => (
          <button key={c.id} onClick={() => apply(c.id)} disabled={!!busy} className={`overflow-hidden rounded-xl border text-left ${current === c.id && count ? "border-accent" : "border-line hover:border-faint"}`} title={`${c.description}\nSeen in: ${c.seenIn}`}>
            <div className="relative"><CaptionPreview style={c.style} width={132} height={54} animate={false} />{busy === c.id && <div className="absolute inset-0 flex items-center justify-center bg-black/50"><Spinner /></div>}</div>
            <div className="px-2 py-1.5"><div className="truncate text-[11px] font-semibold">{c.name}</div><div className="truncate text-[9px] text-mute">{c.seenIn}</div></div>
          </button>
        ))}
      </div>
      {st && count > 0 && (
        <div className="space-y-3 border-t border-line pt-3">
          <div><div className="label">Position</div><input type="range" min={0.1} max={0.9} step={0.01} value={st.position} onChange={(e) => patch({ position: Number(e.target.value) })} className="w-full accent-[#c6ff3d]" aria-label="Caption position" /></div>
          <div><div className="label">Size</div><input type="range" min={30} max={160} step={1} value={st.fontSize} onChange={(e) => patch({ fontSize: Number(e.target.value) })} className="w-full accent-[#c6ff3d]" aria-label="Caption size" /></div>
          <div className="grid grid-cols-3 gap-2">
            <div><div className="label">Text</div><input type="color" value={st.color} onChange={(e) => patch({ color: e.target.value })} className="h-8 w-full cursor-pointer rounded border border-line bg-bg" aria-label="Text colour" /></div>
            <div><div className="label">Spoken</div><input type="color" value={st.highlightStyle === "box" ? st.highlightBox?.color ?? "#8B5CF6" : st.highlightColor} onChange={(e) => patch(st.highlightStyle === "box" ? { highlightBox: { ...st.highlightBox!, color: e.target.value } } : { highlightColor: e.target.value })} className="h-8 w-full cursor-pointer rounded border border-line bg-bg" aria-label="Spoken word colour" /></div>
            <div><div className="label">Key words</div><input type="color" value={st.emphasisColor} onChange={(e) => patch({ emphasisColor: e.target.value })} className="h-8 w-full cursor-pointer rounded border border-line bg-bg" aria-label="Emphasis colour" /></div>
          </div>
          <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" className="accent-[#c6ff3d]" checked={st.textTransform === "uppercase"} onChange={(e) => patch({ textTransform: e.target.checked ? "uppercase" : "none" })} />ALL CAPS</label>
          <p className="text-[11px] leading-relaxed text-mute">Click a caption on the timeline to fix a word or mark the words that should pop.</p>
        </div>
      )}
    </div>
  );
}

function Num({ label, value, onChange, step = 1, min, max, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return <label className="block"><span className="label">{label}</span><div className="relative"><input type="number" className="field" value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0} step={step} min={min} max={max} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(v); }} />{suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-faint">{suffix}</span>}</div></label>;
}
export function Inspector() {
  const { timeline, selection, assetMap } = useEditor();
  const { catalog } = useApp();
  const { mutate, runTool } = useEditor.getState();
  if (!timeline || selection.length !== 1) return <div className="p-4 text-[12px] leading-relaxed text-mute">{selection.length > 1 ? `${selection.length} items selected. Drag to move them together, or press Delete.` : "Select a clip, text or caption on the timeline or the canvas to change it."}</div>;
  const it = timeline.items[selection[0]!];
  if (!it) return null;
  const edit = (fn: (x: any) => void) => mutate((tl) => fn(tl.items[it.id]));
  const head = <div className="mb-3 flex items-center justify-between"><div><div className="text-[13px] font-semibold capitalize">{it.type === "motionGraphic" ? "Motion graphic" : it.type}</div><div className="text-[11px] text-mute">{it.id} · {(it.display.from / 1000).toFixed(2)}s – {(it.display.to / 1000).toFixed(2)}s</div></div><div className="flex gap-1"><button className="btn-quiet !p-1.5" aria-label="Duplicate" onClick={() => mutate((tl) => { T.cloneItem(tl as any, it.id, { atMs: T.itemsOnTrack(tl, it.trackId).at(-1)!.display.to }); })}><Copy size={13} /></button><button className="btn-quiet !p-1.5" aria-label="Delete" onClick={() => mutate((tl) => { T.deleteItems(tl, [it.id]); })}><Trash2 size={13} /></button></div></div>;
  if (T.isMedia(it)) {
    const a = assetMap[it.assetId];
    const m = it as MediaItem;
    const speech = (a?.transcription?.segments.length ?? 0) > 0;
    return (
      <div className="h-full space-y-3 overflow-y-auto p-3">{head}
        <div className="truncate rounded-lg bg-bg px-2.5 py-1.5 text-[11px] text-mute">{a?.name}</div>
        {it.type !== "image" && <>
          <div><div className="label flex justify-between"><span>Volume</span><span className="text-ink">{Math.round(m.volume * 100)}%{m.keyframes?.volume ? " · ducked" : ""}</span></div><input type="range" min={0} max={2} step={0.01} value={m.volume} onChange={(e) => edit((x) => { x.volume = Number(e.target.value); x.muted = false; if (x.keyframes) delete x.keyframes.volume; })} className="w-full accent-[#c6ff3d]" aria-label="Volume" /></div>
          <div className="grid grid-cols-2 gap-2"><Num label="Fade in" suffix="s" step={0.1} min={0} value={m.fadeInMs / 1000} onChange={(v) => edit((x) => { x.fadeInMs = Math.max(0, v) * 1000; })} /><Num label="Fade out" suffix="s" step={0.1} min={0} value={m.fadeOutMs / 1000} onChange={(v) => edit((x) => { x.fadeOutMs = Math.max(0, v) * 1000; })} /></div>
          <div><div className="label flex justify-between"><span>Speed</span><span className="text-ink">{m.playbackRate.toFixed(2)}×</span></div><div className="flex gap-1">{[0.5, 1, 1.5, 2, 4].map((r) => <button key={r} onClick={() => runTool("setSpeed", { itemId: it.id, speed: r, ripple: true })} className={`flex-1 rounded-md border py-1 text-[11px] font-semibold ${Math.abs(m.playbackRate - r) < 0.01 ? "border-accent text-accent" : "border-line text-mute hover:text-ink"}`}>{r}×</button>)}</div></div>
          <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" className="accent-[#c6ff3d]" checked={m.muted} onChange={(e) => edit((x) => { x.muted = e.target.checked; })} />Mute this clip</label>
        </>}
        {it.type !== "audio" && <>
          <div><div className="label flex justify-between"><span>Zoom</span><span className="text-ink">{Math.round(m.transform.scale * 100)}%</span></div><input type="range" min={0.2} max={3} step={0.01} value={m.transform.scale} onChange={(e) => edit((x) => { x.transform.scale = Number(e.target.value); })} className="w-full accent-[#c6ff3d]" aria-label="Zoom" /></div>
          <div className="grid grid-cols-2 gap-2"><Num label="X" suffix="px" value={m.transform.x} onChange={(v) => edit((x) => { x.transform.x = v; })} /><Num label="Y" suffix="px" value={m.transform.y} onChange={(v) => edit((x) => { x.transform.y = v; })} /></div>
          <div><div className="label">Framing</div><div className="flex gap-1">{(["cover", "contain"] as const).map((f) => <button key={f} onClick={() => edit((x) => { x.transform.fit = f; })} className={`flex-1 rounded-md border py-1 text-[11px] font-semibold ${m.transform.fit === f ? "border-accent text-accent" : "border-line text-mute"}`}>{f === "cover" ? "Fill frame" : "Fit inside"}</button>)}</div></div>
          <div><label className="label" htmlFor="filter">Colour filter</label><select id="filter" className="field" value={m.filter?.id ?? ""} onChange={(e) => edit((x) => { x.filter = e.target.value ? { id: e.target.value, strength: x.filter?.strength ?? 80 } : null; })}><option value="">None</option>{catalog?.filters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>{m.filter && <input type="range" min={0} max={100} value={m.filter.strength} onChange={(e) => edit((x) => { x.filter.strength = Number(e.target.value); })} className="mt-2 w-full accent-[#c6ff3d]" aria-label="Filter strength" />}</div>
        </>}
        {speech && <button className="btn-ghost w-full" onClick={async () => { const r = await runTool("cutDeadSpace", { itemIds: [it.id] }); if (r?.ok) useApp.getState().toast(r.cuts ? `${r.cuts} cuts, ${r.removedSeconds}s removed` : "Nothing to remove", "ok"); }}><Scissors size={14} />Remove pauses and fillers</button>}
      </div>
    );
  }
  if (it.type === "text") {
    const t = it as TextItem;
    return (
      <div className="h-full space-y-3 overflow-y-auto p-3">{head}
        <div><label className="label" htmlFor="txt">Text</label><textarea id="txt" className="field min-h-[64px] resize-none" value={t.text} onChange={(e) => edit((x) => { x.text = e.target.value; })} /></div>
        <div><label className="label" htmlFor="font">Font</label><select id="font" className="field" value={`${t.style.fontFamily}|${t.style.fontWeight}`} onChange={(e) => { const [f, w] = e.target.value.split("|"); edit((x) => { x.style.fontFamily = f; x.style.fontWeight = Number(w); }); }}>{catalog?.fonts.map((f) => <option key={f.key} value={`${f.family}|${f.weight}`}>{f.family} {f.weight}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-2"><Num label="Size" suffix="px" value={t.style.fontSize} min={8} onChange={(v) => edit((x) => { x.style.fontSize = Math.max(8, v); })} /><Num label="Outline" suffix="px" value={t.style.strokeWidth} min={0} onChange={(v) => edit((x) => { x.style.strokeWidth = Math.max(0, v); if (v > 0 && !x.style.strokeColor) x.style.strokeColor = "#000000"; })} /></div>
        <div className="grid grid-cols-3 gap-2">
          <div><div className="label">Colour</div><input type="color" value={t.style.color} onChange={(e) => edit((x) => { x.style.color = e.target.value; })} className="h-8 w-full cursor-pointer rounded border border-line bg-bg" aria-label="Text colour" /></div>
          <div><div className="label">Outline</div><input type="color" value={t.style.strokeColor ?? "#000000"} onChange={(e) => edit((x) => { x.style.strokeColor = e.target.value; })} className="h-8 w-full cursor-pointer rounded border border-line bg-bg" aria-label="Outline colour" /></div>
          <div><div className="label">Box</div><input type="color" value={t.style.background?.color?.startsWith("#") ? t.style.background.color : "#ffffff"} onChange={(e) => edit((x) => { x.style.background = { color: e.target.value, paddingX: Math.round(x.style.fontSize * 0.4), paddingY: Math.round(x.style.fontSize * 0.22), radius: Math.round(x.style.fontSize * 0.28) }; })} className="h-8 w-full cursor-pointer rounded border border-line bg-bg" aria-label="Box colour" /></div>
        </div>
        <div className="flex flex-wrap gap-3 text-[12px]"><label className="flex items-center gap-2"><input type="checkbox" className="accent-[#c6ff3d]" checked={t.style.textTransform === "uppercase"} onChange={(e) => edit((x) => { x.style.textTransform = e.target.checked ? "uppercase" : "none"; })} />ALL CAPS</label><label className="flex items-center gap-2"><input type="checkbox" className="accent-[#c6ff3d]" checked={!!t.style.background} onChange={(e) => edit((x) => { x.style.background = e.target.checked ? { color: "#FFFFFF", paddingX: Math.round(x.style.fontSize * 0.4), paddingY: Math.round(x.style.fontSize * 0.22), radius: Math.round(x.style.fontSize * 0.28) } : null; })} />Box</label></div>
        <div><label className="label" htmlFor="anim">Entrance</label><select id="anim" className="field" value={t.animation.in} onChange={(e) => edit((x) => { x.animation.in = e.target.value; })}>{["none", "pop", "fade", "slide-up", "slide-left", "typewriter", "word-reveal"].map((a) => <option key={a} value={a}>{a}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-2"><Num label="X" suffix="px" value={t.transform.x} onChange={(v) => edit((x) => { x.transform.x = v; })} /><Num label="Y" suffix="px" value={t.transform.y} onChange={(v) => edit((x) => { x.transform.y = v; })} /></div>
      </div>
    );
  }
  if (it.type === "caption") {
    const c = it as CaptionItem;
    return (
      <div className="h-full space-y-3 overflow-y-auto p-3">{head}
        <div><div className="label">Words · click to make one pop</div><div className="flex flex-wrap gap-1.5">{c.words.map((w, i) => <button key={i} onClick={() => edit((x) => { x.words[i].emphasis = !x.words[i].emphasis || undefined; })} className={`rounded-md border px-2 py-1 text-[12px] font-semibold ${w.emphasis ? "border-accent bg-accent/15 text-accent" : "border-line text-ink hover:border-faint"}`}>{w.text}</button>)}</div></div>
        <div><label className="label" htmlFor="captxt">Fix the text</label><input id="captxt" className="field" defaultValue={c.words.map((w) => w.text).join(" ")} key={it.id + c.words.length} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== c.words.map((w) => w.text).join(" ")) void runTool("editProperties", { itemIds: [it.id], properties: { text: v } }); }} /><p className="mt-1 text-[11px] text-mute">Keep the same number of words to keep the timing exact.</p></div>
        <p className="text-[11px] leading-relaxed text-mute">Captions follow their clip: move, trim or delete the clip and the captions go with it. The look is set for the whole track in the Captions tab.</p>
      </div>
    );
  }
  return <div className="p-3">{head}<p className="text-[12px] text-mute">Ask the assistant to change this item.</p></div>;
}

export function ReportPanel() {
  const { project } = useEditor();
  const r = project?.report;
  const { toast } = useApp();
  if (!r) return <div className="p-4 text-[12px] leading-relaxed text-mute">This project was started by hand. Projects made with Autopilot show what was built and why here.</div>;
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3 py-1.5 text-[12px]"><span className="text-mute">{k}</span><span className="text-right font-medium">{v}</span></div>;
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold"><Wand2 size={14} className="text-accent" />What Autopilot built</div>
      <div className="divide-y divide-line rounded-xl border border-line bg-bg px-3">
        <Row k="Type" v={r.mode === "talking" ? "Talking edit" : "Montage"} /><Row k="Length" v={`${r.durationSeconds.toFixed(1)}s`} /><Row k="Clips" v={`${r.clips}${r.brollInserts ? ` + ${r.brollInserts} b-roll` : ""}`} />
        {r.cutsRemoved > 0 && <Row k="Tightened" v={`${r.cutsRemoved} cuts, ${r.secondsRemoved}s removed`} />}
        {r.captions > 0 && <Row k="Captions" v={`${r.captions} · ${r.captionLook}`} />}{r.music && <Row k="Sound" v={<span className="break-all">{r.music}</span>} />}<Row k="Planned by" v={r.planner === "ai" ? "AI" : "Rules"} />
      </div>
      {r.hook && <div><div className="label">Hook</div><p className="text-[13px] leading-snug">“{r.hook}”</p></div>}
      {r.notes.length > 0 && <div><div className="label">Notes</div><ul className="space-y-1 text-[12px] leading-snug text-mute">{r.notes.map((n, i) => <li key={i}>• {n}</li>)}</ul></div>}
      {(r.postCaption || r.hashtags.length > 0) && <div><div className="label">Post with</div><div className="rounded-xl border border-line bg-bg p-3 text-[12px] leading-relaxed">{r.postCaption} <span className="text-ai">{r.hashtags.map((h) => `#${h}`).join(" ")}</span></div><button className="btn-quiet mt-1 !px-2 !py-1 !text-[11px]" onClick={() => { void navigator.clipboard.writeText(`${r.postCaption} ${r.hashtags.map((h) => `#${h}`).join(" ")}`.trim()); toast("Copied", "ok"); }}><Copy size={11} />Copy</button></div>}
    </div>
  );
}
export const _unused = { Plus };
