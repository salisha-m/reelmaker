// Projects: a timeline plus the footage it draws from, version snapshots and exports.
import fs from "node:fs";
import path from "node:path";
import type { ExportSettings, Project, ProjectAsset, RenderJob, Timeline } from "../../shared/types.ts";
import type { RemixReport } from "../../shared/trends.ts";
import * as T from "../../shared/timeline.ts";
import { CANVAS_PRESETS } from "../../shared/catalog.ts";
import * as db from "./db.ts";
import { dirs } from "./config.ts";
import { emit } from "./events.ts";
import { getAsset, publicAsset, type AssetDoc } from "./pipeline.ts";
import { captureFrame, exportSize, renderTimeline } from "./render.ts";

export interface ProjectDoc { id: string; name: string; createdAt: string; updatedAt: string; templateId: string | null; styleId: string; trendId: string | null; assets: { assetId: string; agentId: string }[]; thumbnail: string | null; report?: RemixReport | null; conversationId?: string | null }

export const getProject = (id: string) => db.get<ProjectDoc>("project", id);
export const getTimeline = (id: string) => db.get<Timeline>("timeline", id);
export function listProjects(): Project[] {
  return db.list<ProjectDoc>("project").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicProject);
}
export function publicProject(p: ProjectDoc): Project & { trendId: string | null; report?: RemixReport | null } {
  const tl = getTimeline(p.id);
  return { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, templateId: p.templateId, styleId: p.styleId, referenceId: null, trendId: p.trendId, thumbnail: p.thumbnail, durationMs: tl ? T.timelineDuration(tl) : 0, itemCount: tl ? Object.keys(tl.items).length : 0, report: p.report ?? null };
}
export function projectAssets(p: ProjectDoc): { asset: AssetDoc; agentId: string }[] {
  return p.assets.map((x) => ({ asset: getAsset(x.assetId), agentId: x.agentId })).filter((x): x is { asset: AssetDoc; agentId: string } => !!x.asset);
}
export function publicProjectAssets(p: ProjectDoc): ProjectAsset[] {
  return projectAssets(p).map(({ asset, agentId }) => ({ ...publicAsset(asset), agentId }));
}
/** Short ids the agent uses for footage: video_1, audio_2, image_1. */
export function addAssetsToProject(p: ProjectDoc, assetIds: string[]): ProjectDoc {
  for (const id of assetIds) {
    if (p.assets.some((a) => a.assetId === id)) continue;
    const a = getAsset(id);
    if (!a) continue;
    const n = p.assets.filter((x) => x.agentId.startsWith(`${a.type}_`)).length + 1;
    p.assets.push({ assetId: id, agentId: `${a.type}_${n}` });
  }
  return p;
}
export function createProject(input: { name?: string; aspect?: string; assetIds?: string[]; trendId?: string | null; timeline?: Timeline; report?: RemixReport | null }): ProjectDoc {
  const c = CANVAS_PRESETS.find((x) => x.id === (input.aspect ?? "9:16")) ?? CANVAS_PRESETS[0]!;
  const now = new Date().toISOString();
  const p: ProjectDoc = { id: db.newId("p"), name: input.name?.trim() || "Untitled project", createdAt: now, updatedAt: now, templateId: null, styleId: "studio", trendId: input.trendId ?? null, assets: [], thumbnail: null, report: input.report ?? null };
  addAssetsToProject(p, input.assetIds ?? []);
  db.put("project", p.id, p);
  db.put("timeline", p.id, input.timeline ?? T.emptyTimeline(c.width, c.height, 30));
  void refreshThumbnail(p.id);
  emit({ type: "project", project: publicProject(p) });
  return p;
}
export function saveProject(p: ProjectDoc) { p.updatedAt = new Date().toISOString(); db.put("project", p.id, p); emit({ type: "project", project: publicProject(p) }); }
export function saveTimeline(projectId: string, tl: Timeline) {
  db.put("timeline", projectId, tl);
  const p = getProject(projectId);
  if (p) { p.updatedAt = new Date().toISOString(); db.put("project", p.id, p); }
  scheduleThumb(projectId);
}
export function deleteProject(id: string) {
  db.del("project", id); db.del("timeline", id);
  for (const s of db.list<Snapshot>("snapshot")) if (s.projectId === id) db.del("snapshot", s.id);
  emit({ type: "project-deleted", id });
}

const thumbTimers = new Map<string, NodeJS.Timeout>();
function scheduleThumb(id: string) { clearTimeout(thumbTimers.get(id)); thumbTimers.set(id, setTimeout(() => void refreshThumbnail(id), 2500)); }
export async function refreshThumbnail(id: string) {
  const p = getProject(id), tl = getTimeline(id);
  if (!p || !tl || !Object.keys(tl.items).length) return;
  try {
    const assets = Object.fromEntries(projectAssets(p).map((x) => [x.asset.id, x.asset]));
    for (const it of Object.values(tl.items)) if (T.isMedia(it) && !assets[it.assetId]) { const a = getAsset(it.assetId); if (a) assets[a.id] = a; }
    const buf = await captureFrame(tl, assets, Math.min(1500, T.timelineDuration(tl) / 3), 480);
    fs.writeFileSync(path.join(dirs.thumbs, `project_${id}.jpg`), buf);
    const fresh = getProject(id);
    if (fresh) { fresh.thumbnail = `/media/thumb/project_${id}.jpg?v=${Date.now()}`; db.put("project", id, fresh); emit({ type: "project", project: publicProject(fresh) }); }
  } catch (e) { console.warn("[thumb]", (e as Error).message); }
}

