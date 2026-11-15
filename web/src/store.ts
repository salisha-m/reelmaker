import { create } from "zustand";
import type { Asset, RenderJob } from "@shared/types";
import type { Idea, TrendPost, TrendSound } from "@shared/trends";
import { api, type Catalog, type ProjectInfo, type Status } from "./api";

interface AppState {
  status: Status | null; catalog: Catalog | null; assets: Asset[]; trends: TrendPost[]; sounds: TrendSound[]; projects: ProjectInfo[]; ideas: Idea[]; renders: RenderJob[];
  toasts: { id: number; text: string; kind: "info" | "error" | "ok" }[];
  fontsReady: boolean;
  load: () => Promise<void>; toast: (text: string, kind?: "info" | "error" | "ok") => void; refresh: (what: "assets" | "trends" | "projects" | "ideas" | "status" | "renders") => Promise<void>;
}
let toastId = 0;
const upsert = <T extends { id: string }>(list: T[], item: T, front = true): T[] => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : front ? [item, ...list] : [...list, item]);

export const useApp = create<AppState>((set, get) => ({
  status: null, catalog: null, assets: [], trends: [], sounds: [], projects: [], ideas: [], renders: [], toasts: [], fontsReady: false,
  toast: (text, kind = "info") => { const id = ++toastId; set((s) => ({ toasts: [...s.toasts, { id, text, kind }] })); setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 7000 : 3800); },
  refresh: async (what) => {
    try {
      if (what === "assets") set({ assets: (await api.assets()).assets });
      else if (what === "trends") { const t = await api.trends(); set({ trends: t.trends, sounds: t.sounds }); }
      else if (what === "projects") set({ projects: (await api.projects()).projects });
      else if (what === "ideas") set({ ideas: (await api.ideas()).ideas });
      else if (what === "renders") set({ renders: (await api.renders()).renders });
      else set({ status: await api.status() });
    } catch (e) { get().toast((e as Error).message, "error"); }
  },
  load: async () => {
    const [status, catalog, assets, trends, projects, ideas, renders] = await Promise.all([api.status(), api.catalog(), api.assets(), api.trends(), api.projects(), api.ideas(), api.renders()]);
    set({ status, catalog, assets: assets.assets, trends: trends.trends, sounds: trends.sounds, projects: projects.projects, ideas: ideas.ideas, renders: renders.renders });
    // the canvas draws text with the exact font files the export uses
    await Promise.all(catalog.fonts.map(async (f) => { try { const face = new FontFace(f.key, `url(${f.url})`); await face.load(); (document.fonts as any).add(face); } catch { /* font missing */ } }));
    set({ fontsReady: true });
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      let e: any; try { e = JSON.parse(m.data); } catch { return; }
      const s = get();
      if (e.type === "asset") { if (e.asset.origin?.kind !== "trend") set({ assets: upsert(s.assets, e.asset) }); }
      else if (e.type === "asset-deleted") set({ assets: s.assets.filter((a) => a.id !== e.id) });
      else if (e.type === "trend") set({ trends: upsert(s.trends, e.trend).sort((a, b) => b.viralScore - a.viralScore) });
      else if (e.type === "trend-deleted") set({ trends: s.trends.filter((t) => t.id !== e.id) });
      else if (e.type === "sound") set({ sounds: upsert(s.sounds, e.sound) });
      else if (e.type === "project") set({ projects: upsert(s.projects, e.project) });
      else if (e.type === "project-deleted") set({ projects: s.projects.filter((p) => p.id !== e.id) });
      else if (e.type === "render") set({ renders: upsert(s.renders, e.render) });
      window.dispatchEvent(new CustomEvent("app-event", { detail: e }));
    };
  },
}));

// ---- tiny hash router ----
export function useRoute(): { path: string; params: URLSearchParams } {
  const parse = () => { const h = location.hash.replace(/^#/, "") || "/trends"; const [p, q] = h.split("?"); return { path: p!, params: new URLSearchParams(q ?? "") }; };
  const s = useRouteStore((x) => x.tick);
  void s;
  return parse();
}
const useRouteStore = create<{ tick: number }>(() => ({ tick: 0 }));
window.addEventListener("hashchange", () => useRouteStore.setState((s) => ({ tick: s.tick + 1 })));
export const go = (hash: string) => { location.hash = hash; };

export const fmtTime = (ms: number) => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
export const fmtTimeFine = (ms: number) => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
export const fmtCount = (n: number | null | undefined) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(n));
export const fmtBytes = (n: number | null | undefined) => (n == null ? "" : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
