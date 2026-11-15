import React, { useState } from "react";
import { Clapperboard, FolderOpen, Trash2, Search, Plus, Wand2, Download } from "lucide-react";
import type { Asset } from "@shared/types";
import { api, upload, type SearchHit } from "../api";
import { fmtBytes, fmtTime, go, useApp } from "../store";
import { Dropzone, Empty, Modal } from "../components/ui";
import { AssetTile } from "../components/FootagePicker";

export function Projects() {
  const { projects, renders, toast, refresh } = useApp();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <div className="mb-6 flex items-end justify-between"><div><h1 className="h1">Projects</h1><p className="mt-1 text-[13px] text-mute">Every edit stays open for changes: by hand on the timeline, or by telling the assistant what you want.</p></div>
          <div className="flex gap-2"><button className="btn-ghost" onClick={async () => { const r = await api.createProject({ name: "Untitled project" }); void refresh("projects"); go(`/p/${r.project.id}`); }}><Plus size={15} />Blank project</button><button className="btn-primary" onClick={() => go("/create")}><Wand2 size={15} />New with Autopilot</button></div></div>
        {!projects.length ? <Empty icon={<Clapperboard size={30} />} title="No projects yet">Autopilot builds your first one from a trend and your clips in under a minute.</Empty> : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {projects.map((p) => {
              const done = renders.filter((r) => r.projectId === p.id && r.status === "completed").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
              return (
                <div key={p.id} className="card group overflow-hidden">
                  <button className="block w-full text-left" onClick={() => go(`/p/${p.id}`)}>
                    <div className="aspect-[9/13] bg-black">{p.thumbnail ? <img src={p.thumbnail} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-faint"><Clapperboard size={24} /></div>}</div>
                    <div className="p-3 pb-1"><div className="line-clamp-2 text-[13px] font-semibold leading-snug">{p.name}</div><div className="mt-0.5 text-[11px] text-mute">{fmtTime(p.durationMs)} · {new Date(p.updatedAt).toLocaleDateString()}</div></div>
                  </button>
                  <div className="flex items-center justify-between px-2 pb-2">
                    {done?.url ? <a className="btn-quiet !px-2 !py-1 !text-[11px]" href={`${done.url}?download=${encodeURIComponent(done.filename)}`}><Download size={12} />{fmtBytes(done.sizeBytes)}</a> : <span />}
                    <button className="btn-quiet !px-2 !py-1 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Delete project" onClick={async () => { if (!confirm(`Delete "${p.name}"? The footage stays in your library.`)) return; await api.deleteProject(p.id); toast("Project deleted"); }}><Trash2 size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function Library() {
  const { assets, toast } = useApp();
  const [busy, setBusy] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [open, setOpen] = useState<Asset | null>(null);
  const onFiles = async (files: File[]) => { setBusy(0); try { const r = await upload<{ assets: Asset[]; errors: { name: string; error: string }[] }>("/api/assets", files, {}, setBusy); for (const e of r.errors ?? []) toast(`${e.name}: ${e.error}`, "error"); } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); } };
  const search = async (v: string) => { setQ(v); if (v.trim().length < 2) return setHits(null); try { setHits((await api.search(v.trim())).hits); } catch { setHits([]); } };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <div className="mb-6"><h1 className="h1">Footage</h1><p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-mute">Everything you upload is transcribed word by word and analysed shot by shot, so edits can be built from what is said and shown. Search finds the moment, not just the file.</p></div>
        <Dropzone onFiles={onFiles} accept="video/*,image/*,audio/*" label="Drop clips, photos or music" hint="MP4, MOV, WebM, MKV · JPG, PNG, WebP · MP3, WAV, M4A" compact busy={busy} />
        <div className="relative mt-4"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-9" placeholder="Search what was said or shown: “pricing”, “coffee”, “gym”…" value={q} onChange={(e) => void search(e.target.value)} aria-label="Search footage" /></div>
        {hits ? (
          <div className="card mt-4 divide-y divide-line">{hits.length ? hits.map((h, i) => <div key={i} className="flex items-start gap-3 p-3"><span className={`chip shrink-0 ${h.kind === "said" ? "!text-ai" : "!text-accent"}`}>{h.kind}</span><div className="min-w-0"><div className="text-[13px] leading-snug">{h.text}</div><div className="mt-0.5 text-[11px] text-mute">{h.name} · {h.fromSeconds.toFixed(1)}s – {h.toSeconds.toFixed(1)}s</div></div></div>) : <div className="p-6 text-center text-[13px] text-mute">Nothing matches “{q}”.</div>}</div>
        ) : !assets.length ? <div className="mt-6"><Empty icon={<FolderOpen size={30} />} title="No footage yet">Upload a few clips to get started. Talking clips, b-roll and a music track cover most formats.</Empty></div>
          : <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">{assets.map((a) => <AssetTile key={a.id} a={a} onToggle={() => setOpen(a)} />)}</div>}
      </div>
      {open && (
        <Modal title={open.name} onClose={() => setOpen(null)} wide footer={<button className="btn-quiet mr-auto text-hot hover:text-hot" onClick={async () => { await api.deleteAsset(open.id); setOpen(null); }}><Trash2 size={14} />Delete</button>}>
          <div className="grid gap-5 md:grid-cols-[300px_1fr]">
            <div>{open.type === "video" && open.urls.proxy ? <video src={open.urls.proxy} controls className="w-full rounded-xl bg-black" /> : open.type === "image" ? <img src={open.urls.original} alt="" className="w-full rounded-xl" /> : open.urls.proxy ? <audio src={open.urls.proxy} controls className="w-full" /> : null}
              <div className="mt-3 text-[12px] text-mute">{open.width ? `${open.width}×${open.height} · ` : ""}{fmtTime(open.durationMs)} · {fmtBytes(open.size)}{open.rhythm?.averageBpm && open.contentType === "music" ? ` · ${Math.round(open.rhythm.averageBpm)} BPM` : ""}</div>
              {open.analysis && <div className="mt-2 flex flex-wrap gap-1">{open.analysis.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>}</div>
            <div className="min-w-0 space-y-4">
              {open.analysis?.summary && <div><div className="label">Summary</div><p className="text-[13px] leading-relaxed">{open.analysis.summary}</p></div>}
              {open.transcription && <div><div className="label">Transcript</div><div className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-line bg-bg p-3 text-[13px] leading-relaxed">{open.transcription.segments.map((s) => <p key={s.id}><span className="mr-2 font-mono text-[11px] text-faint">{s.start.toFixed(1)}s</span>{s.text}</p>)}</div></div>}
              {(open.analysis?.segments.length ?? 0) > 0 && <div><div className="label">Scenes</div><div className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-line bg-bg p-3 text-[12px] leading-relaxed text-mute">{open.analysis!.segments.map((s, i) => <p key={i}><span className="mr-2 font-mono text-[11px] text-faint">{s.start_time.toFixed(1)}–{s.end_time.toFixed(1)}s</span>{s.description}</p>)}</div></div>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
