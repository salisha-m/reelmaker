import React, { useMemo, useState } from "react";
import { Wand2, Sparkles, Music2, Check, Flame, Zap } from "lucide-react";
import { api } from "../api";
import { fmtTime, go, useApp } from "../store";
import { Spinner } from "../components/ui";
import { CaptionPreview } from "../components/CaptionPreview";
import { FootagePicker } from "../components/FootagePicker";
import { FORMAT } from "./Trends";

export function Create({ trendId, ideaId }: { trendId: string | null; ideaId: string | null }) {
  const { trends, sounds, assets, catalog, status, ideas, toast, refresh } = useApp();
  const idea = ideas.find((i) => i.id === ideaId) ?? null;
  const ready = trends.filter((t) => t.status === "ready" && t.blueprint);
  const [trend, setTrend] = useState<string | null>(trendId ?? idea?.trendId ?? null);
  const [picked, setPicked] = useState<string[]>(idea?.useAssetIds.filter((id) => assets.some((a) => a.id === id)) ?? []);
  const t = ready.find((x) => x.id === trend) ?? null;
  const [look, setLook] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<string>("");
  const [hook, setHook] = useState(idea?.hook && idea.hook.length < 70 ? idea.hook : "");
  const [topic, setTopic] = useState(idea ? idea.title : "");
  const [sound, setSound] = useState<string>("auto");
  const ai = status?.ai.backend !== "none";
  const [useAi, setUseAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const music = assets.filter((a) => a.contentType === "music" && a.status === "ready");
  const trendSound = t ? sounds.find((s) => s.id === t.soundId) : null;
  const lookId = look ?? t?.blueprint?.captions.look ?? "bold-pop";
  const processing = picked.some((id) => assets.find((a) => a.id === id)?.status === "processing");
  const sel = picked.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const hasSpeech = sel.some((a) => (a!.transcription?.segments.length ?? 0) > 0);
  const hint = useMemo(() => {
    if (!sel.length) return "Pick the clips to build from.";
    if (processing) return "Waiting for your clips to finish processing…";
    if (t?.blueprint && t.blueprint.format !== "montage" && !hasSpeech) return "This trend is a talking format and none of the selected clips has speech, so it will be built as a montage.";
    return null;
  }, [sel.length, processing, t, hasSpeech]);
  const make = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { trendId: trend, assetIds: picked, captionLook: lookId, useAi: useAi && ai, topic: topic || undefined, hookText: hook.trim() || undefined, targetSeconds: seconds ? Number(seconds) : undefined };
      if (sound === "none") body.music = "none"; else if (sound.startsWith("snd_")) body.soundId = sound; else if (sound !== "auto") body.musicAssetId = sound;
      const r = await api.autopilot(body);
      void refresh("projects");
      toast(`Built a ${r.report.durationSeconds.toFixed(0)}s ${r.report.mode === "talking" ? "talking edit" : "montage"} from ${r.report.usedAssets.length} clip${r.report.usedAssets.length === 1 ? "" : "s"}.`, "ok");
      go(`/p/${r.project.id}`);
    } catch (e) { toast((e as Error).message, "error"); setBusy(false); }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <h1 className="h1">Autopilot</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-mute">Choose a format that is working, drop in your clips, and get a finished edit: hook first, cuts where the trend cuts, captions in the look people actually post with. Everything stays editable afterwards.</p>
        {idea && <div className="mt-4 rounded-xl border border-ai/40 bg-ai/10 p-3.5 text-[13px]"><div className="font-semibold">From your ideas: {idea.title}</div><div className="mt-0.5 text-mute">{idea.why}</div></div>}
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-7">
            <section>
              <div className="mb-3 flex items-baseline justify-between"><h2 className="h2"><span className="mr-2 text-accent">1</span>Format to follow</h2><button className="text-[12px] font-medium text-mute hover:text-ink" onClick={() => go("/trends")}>Manage trends</button></div>
              <div className="flex gap-3 overflow-x-auto pb-2">
                <button onClick={() => setTrend(null)} className={`flex w-[150px] shrink-0 flex-col justify-between rounded-xl border p-3 text-left ${trend === null ? "border-accent bg-accent/5" : "border-line bg-panel hover:border-faint"}`}>
                  <Zap size={18} className="text-accent" /><div><div className="mt-6 text-[13px] font-semibold">Hook-first cut</div><div className="mt-0.5 text-[11px] leading-snug text-mute">No reference. Strongest line first, tight cuts, captions.</div></div>
                </button>
                {ready.map((x) => (
                  <button key={x.id} onClick={() => setTrend(x.id)} className={`relative w-[150px] shrink-0 overflow-hidden rounded-xl border text-left ${trend === x.id ? "border-accent" : "border-line hover:border-faint"}`}>
                    <div className="aspect-[9/12] bg-black">{x.urls.thumbnail && <img src={x.urls.thumbnail} alt="" className="h-full w-full object-cover" />}</div>
                    <div className="absolute inset-x-0 top-0 flex justify-between p-1.5"><span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-accent"><Flame size={10} />{x.viralScore}</span>{trend === x.id && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accentink"><Check size={12} /></span>}</div>
                    <div className="bg-panel p-2"><div className="line-clamp-2 text-[12px] font-semibold leading-snug">{x.title}</div><div className="mt-0.5 text-[10px] text-mute">{FORMAT[x.blueprint!.format]} · {fmtTime(x.durationMs)}</div></div>
                  </button>
                ))}
                {!ready.length && <div className="flex items-center rounded-xl border border-dashed border-line px-5 text-[12px] leading-relaxed text-mute">Add posts under Trends to copy formats that are already working.</div>}
              </div>
              {t?.blueprint && <div className="mt-2 rounded-xl border border-line bg-panel p-3 text-[12px] leading-relaxed text-mute"><span className="font-semibold text-ink">What gets copied:</span> {t.blueprint.hook.type} hook in the first {t.blueprint.hook.seconds}s, {t.blueprint.pacing.cuts} cuts at a {t.blueprint.pacing.label} pace{t.blueprint.audio.cutsOnBeat ? `, ${Math.round(t.blueprint.audio.cutsOnBeat * 100)}% on the beat` : ""}, {FORMAT[t.blueprint.format].toLowerCase()} structure. <span className="text-ink">{t.blueprint.recreate}</span></div>}
            </section>
            <section>
              <h2 className="h2 mb-3"><span className="mr-2 text-accent">2</span>Your footage {picked.length > 0 && <span className="ml-1 text-[12px] font-medium text-mute">{picked.length} selected, used in this order</span>}</h2>
              <FootagePicker selected={picked} onChange={setPicked} filter={(a) => a.contentType !== "music"} />
            </section>
          </div>
          <aside className="space-y-5 lg:sticky lg:top-0 lg:self-start">
            <div className="card space-y-5 p-4">
              <div>
                <div className="label">Caption look</div>
                <div className="grid max-h-[330px] grid-cols-2 gap-2 overflow-y-auto pr-1">
                  {catalog?.captionLooks.map((c) => (
                    <button key={c.id} onClick={() => setLook(c.id)} className={`overflow-hidden rounded-xl border text-left ${lookId === c.id ? "border-accent" : "border-line hover:border-faint"}`} title={`${c.description} Seen in: ${c.seenIn}.`}>
                      <CaptionPreview style={c.style} width={166} height={62} animate={lookId === c.id} />
                      <div className="flex items-center justify-between px-2 py-1.5"><span className="truncate text-[11px] font-semibold">{c.name}</span>{t?.blueprint?.captions.look === c.id && <span className="text-[9px] font-bold uppercase text-accent">trend</span>}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="len">Length</label><select id="len" className="field" value={seconds} onChange={(e) => setSeconds(e.target.value)}><option value="">{t ? `Like the trend (${fmtTime(t.durationMs)})` : "Auto"}</option><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="45">45 seconds</option><option value="60">60 seconds</option><option value="90">90 seconds</option></select></div>
                <div><label className="label" htmlFor="snd">Sound</label><select id="snd" className="field" value={sound} onChange={(e) => setSound(e.target.value)}><option value="auto">{trendSound ? `Trend sound` : "Auto"}</option><option value="none">No music</option>{sounds.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}{music.filter((m) => !sounds.some((s) => s.assetId === m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
              </div>
              {trendSound && sound === "auto" && <div className="flex items-center gap-2 rounded-lg bg-bg p-2 text-[12px] text-mute"><Music2 size={13} className="text-accent" />Cut to “{trendSound.title}” at {Math.round(trendSound.bpm ?? 0)} BPM, same cut points as the original.</div>}
              <div><label className="label" htmlFor="hook">On-screen hook <span className="normal-case tracking-normal text-faint">optional</span></label><input id="hook" className="field" placeholder={t?.blueprint?.hook.onScreen ?? "Leave empty to use your strongest line"} value={hook} onChange={(e) => setHook(e.target.value)} maxLength={80} /></div>
              <div><label className="label" htmlFor="topic">What is this video about? <span className="normal-case tracking-normal text-faint">optional</span></label><textarea id="topic" className="field min-h-[58px] resize-none" placeholder="A sentence helps the AI pick the right lines." value={topic} onChange={(e) => setTopic(e.target.value)} /></div>
              <label className={`flex items-start gap-2.5 rounded-xl border border-line p-3 text-[13px] ${ai ? "cursor-pointer" : "opacity-55"}`}>
                <input type="checkbox" className="mt-0.5 accent-[#8b7bff]" checked={useAi && ai} disabled={!ai} onChange={(e) => setUseAi(e.target.checked)} />
                <span><span className="flex items-center gap-1.5 font-semibold"><Sparkles size={13} className="text-ai" />Let AI choose the lines</span><span className="block text-[12px] leading-snug text-mute">{ai ? "Reads your transcripts to pick the hook, what to keep and which b-roll goes where. Takes about a minute and uses model credit. Off, the same edit is built with rules in seconds." : "No AI model is connected. The edit is built with rules."}</span></span>
              </label>
              {hint && <div className="rounded-lg bg-warn/10 p-2.5 text-[12px] leading-snug text-warn">{hint}</div>}
              <button className="btn-primary w-full !py-3 !text-[14px]" disabled={!picked.length || processing || busy} onClick={make}>{busy ? <><Spinner />{useAi && ai ? "Planning and building…" : "Building…"}</> : <><Wand2 size={16} />Make the video</>}</button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
