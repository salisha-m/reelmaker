import React, { useEffect } from "react";
import { Flame, Lightbulb, Wand2, Clapperboard, FolderOpen, Sparkles } from "lucide-react";
import { go, useApp, useRoute } from "./store";
import { Trends } from "./pages/Trends";
import { Create } from "./pages/Create";
import { Ideas } from "./pages/Ideas";
import { Projects, Library } from "./pages/Library";
import { Editor } from "./editor/Editor";
import { Spinner } from "./components/ui";

const NAV = [
  { path: "/trends", label: "Trends", icon: Flame },
  { path: "/ideas", label: "What to post", icon: Lightbulb },
  { path: "/create", label: "Autopilot", icon: Wand2 },
  { path: "/projects", label: "Projects", icon: Clapperboard },
  { path: "/library", label: "Footage", icon: FolderOpen },
];
const AI_LABEL: Record<string, string> = { "anthropic-api": "Claude API", "claude-code": "Claude Code", none: "AI off" };

export function App() {
  const { status, load, toasts } = useApp();
  const route = useRoute();
  const [failed, setFailed] = React.useState<string | null>(null);
  useEffect(() => { load().catch((e) => setFailed((e as Error).message)); }, [load]);
  if (failed) return <div className="flex h-full items-center justify-center p-8 text-center"><div><div className="h2 mb-2">The server is not reachable</div><div className="text-mute">{failed}</div><button className="btn-ghost mt-4" onClick={() => location.reload()}>Try again</button></div></div>;
  if (!status) return <div className="flex h-full items-center justify-center text-mute"><Spinner size={20} /></div>;
  const editorId = /^\/p\/(.+)$/.exec(route.path)?.[1];
  return (
    <div className="flex h-full">
      {!editorId && (
        <nav className="flex w-[212px] shrink-0 flex-col border-r border-line bg-panel px-3 py-4" aria-label="Main">
          <button className="mb-6 flex items-center gap-2.5 px-2 text-left" onClick={() => go("/trends")}>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accentink"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg></span>
            <span className="text-[16px] font-bold tracking-tight">{status.app}</span>
          </button>
          <div className="flex flex-col gap-0.5">
            {NAV.map((n) => { const active = route.path.startsWith(n.path); return (
              <button key={n.path} onClick={() => go(n.path)} aria-current={active ? "page" : undefined} className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors ${active ? "bg-raised text-ink" : "text-mute hover:bg-raised/60 hover:text-ink"}`}>
                <n.icon size={16} className={active ? "text-accent" : ""} />{n.label}
              </button>); })}
          </div>
          <div className="mt-auto rounded-xl border border-line bg-bg p-3">
            <div className="flex items-center gap-2 text-[12px] font-semibold"><Sparkles size={13} className={status.ai.backend === "none" ? "text-faint" : "text-ai"} />{AI_LABEL[status.ai.backend]}</div>
            <div className="mt-1 text-[11px] leading-snug text-mute">{status.ai.backend === "none" ? "Autopilot runs on rules. Add an API key on the server for AI planning and chat." : `Planning, chat and vision via ${status.ai.model}.`}</div>
          </div>
        </nav>
      )}
      <main className="min-w-0 flex-1 overflow-hidden">
        {editorId ? <Editor key={editorId} projectId={editorId} />
          : route.path.startsWith("/ideas") ? <Ideas />
          : route.path.startsWith("/create") ? <Create key={route.params.toString()} trendId={route.params.get("trend")} ideaId={route.params.get("idea")} />
          : route.path.startsWith("/projects") ? <Projects />
          : route.path.startsWith("/library") ? <Library />
          : <Trends openId={route.params.get("open")} />}
      </main>
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`pointer-events-auto max-w-sm rounded-xl border px-4 py-3 text-[13px] shadow-xl ${t.kind === "error" ? "border-hot/40 bg-[#2a1118] text-[#ffc2cd]" : t.kind === "ok" ? "border-ok/40 bg-[#0f2a20] text-[#b8f5dc]" : "border-line bg-raised text-ink"}`}>{t.text}</div>)}
      </div>
    </div>
  );
}
