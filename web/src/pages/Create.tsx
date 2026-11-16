import React, { useMemo, useState } from "react";
import { Wand2, Sparkles, Music2, Check, Flame, Mic, Clapperboard, Podcast, AudioLines } from "lucide-react";
import type { Template } from "@shared/types";
import { api } from "../api";
import { fmtTime, go, useApp } from "../store";
import { Spinner } from "../components/ui";
import { CaptionPreview } from "../components/CaptionPreview";
import { FootagePicker } from "../components/FootagePicker";
import { FORMAT } from "./Trends";

const TEMPLATE_ICON: Record<string, typeof Mic> = { "short-talking-head": Mic, vlog: Clapperboard, "long-podcast": Podcast, "beat-montage": AudioLines };
const templateLook = (t: Template | null | undefined) => (!t ? null : !t.defaults.captionsOn ? "clean-pod" : t.id === "vlog" ? "tiktok-outline" : t.id === "beat-montage" ? "tall-caps" : "bold-pop");
type Pick = { kind: "trend" | "template"; id: string };

export function Create({ trendId, ideaId }: { trendId: string | null; ideaId: string | null }) {
  const { trends, sounds, assets, catalog, status, ideas, toast, refresh } = useApp();
  const idea = ideas.find((i) => i.id === ideaId) ?? null;
  const ready = trends.filter((t) => t.status === "ready" && t.blueprint);
  const startTrend = trendId ?? idea?.trendId ?? null;
  const [pick, setPick] = useState<Pick>(startTrend ? { kind: "trend", id: startTrend } : { kind: "template", id: idea?.format === "montage" ? "beat-montage" : "short-talking-head" });
  const [picked, setPicked] = useState<string[]>(idea?.useAssetIds.filter((id) => assets.some((a) => a.id === id)) ?? []);
  const t = pick.kind === "trend" ? ready.find((x) => x.id === pick.id) ?? null : null;
  const tpl = pick.kind === "template" ? catalog?.templates.find((x) => x.id === pick.id) ?? null : null;
  const [look, setLook] = useState<string | null>(null);
  const [captionsOn, setCaptionsOn] = useState<boolean | null>(null);
  const [seconds, setSeconds] = useState<string>("");
  const [hook, setHook] = useState(idea?.hook && idea.hook.length < 70 ? idea.hook : "");
  const [topic, setTopic] = useState(idea ? idea.title : "");
  const [sound, setSound] = useState<string>("auto");
  const ai = status?.ai.backend !== "none";
  const [useAi, setUseAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const music = assets.filter((a) => a.contentType === "music" && a.status === "ready");
  const trendSound = t ? sounds.find((s) => s.id === t.soundId) : null;
  const lookId = look ?? t?.blueprint?.captions.look ?? templateLook(tpl) ?? "bold-pop";
  const captionsDefault = tpl ? tpl.defaults.captionsOn : true;
  const captions = captionsOn ?? captionsDefault;
  const processing = picked.some((id) => assets.find((a) => a.id === id)?.status === "processing");
  const sel = picked.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const hasSpeech = sel.some((a) => (a!.transcription?.segments.length ?? 0) > 0);
  const autoSoundLabel = trendSound ? "Trend sound" : tpl?.defaults.musicOn ? (sounds.length ? "Top trending sound" : music.length ? "Your first track" : "None available") : "Auto";
  const hint = useMemo(() => {
    if (!sel.length) return "Pick the clips to build from.";
    if (processing) return "Waiting for your clips to finish processing…";
    if (t?.blueprint && t.blueprint.format !== "montage" && !hasSpeech) return "This trend is a talking format and none of the selected clips has speech, so it will be built as a montage.";
    if (tpl && tpl.id !== "beat-montage" && tpl.id !== "vlog" && !hasSpeech) return `${tpl.name} is built around speech and none of the selected clips has any. Try Vlog or Beat Montage.`;
    if (tpl?.defaults.musicOn && sound === "auto" && !sounds.length && !music.length) return `${tpl.name} runs on music and there is no track yet. Upload one under Footage or add a post with a sound under Trends.`;
    return null;
  }, [sel.length, processing, t, tpl, hasSpeech, sound, sounds.length, music.length]);
  const make = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { trendId: t?.id ?? null, templateId: tpl?.id ?? null, assetIds: picked, captionLook: lookId, useAi: useAi && ai, topic: topic || undefined, hookText: hook.trim() || undefined, targetSeconds: seconds ? Number(seconds) : undefined };
      if (captionsOn !== null) body.captions = captionsOn;
      if (sound === "none") body.music = "none"; else if (sound.startsWith("snd_")) body.soundId = sound; else if (sound !== "auto") body.musicAssetId = sound;
      const r = await api.autopilot(body);
      void refresh("projects");
      const kind = r.report.mode === "talking" ? "talking edit" : r.report.mode === "vlog" ? "vlog" : "montage";
      toast(`Built a ${r.report.durationSeconds.toFixed(0)}s ${kind} from ${r.report.usedAssets.length} clip${r.report.usedAssets.length === 1 ? "" : "s"}.`, "ok");
      go(`/p/${r.project.id}`);
    } catch (e) { toast((e as Error).message, "error"); setBusy(false); }
  };
  const choose = (p: Pick) => { setPick(p); setLook(null); setCaptionsOn(null); setSeconds(""); };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <h1 className="h1">Autopilot</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-mute">Choose a format that is working, drop in your clips, and get a finished edit: hook first, cuts where the format cuts, captions in the look people actually post with. Everything stays editable afterwards.</p>
        {idea && <div className="mt-4 rounded-xl border border-ai/40 bg-ai/10 p-3.5 text-[13px]"><div className="font-semibold">From your ideas: {idea.title}</div><div className="mt-0.5 text-mute">{idea.why}</div></div>}
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-7">
            <section>
              <div className="mb-3 flex items-baseline justify-between"><h2 className="h2"><span className="mr-2 text-accent">1</span>Format to follow</h2><button className="text-[12px] font-medium text-mute hover:text-ink" onClick={() => go("/trends")}>Manage trends</button></div>
              <div className="flex gap-3 overflow-x-auto pb-2">
                {catalog?.templates.map((x) => { const Icon = TEMPLATE_ICON[x.id] ?? Wand2; const on = pick.kind === "template" && pick.id === x.id; return (
                  <button key={x.id} onClick={() => choose({ kind: "template", id: x.id })} className={`flex w-[150px] shrink-0 flex-col justify-between rounded-xl border p-3 text-left ${on ? "border-accent bg-accent/5" : "border-line bg-panel hover:border-faint"}`} aria-pressed={on}>
                    <div className="flex items-start justify-between"><Icon size={18} className="text-accent" />{on && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accentink"><Check size={12} /></span>}</div>
                    <div><div className="mt-6 text-[13px] font-semibold">{x.name}</div><div className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-mute">{x.bestFor}</div><div className="mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">Template · {x.aspect}</div></div>
                  </button>); })}
                {ready.map((x) => { const on = pick.kind === "trend" && pick.id === x.id; return (
                  <button key={x.id} onClick={() => choose({ kind: "trend", id: x.id })} className={`relative w-[150px] shrink-0 overflow-hidden rounded-xl border text-left ${on ? "border-accent" : "border-line hover:border-faint"}`} aria-pressed={on}>
                    <div className="aspect-[9/12] bg-black">{x.urls.thumbnail && <img src={x.urls.thumbnail} alt="" className="h-full w-full object-cover" />}</div>
                    <div className="absolute inset-x-0 top-0 flex justify-between p-1.5"><span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-accent"><Flame size={10} />{x.viralScore}</span>{on && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accentink"><Check size={12} /></span>}</div>
                    <div className="bg-panel p-2"><div className="line-clamp-2 text-[12px] font-semibold leading-snug">{x.title}</div><div className="mt-0.5 text-[10px] text-mute">{FORMAT[x.blueprint!.format]} · {fmtTime(x.durationMs)}</div></div>
                  </button>); })}
                {!ready.length && <div className="flex w-[180px] shrink-0 items-center rounded-xl border border-dashed border-line px-4 text-[12px] leading-relaxed text-mute">Add posts under Trends to copy formats that are already working.</div>}
              </div>
              {t?.blueprint && <div className="mt-2 rounded-xl border border-line bg-panel p-3 text-[12px] leading-relaxed text-mute"><span className="font-semibold text-ink">What gets copied:</span> {t.blueprint.hook.type} hook in the first {t.blueprint.hook.seconds}s, {t.blueprint.pacing.cuts} cuts at a {t.blueprint.pacing.label} pace{t.blueprint.audio.cutsOnBeat ? `, ${Math.round(t.blueprint.audio.cutsOnBeat * 100)}% on the beat` : ""}, {FORMAT[t.blueprint.format].toLowerCase()} structure{t.blueprint.hook.onScreen ? `, the on-screen line “${t.blueprint.hook.onScreen}”` : ""}. <span className="text-ink">{t.blueprint.recreate}</span></div>}
              {tpl && <div className="mt-2 grid gap-x-6 gap-y-1.5 rounded-xl border border-line bg-panel p-3 text-[12px] leading-relaxed text-mute sm:grid-cols-2">
                <div><span className="font-semibold text-ink">Structure.</span> {tpl.guidance.structure}</div><div><span className="font-semibold text-ink">Pacing.</span> {tpl.guidance.pacing}</div>
                <div><span className="font-semibold text-ink">Captions.</span> {tpl.guidance.captions}</div><div><span className="font-semibold text-ink">Ending.</span> {tpl.guidance.ending}</div>
              </div>}
            </section>
            <section>
              <h2 className="h2 mb-3"><span className="mr-2 text-accent">2</span>Your footage {picked.length > 0 && <span className="ml-1 text-[12px] font-medium text-mute">{picked.length} selected{tpl?.id === "vlog" ? ", ordered by recording time when known" : ", used in this order"}</span>}</h2>
              <FootagePicker selected={picked} onChange={setPicked} filter={(a) => a.contentType !== "music"} />
            </section>
          </div>
          <aside className="space-y-5 lg:sticky lg:top-0 lg:self-start">
            <div className="card space-y-5 p-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between"><span className="label !mb-0">Caption look</span><label className="flex cursor-pointer items-center gap-1.5 text-[12px] font-medium"><input type="checkbox" className="accent-[#c6ff3d]" checked={captions} onChange={(e) => setCaptionsOn(e.target.checked)} />Captions on</label></div>
                <div className={`grid max-h-[330px] grid-cols-2 gap-2 overflow-y-auto pr-1 ${captions ? "" : "pointer-events-none opacity-40"}`}>
                  {catalog?.captionLooks.map((c) => (
                    <button key={c.id} onClick={() => setLook(c.id)} className={`overflow-hidden rounded-xl border text-left ${lookId === c.id ? "border-accent" : "border-line hover:border-faint"}`} title={`${c.description} Seen in: ${c.seenIn}.`}>
                      <CaptionPreview style={c.style} width={166} height={62} animate={lookId === c.id && captions} />
                      <div className="flex items-center justify-between px-2 py-1.5"><span className="truncate text-[11px] font-semibold">{c.name}</span>{t?.blueprint?.captions.look === c.id && <span className="text-[9px] font-bold uppercase text-accent">trend</span>}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="len">Length</label><select id="len" className="field" value={seconds} onChange={(e) => setSeconds(e.target.value)}><option value="">{t ? `Like the trend (${fmtTime(t.durationMs)})` : tpl?.id === "long-podcast" ? "Keep it all" : tpl ? `Auto (${tpl.length.split(",")[0]})` : "Auto"}</option><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="45">45 seconds</option><option value="60">60 seconds</option><option value="90">90 seconds</option></select></div>
                <div><label className="label" htmlFor="snd">Sound</label><select id="snd" className="field" value={sound} onChange={(e) => setSound(e.target.value)}><option value="auto">{autoSoundLabel}</option><option value="none">No music</option>{sounds.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}{music.filter((m) => !sounds.some((s) => s.assetId === m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
              </div>
              {trendSound && sound === "auto" && <div className="flex items-center gap-2 rounded-lg bg-bg p-2 text-[12px] text-mute"><Music2 size={13} className="text-accent" />Cut to “{trendSound.title}” at {Math.round(trendSound.bpm ?? 0)} BPM, same cut points as the original.</div>}
              <div><label className="label" htmlFor="hook">On-screen hook <span className="normal-case tracking-normal text-faint">optional</span></label><input id="hook" className="field" placeholder={t?.blueprint?.hook.onScreen ?? (tpl?.id === "vlog" ? "e.g. day four in SF" : "Leave empty to use your strongest line")} value={hook} onChange={(e) => setHook(e.target.value)} maxLength={80} /></div>
              <div><label className="label" htmlFor="topic">What is this video about? <span className="normal-case tracking-normal text-faint">optional</span></label><textarea id="topic" className="field min-h-[58px] resize-none" placeholder="A sentence helps the AI pick the right lines." value={topic} onChange={(e) => setTopic(e.target.value)} /></div>
              <label className={`flex items-start gap-2.5 rounded-xl border border-line p-3 text-[13px] ${ai ? "cursor-pointer" : "opacity-55"}`}>
                <input type="checkbox" className="mt-0.5 accent-[#8b7bff]" checked={useAi && ai} disabled={!ai} onChange={(e) => setUseAi(e.target.checked)} />
                <span><span className="flex items-center gap-1.5 font-semibold"><Sparkles size={13} className="text-ai" />Let AI choose the lines</span><span className="block text-[12px] leading-snug text-mute">{ai ? "Reads your transcripts to pick the hook, what to keep and which b-roll goes where, and writes the post caption. Takes about a minute and uses model credit. Off, the edit is built with rules in seconds." : "No AI model is connected. The edit is built with rules."}</span></span>
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
