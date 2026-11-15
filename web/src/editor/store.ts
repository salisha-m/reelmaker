import { create } from "zustand";
import type { ProjectAsset, Timeline } from "@shared/types";
import * as T from "@shared/timeline";
import { api, ApiError, type ProjectInfo } from "../api";
import { useApp } from "../store";

const clientId = Math.random().toString(36).slice(2, 10);
interface EditorState {
  projectId: string | null; project: ProjectInfo | null; timeline: Timeline | null; assets: ProjectAsset[]; assetMap: Record<string, ProjectAsset>;
  selection: string[]; playhead: number; playing: boolean; pps: number; magnet: boolean;
  past: Timeline[]; future: Timeline[]; saving: "idle" | "saving" | "saved" | "error"; loadError: string | null;
  /** Timeline shown while dragging; committed or dropped on release. */
  draft: Timeline | null;
  load: (id: string) => Promise<void>;
  mutate: (fn: (tl: Timeline) => void) => boolean;
  setDraft: (tl: Timeline | null) => void;
  commitDraft: () => void;
  applyServer: (tl: Timeline, history?: boolean) => void;
  runTool: (name: string, input: unknown) => Promise<any>;
  undo: () => void; redo: () => void;
  select: (ids: string[], additive?: boolean) => void;
  setAssets: (a: ProjectAsset[]) => void;
  set: (p: Partial<EditorState>) => void;
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let serverVersion = 0;

export const useEditor = create<EditorState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    set({ saving: "saving" });
    saveTimer = setTimeout(async () => {
      const { projectId, timeline } = get();
      if (!projectId || !timeline) return;
      try {
        const r = await api.saveTimeline(projectId, timeline, serverVersion, clientId);
        serverVersion = r.timeline.version;
        // keep local edits made while the save was in flight
        if (get().timeline === timeline) set({ timeline: r.timeline, saving: "saved" }); else { set({ saving: "saving" }); scheduleSave(); }
      } catch (e) {
        if (e instanceof ApiError && e.code === "STALE" && e.body?.timeline) { serverVersion = e.body.timeline.version; set({ timeline: e.body.timeline, saving: "saved", past: [], future: [] }); useApp.getState().toast("The edit changed elsewhere, so the latest version was loaded.", "info"); }
        else { set({ saving: "error" }); useApp.getState().toast(`Your change was not saved: ${(e as Error).message}`, "error"); }
      }
    }, 450);
  };
  const push = (next: Timeline) => { const cur = get().timeline; set({ timeline: next, past: cur ? [...get().past.slice(-60), cur] : get().past, future: [], draft: null }); };
  return {
    projectId: null, project: null, timeline: null, assets: [], assetMap: {}, selection: [], playhead: 0, playing: false, pps: 80, magnet: true, past: [], future: [], saving: "idle", loadError: null, draft: null,
    set: (p) => set(p),
    load: async (id) => {
      set({ projectId: id, project: null, timeline: null, selection: [], playhead: 0, past: [], future: [], loadError: null, draft: null });
      try {
        const r = await api.project(id);
        serverVersion = r.timeline.version;
        set({ project: r.project, timeline: r.timeline, assets: r.assets, assetMap: Object.fromEntries(r.assets.map((a) => [a.id, a])) });
      } catch (e) { set({ loadError: (e as Error).message }); }
    },
    setAssets: (a) => set({ assets: a, assetMap: Object.fromEntries(a.map((x) => [x.id, x])) }),
    mutate: (fn) => {
      const cur = get().timeline;
      if (!cur) return false;
      const next = structuredClone(cur);
      try { fn(next); } catch (e) { useApp.getState().toast(e instanceof T.OpError ? e.message : (e as Error).message, "error"); return false; }
      T.syncCaptions(next);
      const problems = T.validateTimeline(next);
      if (problems.length) { useApp.getState().toast(`That edit is not possible: ${problems[0]}`, "error"); return false; }
      push(next);
      set({ selection: get().selection.filter((id) => next.items[id]) });
      scheduleSave();
      return true;
    },
    setDraft: (tl) => set({ draft: tl }),
    commitDraft: () => { const d = get().draft; if (!d) return; T.syncCaptions(d); if (T.validateTimeline(d).length) { set({ draft: null }); return; } push(d); scheduleSave(); },
    applyServer: (tl, history = true) => {
      serverVersion = tl.version;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (history) push(tl); else set({ timeline: tl, draft: null });
      set({ saving: "saved", selection: get().selection.filter((id) => tl.items[id]) });
    },
    runTool: async (name, input) => {
      const { projectId, selection, playhead } = get();
      if (!projectId) return null;
      try {
        // make sure the server has the latest hand edits before a tool builds on them
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; const r0 = await api.saveTimeline(projectId, get().timeline!, serverVersion, clientId); serverVersion = r0.timeline.version; }
        const r = await api.tool(projectId, name, input, { selection, playheadMs: playhead });
        get().applyServer(r.timeline);
        return r.result;
      } catch (e) {
        const body = e instanceof ApiError ? e.body : null;
        useApp.getState().toast(body?.result?.error ?? (e as Error).message, "error");
        return body?.result ?? null;
      }
    },
    undo: () => { const { past, timeline, future } = get(); if (!past.length || !timeline) return; const prev = past[past.length - 1]!; set({ timeline: { ...prev, version: timeline.version }, past: past.slice(0, -1), future: [timeline, ...future], draft: null }); scheduleSave(); },
    redo: () => { const { past, timeline, future } = get(); if (!future.length || !timeline) return; const next = future[0]!; set({ timeline: { ...next, version: timeline.version }, past: [...past, timeline], future: future.slice(1), draft: null }); scheduleSave(); },
    select: (ids, additive) => set({ selection: additive ? [...new Set([...get().selection.filter((x) => !ids.includes(x)), ...ids.filter((x) => !get().selection.includes(x))])] : ids }),
  };
});

// edits made by the assistant or another window arrive over the event stream
window.addEventListener("app-event", (ev) => {
  const e = (ev as CustomEvent).detail;
  const s = useEditor.getState();
  if (e.type === "timeline" && e.projectId === s.projectId && e.clientId !== clientId && e.timeline?.version !== s.timeline?.version) s.applyServer(e.timeline, e.by !== "editor");
  if (e.type === "asset" && s.assetMap[e.asset.id]) s.setAssets(s.assets.map((a) => (a.id === e.asset.id ? { ...e.asset, agentId: a.agentId } : a)));
  if (e.type === "project" && e.project.id === s.projectId) s.set({ project: e.project });
});
export { clientId };
