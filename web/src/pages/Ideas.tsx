import React, { useEffect, useState } from "react";
import { Lightbulb, RefreshCw, Wand2, Sparkles, CircleAlert } from "lucide-react";
import type { CreatorProfile } from "@shared/trends";
import { api } from "../api";
import { go, useApp } from "../store";
import { Empty, Spinner } from "../components/ui";
import { FORMAT } from "./Trends";

export function Ideas() {
  const { ideas, trends, assets, status, toast, refresh } = useApp();
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [busy, setBusy] = useState<"ai" | "rules" | null>(null);
  const ai = status?.ai.backend !== "none";
  useEffect(() => { api.profile().then((r) => setProfile(r.profile)).catch(() => undefined); }, []);
  const save = async (patch: Partial<CreatorProfile>) => { if (!profile) return; const next = { ...profile, ...patch }; setProfile(next); await api.saveProfile(next).catch(() => undefined); };
  const run = async (withAi: boolean) => { setBusy(withAi ? "ai" : "rules"); try { await api.refreshIdeas(withAi); await refresh("ideas"); } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); } };
  const footage = assets.filter((a) => a.contentType !== "music");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div><h1 className="h1">What to post</h1><p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-mute">Ideas you can make today, built from the formats in your trend library and the footage you already have. Each one opens in Autopilot with the trend and clips preselected.</p></div>
          <div className="flex shrink-0 gap-2"><button className="btn-ghost" onClick={() => run(false)} disabled={!!busy}>{busy === "rules" ? <Spinner /> : <RefreshCw size={14} />}Quick refresh</button><button className="btn-ai" onClick={() => run(true)} disabled={!!busy || !ai} title={ai ? "Uses model credit" : "No AI model is connected"}>{busy === "ai" ? <Spinner /> : <Sparkles size={14} />}Ask AI</button></div>
        </div>
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-3">
            {!ideas.length ? <Empty icon={<Lightbulb size={30} />} title="No ideas yet">{!trends.length && !footage.length ? "Add a few trending posts and upload some footage, then refresh. Ideas are matched to what you can actually make." : "Press Quick refresh for ideas matched to your trends and footage, or Ask AI for ideas written for your niche."}</Empty> : ideas.map((i, n) => {
              const t = trends.find((x) => x.id === i.trendId);
              return (
                <div key={i.id} className="card flex gap-4 p-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-raised text-[13px] font-bold text-accent">{n + 1}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="text-[15px] font-semibold leading-snug">{i.title}</h3>{i.source === "ai" && <span className="chip !border-ai/40 !text-ai"><Sparkles size={10} />AI</span>}</div>
                    {i.hook && <div className="mt-1.5 text-[13px]"><span className="text-mute">Open with: </span><span className="font-medium">“{i.hook}”</span></div>}
                    <p className="mt-1.5 text-[13px] leading-relaxed text-mute">{i.why}</p>
                    <div className="mt-2.5 flex flex-wrap gap-1.5"><span className="chip">{FORMAT[i.format]}</span>{t && <span className="chip">from “{t.title}”</span>}{i.useAssetIds.length > 0 && <span className="chip">{i.useAssetIds.length} of your clips fit</span>}</div>
                    {i.shotList.length > 0 && <ol className="mt-3 space-y-1 text-[12px] text-mute">{i.shotList.map((s, k) => <li key={k} className="flex gap-2"><span className="font-semibold text-faint">{k + 1}.</span>{s}</li>)}</ol>}
                    {i.missing.length > 0 && <div className="mt-3 flex gap-2 rounded-lg bg-warn/10 p-2.5 text-[12px] leading-snug text-warn"><CircleAlert size={14} className="mt-px shrink-0" /><span>Still to film: {i.missing.join("; ")}</span></div>}
                    {i.caption && <div className="mt-3 rounded-lg bg-bg p-2.5 text-[12px] leading-relaxed"><span className="text-mute">Caption: </span>{i.caption} <span className="text-ai">{i.hashtags.map((h) => `#${h}`).join(" ")}</span></div>}
                  </div>
                  <button className="btn-primary shrink-0 self-start" onClick={() => go(`/create?idea=${i.id}${i.trendId ? `&trend=${i.trendId}` : ""}`)}><Wand2 size={14} />Make it</button>
                </div>
              );
            })}
          </div>
          <aside className="card h-fit space-y-3 p-4">
            <div><div className="h2">About you</div><p className="mt-1 text-[12px] leading-relaxed text-mute">Used to match trends to your niche and to write hooks in your voice.</p></div>
            {profile && (<>
              <div><label className="label" htmlFor="niche">Niche</label><input id="niche" className="field" placeholder="e.g. fitness for busy dads" defaultValue={profile.niche} onBlur={(e) => save({ niche: e.target.value })} /></div>
              <div><label className="label" htmlFor="aud">Audience</label><input id="aud" className="field" placeholder="Who are you talking to?" defaultValue={profile.audience} onBlur={(e) => save({ audience: e.target.value })} /></div>
              <div><label className="label" htmlFor="tone">Tone</label><input id="tone" className="field" placeholder="direct, funny, calm…" defaultValue={profile.tone} onBlur={(e) => save({ tone: e.target.value })} /></div>
              <div><label className="label" htmlFor="goal">Goal</label><input id="goal" className="field" placeholder="followers, leads, sales…" defaultValue={profile.goal} onBlur={(e) => save({ goal: e.target.value })} /></div>
            </>)}
          </aside>
        </div>
      </div>
    </div>
  );
}
