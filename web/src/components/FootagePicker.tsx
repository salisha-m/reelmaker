import React, { useState } from "react";
import { Check, Film, Music2, Image as ImageIcon, MessageSquareText, AlertTriangle } from "lucide-react";
import type { Asset } from "@shared/types";
import { upload } from "../api";
import { fmtTime, useApp } from "../store";
import { Bar, Dropzone } from "./ui";

export function AssetTile({ a, selected, onToggle, order }: { a: Asset; selected?: boolean; onToggle?: () => void; order?: number }) {
  const busy = a.status === "processing" || a.status === "uploading";
  const words = a.transcription?.segments.flatMap((s) => s.words).length ?? 0;
  const Icon = a.type === "audio" ? Music2 : a.type === "image" ? ImageIcon : Film;
  return (
    <button onClick={onToggle} disabled={!onToggle} className={`group relative overflow-hidden rounded-xl border text-left transition-colors ${selected ? "border-accent" : "border-line hover:border-faint"} bg-panel`} aria-pressed={selected}>
      <div className="relative aspect-video w-full bg-black">
        {a.urls.thumbnail ? <img src={a.urls.thumbnail} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-faint"><Icon size={22} /></div>}
        {a.type !== "image" && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold">{fmtTime(a.durationMs)}</span>}
        {words > 0 && <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-ai"><MessageSquareText size={10} />speech</span>}
        {selected && <span className="absolute left-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accentink">{order ?? <Check size={12} />}</span>}
      </div>
      <div className="p-2">
        <div className="truncate text-[12px] font-medium">{a.name}</div>
        {busy ? <div className="mt-1.5"><Bar value={a.progress} /><div className="mt-1 text-[10px] text-mute">{a.steps.transcript === "running" ? "Transcribing…" : a.steps.scenes === "running" ? "Reading scenes…" : a.steps.proxy === "running" ? "Preparing…" : "Processing…"}</div></div>
          : a.status === "error" ? <div className="mt-0.5 flex items-center gap-1 text-[10px] text-hot"><AlertTriangle size={10} />{a.error ?? "Could not be read"}</div>
          : <div className="mt-0.5 truncate text-[10px] text-mute">{a.contentType === "music" ? `Music${a.rhythm?.averageBpm ? ` · ${Math.round(a.rhythm.averageBpm)} BPM` : ""}` : (a.analysis?.tags ?? []).slice(0, 3).join(" · ") || a.type}</div>}
      </div>
    </button>
  );
}

export function FootagePicker({ selected, onChange, filter }: { selected: string[]; onChange: (ids: string[]) => void; filter?: (a: Asset) => boolean }) {
  const { assets, toast } = useApp();
  const [busy, setBusy] = useState<number | null>(null);
  const shown = assets.filter((a) => (filter ? filter(a) : true));
  const onFiles = async (files: File[]) => {
    setBusy(0);
    try {
      const r = await upload<{ assets: Asset[]; errors: { name: string; error: string }[] }>("/api/assets", files, {}, setBusy);
      for (const e of r.errors ?? []) toast(`${e.name}: ${e.error}`, "error");
      onChange([...selected, ...r.assets.filter((a) => a.contentType !== "music").map((a) => a.id)]);
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  };
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="space-y-3">
      <Dropzone onFiles={onFiles} accept="video/*,image/*,audio/*" label="Drop your clips here" hint="Video, photos and music. Every clip is transcribed and analysed so the edit can be built from what is said and shown." compact={shown.length > 0} busy={busy} />
      {shown.length > 0 && <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">{shown.map((a) => <AssetTile key={a.id} a={a} selected={selected.includes(a.id)} order={selected.includes(a.id) ? selected.indexOf(a.id) + 1 : undefined} onToggle={a.status === "error" ? undefined : () => toggle(a.id)} />)}</div>}
    </div>
  );
}
