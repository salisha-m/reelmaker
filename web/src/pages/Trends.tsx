import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Play, Pause, Music2, Eye, Heart, Trash2, Wand2, Link2, Radar, RefreshCw, Scissors, MessageSquareQuote, Type, Clock, Flame, Sparkles } from "lucide-react";
import type { TrendCandidate, TrendPost, TrendSound, WatchSource } from "@shared/trends";
import { captionTemplate } from "@shared/catalog";
import { api, upload } from "../api";
import { fmtCount, fmtTime, go, useApp } from "../store";
import { Dropzone, Empty, Modal, PLATFORM, Segmented, Spinner } from "../components/ui";
import { CaptionPreview } from "../components/CaptionPreview";

const FORMAT: Record<string, string> = { "talking-head": "Talking head", "voiceover-broll": "Voiceover + b-roll", montage: "Montage", "text-on-video": "Text on video", mixed: "Mixed" };
const STATUS: Record<string, string> = { downloading: "Importing…", processing: "Reading the video…", analyzing: "Breaking it down…", error: "Failed" };

function ScoreBadge({ score }: { score: number }) {
  return <span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-bold text-accent backdrop-blur"><Flame size={11} />{score}</span>;
}

function TrendCard({ t, onOpen }: { t: TrendPost; onOpen: () => void }) {
  const b = t.blueprint;
  const p = PLATFORM[t.source.platform] ?? PLATFORM.link!;
  return (
    <button onClick={onOpen} className="card group overflow-hidden text-left transition-colors hover:border-faint">
      <div className="relative aspect-[9/13] w-full overflow-hidden bg-black">
        {t.urls.thumbnail ? <img src={t.urls.thumbnail} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" /> : <div className="flex h-full items-center justify-center text-faint"><Spinner size={18} /></div>}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2.5">
          <span className="rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold backdrop-blur" style={{ color: p.color }}>{p.label}</span>
          {t.status === "ready" && <ScoreBadge score={t.viralScore} />}
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3 pt-10">
          {t.status !== "ready" ? <div className={`flex items-center gap-2 text-[12px] font-semibold ${t.status === "error" ? "text-hot" : "text-accent"}`}>{t.status !== "error" && <Spinner size={12} />}{STATUS[t.status]}</div>
            : <div className="flex items-center gap-3 text-[12px] font-semibold text-white"><span className="flex items-center gap-1"><Eye size={12} />{fmtCount(t.stats.views)}</span><span className="flex items-center gap-1"><Heart size={12} />{fmtCount(t.stats.likes)}</span><span className="ml-auto">{fmtTime(t.durationMs)}</span></div>}
        </div>
      </div>
      <div className="p-3">
        <div className="line-clamp-2 text-[13px] font-semibold leading-snug">{t.title}</div>
        {t.source.handle && <div className="mt-0.5 text-[12px] text-mute">@{t.source.handle}</div>}
        {t.status === "error" && <div className="mt-1.5 line-clamp-3 text-[12px] text-hot">{t.error}</div>}
        {b && <div className="mt-2 flex flex-wrap gap-1"><span className="chip">{FORMAT[b.format]}</span><span className="chip">{b.hook.type} hook</span><span className="chip">{b.pacing.label} cuts</span>{b.audio.hasMusic && <span className="chip"><Music2 size={10} />{Math.round(b.audio.bpm ?? 0)}</span>}</div>}
      </div>
    </button>
  );
}

function CutStrip({ t }: { t: TrendPost }) {
  const b = t.blueprint!;
  const d = Math.max(1, b.durationMs);
  return (
    <div>
      <div className="relative h-9 overflow-hidden rounded-lg border border-line bg-bg">
        {b.slots.map((s) => <div key={s.index} title={`${(s.startMs / 1000).toFixed(2)}s – ${(s.endMs / 1000).toFixed(2)}s · ${s.kind}`} className={`absolute inset-y-0 border-r border-bg ${s.kind === "talking" ? "bg-ai/45" : "bg-accent/35"}`} style={{ left: `${(s.startMs / d) * 100}%`, width: `${((s.endMs - s.startMs) / d) * 100}%` }} />)}
        {b.audio.beatsMs.filter((x) => x < d).map((x, i) => <div key={i} className="absolute bottom-0 h-1.5 w-px bg-white/50" style={{ left: `${(x / d) * 100}%` }} />)}
      </div>
      <div className="mt-1.5 flex items-center gap-4 text-[11px] text-mute"><span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-ai/60" />talking</span><span className="flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-accent/50" />b-roll</span>{b.audio.hasMusic && <span className="flex items-center gap-1.5"><i className="inline-block h-2 w-px bg-white/70" />beats</span>}<span className="ml-auto">{fmtTime(b.durationMs)}</span></div>
    </div>
  );
}

function TrendDetail({ t, onClose }: { t: TrendPost; onClose: () => void }) {
  const { toast, sounds, status } = useApp();
  const [deepBusy, setDeepBusy] = useState(false);
  const ai = status?.ai.backend !== "none";
  const deep = async () => { setDeepBusy(true); try { await api.deepenTrend(t.id); toast("Frames read: on-screen text, caption look and why it works are updated.", "ok"); } catch (e) { toast((e as Error).message, "error"); } finally { setDeepBusy(false); } };
  const b = t.blueprint;
  const sound = sounds.find((s) => s.id === t.soundId);
  const look = b ? captionTemplate(b.captions.look) : null;
  const Fact = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => <div className="rounded-xl border border-line bg-bg p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-mute">{label}</div><div className="mt-1 text-[15px] font-semibold">{value}</div>{sub && <div className="mt-0.5 text-[11px] text-mute">{sub}</div>}</div>;
  return (
    <Modal title={t.title} onClose={onClose} wide footer={<>
      <button className="btn-quiet mr-auto text-hot hover:text-hot" onClick={async () => { await api.deleteTrend(t.id); toast("Trend removed"); onClose(); }}><Trash2 size={14} />Remove</button>
      {t.source.url && <a className="btn-ghost" href={t.source.url} target="_blank" rel="noreferrer"><Link2 size={14} />Original post</a>}
      {b && b.source !== "vision" && ai && <button className="btn-ai" disabled={deepBusy || t.status === "analyzing"} onClick={deep} title="Reads on-screen text and the caption look, and explains why it works. Uses model credit.">{deepBusy || t.status === "analyzing" ? <Spinner /> : <Sparkles size={14} />}Read frames with AI</button>}
      <button className="btn-primary" disabled={!b} onClick={() => go(`/create?trend=${t.id}`)}><Wand2 size={15} />Make my version</button>
    </>}>
      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <div>
          <div className="overflow-hidden rounded-xl bg-black">{t.urls.video ? <video src={t.urls.video} controls playsInline className="max-h-[500px] w-full" poster={t.urls.thumbnail ?? undefined} /> : <div className="flex aspect-[9/16] items-center justify-center text-mute"><Spinner /></div>}</div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">{([["Views", t.stats.views], ["Likes", t.stats.likes], ["Comments", t.stats.comments], ["Shares", t.stats.shares]] as const).map(([l, v]) => <div key={l} className="rounded-lg border border-line bg-bg py-2"><div className="text-[13px] font-bold">{fmtCount(v)}</div><div className="text-[10px] uppercase tracking-wider text-mute">{l}</div></div>)}</div>
          {t.source.caption && <p className="mt-3 line-clamp-5 text-[12px] leading-relaxed text-mute">{t.source.caption}</p>}
        </div>
        {!b ? <div className="flex items-center gap-2 text-mute">{t.status === "error" ? <span className="text-hot">{t.error}</span> : <><Spinner />{STATUS[t.status]}</>}</div> : (
          <div className="min-w-0 space-y-5">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Fact label="Format" value={FORMAT[b.format]} sub={`${fmtTime(b.durationMs)} · ${b.aspect}`} />
              <Fact label="Cuts" value={`${b.pacing.cuts} · ${b.pacing.label}`} sub={`${(b.pacing.medianShotMs / 1000).toFixed(1)}s typical shot`} />
              <Fact label="Sound" value={b.audio.hasMusic ? `${Math.round(b.audio.bpm ?? 0)} BPM` : b.audio.hasSpeech ? "Voice only" : "None"} sub={b.audio.cutsOnBeat != null ? `${Math.round(b.audio.cutsOnBeat * 100)}% of cuts on the beat` : b.audio.wordsPerMinute ? `${b.audio.wordsPerMinute} words/min` : undefined} />
              <Fact label="Viral score" value={<span className="text-accent">{t.viralScore}</span>} sub={b.source === "vision" ? "Frames read by AI" : "Signal analysis"} />
            </div>
            <section>
              <div className="label flex items-center gap-1.5"><MessageSquareQuote size={12} />The hook · first {b.hook.seconds}s</div>
              <div className="rounded-xl border border-line bg-bg p-3.5">
                {b.hook.spoken && <div className="text-[15px] font-semibold leading-snug">“{b.hook.spoken}”</div>}
                {b.hook.onScreen && <div className="mt-1.5 flex items-center gap-1.5 text-[13px] text-mute"><Type size={12} />On screen: <span className="text-ink">{b.hook.onScreen}</span></div>}
                {!b.hook.spoken && !b.hook.onScreen && <div className="text-[14px] font-semibold">Visual hook: the strongest shot comes first.</div>}
                <div className="mt-2.5 text-[12px] text-mute">Formula you can reuse: <span className="font-medium text-accent">{b.hook.formula}</span></div>
              </div>
            </section>
            <section>
              <div className="label flex items-center gap-1.5"><Scissors size={12} />Cut rhythm</div>
              <CutStrip t={t} />
            </section>
            <div className="grid gap-5 lg:grid-cols-2">
              <section>
                <div className="label">Structure</div>
                <ol className="space-y-1.5 text-[13px] leading-snug">{b.structure.map((s, i) => <li key={i} className="flex gap-2"><span className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-raised text-[10px] font-bold text-mute">{i + 1}</span>{s}</li>)}</ol>
              </section>
              <section>
                <div className="label">Why it works</div>
                <ul className="space-y-1.5 text-[13px] leading-snug">{b.whyItWorks.map((s, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />{s}</li>)}{!b.whyItWorks.length && <li className="text-mute">Not enough signal to say.</li>}</ul>
              </section>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <section>
                <div className="label">Caption look</div>
                <div className="flex items-center gap-3 rounded-xl border border-line bg-bg p-2.5">
                  {look && <CaptionPreview style={look.style} width={150} height={66} />}
                  <div className="min-w-0"><div className="text-[13px] font-semibold">{look?.name ?? b.captions.look}</div><div className="line-clamp-2 text-[12px] text-mute">{b.captions.present === null ? "Closest match for this format" : b.captions.description}</div></div>
                </div>
              </section>
              <section>
                <div className="label">Sound</div>
                <div className="rounded-xl border border-line bg-bg p-3 text-[13px]">{sound ? <SoundRow s={sound} bare /> : <span className="text-mute">{b.audio.hasMusic ? "Music sits under the voice, so it cannot be lifted out as a track. Pick any sound when you make your version." : "No music in this post."}</span>}</div>
              </section>
            </div>
            <section className="rounded-xl border border-accent/30 bg-accent/5 p-3.5">
              <div className="label !text-accent">Make your own</div>
              <p className="text-[13px] leading-relaxed">{b.recreate}</p>
            </section>
          </div>
        )}
      </div>
    </Modal>
  );
}

function SoundRow({ s, bare }: { s: TrendSound; bare?: boolean }) {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = () => {
    if (!s.urls.audio) return;
    if (!audio.current) { audio.current = new Audio(s.urls.audio); audio.current.onended = () => setPlaying(false); }
    if (playing) { audio.current.pause(); setPlaying(false); } else { void audio.current.play(); setPlaying(true); }
  };
  return (
    <div className={`flex items-center gap-3 ${bare ? "" : "card p-3"}`}>
      <button onClick={toggle} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accentink" aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}</button>
      <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{s.title}</div><div className="truncate text-[12px] text-mute">{s.author ?? "Unknown"} · {fmtTime(s.durationMs)}{s.bpm ? ` · ${Math.round(s.bpm)} BPM` : ""}</div></div>
      {!bare && <div className="text-right"><div className="text-[13px] font-bold">{s.postIds.length} post{s.postIds.length === 1 ? "" : "s"}</div><div className="text-[11px] text-mute">{fmtCount(s.totalViews)} views</div></div>}
    </div>
  );
}

function AddTrend({ onClose }: { onClose: () => void }) {
  const { toast, status } = useApp();
  const [mode, setMode] = useState<"link" | "file">("link");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [meta, setMeta] = useState({ title: "", handle: "", platform: "tiktok", views: "", likes: "", soundTitle: "" });
  const [deep, setDeep] = useState(false);
  const ai = status?.ai.backend !== "none";
  const submitUrl = async () => { try { await api.addTrendUrl(url.trim(), deep); toast("Importing the post. The breakdown appears when it is done.", "ok"); onClose(); } catch (e) { toast((e as Error).message, "error"); } };
  const submitFiles = async (files: File[]) => {
    setBusy(0);
    try { await upload("/api/trends/upload", files, { ...meta, deep: deep ? "1" : "0" }, setBusy); toast(`${files.length} video${files.length === 1 ? "" : "s"} added. Breaking ${files.length === 1 ? "it" : "them"} down now.`, "ok"); onClose(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  };
  return (
    <Modal title="Add a post that is performing" onClose={onClose}>
      <div className="mb-4"><Segmented value={mode} onChange={setMode} options={[{ id: "link", label: "Paste a link" }, { id: "file", label: "Upload the video" }]} /></div>
      {mode === "link" ? (
        <div className="space-y-3">
          <div><label className="label" htmlFor="trend-url">TikTok, Instagram Reel or YouTube Short link</label><input id="trend-url" className="field" placeholder="https://www.tiktok.com/@creator/video/…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void submitUrl(); }} autoFocus /></div>
          <p className="text-[12px] leading-relaxed text-mute">The video, its view counts and its sound are pulled from the public post. The server needs to be able to reach the platform; if it cannot, upload the saved video instead.</p>
          <label className={`flex items-start gap-2.5 rounded-xl border border-line p-3 text-[13px] ${ai ? "cursor-pointer" : "opacity-50"}`}><input type="checkbox" className="mt-0.5 accent-[#c6ff3d]" checked={deep} disabled={!ai} onChange={(e) => setDeep(e.target.checked)} /><span><span className="font-semibold">Read the frames with AI</span><span className="block text-[12px] text-mute">Reads on-screen text and the caption look, and explains why the post works. Uses model credit for each post.</span></span></label>
          <button className="btn-primary w-full" disabled={!/^https?:\/\//.test(url.trim())} onClick={submitUrl}>Import and analyse</button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className="label">Name</label><input className="field" placeholder="What is this format? (optional)" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></div>
            <div><label className="label">Platform</label><select className="field" value={meta.platform} onChange={(e) => setMeta({ ...meta, platform: e.target.value })}><option value="tiktok">TikTok</option><option value="instagram">Instagram</option><option value="youtube">YouTube</option><option value="upload">Other</option></select></div>
            <div><label className="label">Creator</label><input className="field" placeholder="@handle" value={meta.handle} onChange={(e) => setMeta({ ...meta, handle: e.target.value })} /></div>
            <div><label className="label">Views</label><input className="field" placeholder="2.4M" value={meta.views} onChange={(e) => setMeta({ ...meta, views: e.target.value })} /></div>
            <div><label className="label">Likes</label><input className="field" placeholder="310K" value={meta.likes} onChange={(e) => setMeta({ ...meta, likes: e.target.value })} /></div>
            <div className="col-span-2"><label className="label">Sound name</label><input className="field" placeholder="Name of the sound, if it uses one (optional)" value={meta.soundTitle} onChange={(e) => setMeta({ ...meta, soundTitle: e.target.value })} /></div>
          </div>
          <label className={`flex items-start gap-2.5 rounded-xl border border-line p-3 text-[13px] ${ai ? "cursor-pointer" : "opacity-50"}`}><input type="checkbox" className="mt-0.5 accent-[#c6ff3d]" checked={deep} disabled={!ai} onChange={(e) => setDeep(e.target.checked)} /><span><span className="font-semibold">Read the frames with AI</span><span className="block text-[12px] text-mute">On-screen text, caption look and why it works. Uses model credit for each post.</span></span></label>
          <Dropzone onFiles={submitFiles} accept="video/*" label="Drop the saved video here" hint="MP4, MOV or WebM. Views and likes help rank it against your other trends." busy={busy} />
        </div>
      )}
    </Modal>
  );
}

function Watchlist() {
  const { toast } = useApp();
  const [sources, setSources] = useState<WatchSource[]>([]);
  const [cands, setCands] = useState<TrendCandidate[]>([]);
  const [form, setForm] = useState({ platform: "tiktok", kind: "account", value: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.watch().then((r) => { setSources(r.sources); setCands(r.candidates); }).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const add = async () => { if (!form.value.trim()) return; await api.addWatch(form); setForm({ ...form, value: "" }); await load(); };
  const refresh = async (id: string) => { setBusy(id); try { const r = await api.refreshWatch(id); if (r.source.lastError) toast(r.source.lastError, "error"); else toast(`${r.candidates.length} recent posts found`, "ok"); await load(); } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); } };
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div>
        <div className="card p-4">
          <div className="h2 mb-1">Track a source</div>
          <p className="mb-3 text-[12px] leading-relaxed text-mute">Accounts, hashtags and sounds you want to keep an eye on. Checking a source lists its recent posts and ranks them by views per hour, so what is taking off right now floats to the top.</p>
          <div className="flex gap-2"><select className="field !w-auto" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}><option value="tiktok">TikTok</option><option value="instagram">Instagram</option><option value="youtube">YouTube</option></select><select className="field !w-auto" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="account">Account</option><option value="hashtag">Hashtag</option><option value="sound">Sound</option></select></div>
          <div className="mt-2 flex gap-2"><input className="field" placeholder={form.kind === "account" ? "@creator" : form.kind === "hashtag" ? "#topic" : "sound id"} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /><button className="btn-primary" onClick={add}><Plus size={15} /></button></div>
        </div>
        <div className="mt-3 space-y-2">
          {sources.map((s) => (
            <div key={s.id} className="card flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold">{s.kind === "hashtag" ? "#" : s.kind === "account" ? "@" : ""}{s.value}</div><div className="truncate text-[11px] text-mute">{PLATFORM[s.platform]?.label} · {s.lastError ? <span className="text-hot">{s.lastError}</span> : s.lastChecked ? `checked ${new Date(s.lastChecked).toLocaleString()}` : "not checked yet"}</div></div>
              <button className="btn-ghost !px-2.5" onClick={() => refresh(s.id)} disabled={busy === s.id} aria-label="Check now">{busy === s.id ? <Spinner /> : <RefreshCw size={14} />}</button>
              <button className="btn-quiet !px-2" onClick={async () => { await api.deleteWatch(s.id); await load(); }} aria-label="Remove"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </div>
      <div>
        {!cands.length ? <Empty icon={<Radar size={28} />} title="Nothing found yet">Add a source and check it. Posts that are gaining views fastest are listed here, ready to bring into your trend library with one click.</Empty> : (
          <div className="card divide-y divide-line">
            {cands.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{c.title || c.url}</div><div className="text-[11px] text-mute">{c.author ? `@${c.author} · ` : ""}{fmtCount(c.views)} views{c.velocity ? ` · ${fmtCount(c.velocity)}/hour` : ""}{c.postedAt ? ` · ${new Date(c.postedAt).toLocaleDateString()}` : ""}</div></div>
                <button className="btn-ghost" disabled={c.ingested} onClick={async () => { try { await api.addTrendUrl(c.url, false); toast("Importing the post", "ok"); setCands((x) => x.map((y) => (y.id === c.id ? { ...y, ingested: true } : y))); } catch (e) { toast((e as Error).message, "error"); } }}>{c.ingested ? "In library" : "Analyse"}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Trends({ openId }: { openId: string | null }) {
  const { trends, sounds } = useApp();
  const [tab, setTab] = useState<"posts" | "sounds" | "watch">("posts");
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("all");
  const open = trends.find((t) => t.id === openId) ?? null;
  const formats = useMemo(() => [...new Set(trends.map((t) => t.blueprint?.format).filter(Boolean))] as string[], [trends]);
  const shown = trends.filter((t) => filter === "all" || t.blueprint?.format === filter);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div><h1 className="h1">Trends</h1><p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-mute">Posts that are already working, broken down into the parts you can reuse: the hook, the cut rhythm, the caption look and the sound. Pick one and Autopilot rebuilds it with your footage.</p></div>
          <button className="btn-primary shrink-0" onClick={() => setAdding(true)}><Plus size={15} />Add a post</button>
        </div>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Segmented value={tab} onChange={setTab} options={[{ id: "posts", label: `Posts ${trends.length ? `· ${trends.length}` : ""}` }, { id: "sounds", label: `Sounds ${sounds.length ? `· ${sounds.length}` : ""}` }, { id: "watch", label: "Watchlist" }]} />
          {tab === "posts" && formats.length > 1 && <div className="flex flex-wrap gap-1.5"><button onClick={() => setFilter("all")} className={`chip ${filter === "all" ? "!border-accent !text-accent" : ""}`}>All formats</button>{formats.map((f) => <button key={f} onClick={() => setFilter(f)} className={`chip ${filter === f ? "!border-accent !text-accent" : ""}`}>{FORMAT[f]}</button>)}</div>}
        </div>
        {tab === "posts" && (!trends.length ? <Empty icon={<Flame size={30} />} title="Start your trend library">Paste a link to a TikTok, Reel or Short that is doing well in your niche, or upload the saved video. You get its hook, cut-by-cut rhythm, caption look and sound, and a one-click way to make your own version.<div className="mt-4"><button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} />Add your first post</button></div></Empty>
          : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{shown.map((t) => <TrendCard key={t.id} t={t} onOpen={() => go(`/trends?open=${t.id}`)} />)}</div>)}
        {tab === "sounds" && (!sounds.length ? <Empty icon={<Music2 size={30} />} title="No sounds yet">When a post in your library is cut to music, its sound is kept here with its tempo and beat grid, ranked by how many of your tracked posts use it.</Empty>
          : <div className="grid gap-3 lg:grid-cols-2">{sounds.map((s) => <SoundRow key={s.id} s={s} />)}</div>)}
        {tab === "watch" && <Watchlist />}
      </div>
      {adding && <AddTrend onClose={() => setAdding(false)} />}
      {open && <TrendDetail t={open} onClose={() => go("/trends")} />}
    </div>
  );
}
export { FORMAT, SoundRow };
export const _icons = { Clock };