// ---------- version snapshots (every AI turn and every export keeps one) ----------
export interface Snapshot { id: string; projectId: string; label: string; createdAt: string; timeline: Timeline; turnId?: string }
export function snapshot(projectId: string, label: string, turnId?: string): Snapshot | null {
  const tl = getTimeline(projectId);
  if (!tl) return null;
  const s: Snapshot = { id: db.newId("snap"), projectId, label, createdAt: new Date().toISOString(), timeline: tl, turnId };
  db.put("snapshot", s.id, s);
  const mine = db.list<Snapshot>("snapshot").filter((x) => x.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of mine.slice(40)) db.del("snapshot", old.id);
  return s;
}
export function restoreSnapshot(projectId: string, by: { id?: string; turnId?: string }): Timeline | null {
  const s = db.list<Snapshot>("snapshot").find((x) => x.projectId === projectId && (by.id ? x.id === by.id : x.turnId === by.turnId));
  if (!s) return null;
  const cur = getTimeline(projectId);
  const tl = { ...s.timeline, version: (cur?.version ?? s.timeline.version) + 1 };
  saveTimeline(projectId, tl);
  emit({ type: "timeline", projectId, timeline: tl, by: "restore" });
  return tl;
}
export const listSnapshots = (projectId: string) => db.list<Snapshot>("snapshot").filter((x) => x.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ timeline: _t, ...rest }) => rest);

// ---------- exports ----------
const cancelled = new Set<string>();
const renderQueue: string[] = [];
let rendering = false;
export const getRender = (id: string) => db.get<RenderJob>("render", id);
export const listRenders = (projectId?: string) => db.list<RenderJob>("render").filter((r) => !projectId || r.projectId === projectId);
function saveRender(j: RenderJob) { db.put("render", j.id, j); emit({ type: "render", render: j }); }
export function startExport(projectId: string, settings: ExportSettings, opts: { muteItemIds?: string[] } = {}): RenderJob {
  const p = getProject(projectId), tl = getTimeline(projectId);
  if (!p || !tl) throw new T.OpError("PROJECT_NOT_FOUND", "Project not found.");
  const dur = Math.min(settings.endMs ?? Infinity, T.timelineDuration(tl)) - (settings.startMs ?? 0);
  if (!(dur > 0)) throw new T.OpError("EMPTY_TIMELINE", "There is nothing on the timeline to export.");
  const size = exportSize(tl, settings.resolution);
  const id = db.newId("r");
  const safe = (settings.filename || p.name).replace(/[^\w .-]+/g, "").trim().slice(0, 80) || "export";
  const job: RenderJob & { muteItemIds?: string[] } = { id, projectId, status: "queued", progress: 0, createdAt: new Date().toISOString(), finishedAt: null, error: null, settings, width: size.width, height: size.height, durationMs: Math.round(dur), sizeBytes: null, url: null, filename: `${safe}.${settings.format}`, muteItemIds: opts.muteItemIds };
  saveRender(job);
  snapshot(projectId, `Export ${job.filename}`);
  renderQueue.push(id);
  void pumpRenders();
  return job;
}
export function cancelRender(id: string) { cancelled.add(id); const j = getRender(id); if (j && j.status === "queued") { j.status = "cancelled"; saveRender(j); } }
async function pumpRenders() {
  if (rendering) return;
  rendering = true;
  while (renderQueue.length) {
    const id = renderQueue.shift()!;
    const job = getRender(id) as (RenderJob & { muteItemIds?: string[] }) | null;
    if (!job || job.status === "cancelled") continue;
    const p = getProject(job.projectId), tl = getTimeline(job.projectId);
    if (!p || !tl) { job.status = "failed"; job.error = "The project no longer exists."; saveRender(job); continue; }
    const assets: Record<string, AssetDoc> = Object.fromEntries(projectAssets(p).map((x) => [x.asset.id, x.asset]));
    for (const it of Object.values(tl.items)) if (T.isMedia(it) && !assets[it.assetId]) { const a = getAsset(it.assetId); if (a) assets[a.id] = a; }
    const out = path.join(dirs.renders, `${id}.${job.settings.format}`);
    job.status = "rendering"; saveRender(job);
    let last = 0;
    try {
      await renderTimeline(tl, assets, { settings: job.settings, out, muteItemIds: job.muteItemIds, isCancelled: () => cancelled.has(id), onProgress: (pr, stage) => { if (Date.now() - last > 500 || pr >= 1) { last = Date.now(); job.progress = pr; job.status = stage === "encoding" ? "encoding" : "rendering"; saveRender(job); } } });
      job.status = "completed"; job.progress = 1; job.finishedAt = new Date().toISOString(); job.sizeBytes = fs.statSync(out).size; job.url = `/media/render/${id}.${job.settings.format}`;
    } catch (e) {
      job.status = cancelled.has(id) ? "cancelled" : "failed"; job.error = cancelled.has(id) ? null : (e as Error).message; job.finishedAt = new Date().toISOString();
    }
    saveRender(job);
  }
  rendering = false;
}
