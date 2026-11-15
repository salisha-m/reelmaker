import type { Asset, ChatMessage, Project, ProjectAsset, RenderJob, Timeline, CaptionStyle } from "@shared/types";
import type { CreatorProfile, Idea, RemixReport, TrendCandidate, TrendPost, TrendSound, WatchSource } from "@shared/trends";
import type { CaptionTemplate, ExportPreset, FilterPreset } from "@shared/catalog";

export class ApiError extends Error { code: string; status: number; body: any; constructor(status: number, body: any) { super(body?.error ?? `Request failed (${status})`); this.status = status; this.code = body?.code ?? "ERROR"; this.body = body; } }
async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body instanceof FormData || body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}
export interface Catalog { captionLooks: CaptionTemplate[]; fonts: { family: string; weight: number; file: string; key: string; url: string }[]; filters: FilterPreset[]; exportPresets: ExportPreset[]; canvasPresets: { id: string; label: string; width: number; height: number }[]; transitions: string[] }
export interface Status { app: string; ai: { backend: "anthropic-api" | "claude-code" | "none"; model: string; calls: number; costUsd: number }; counts: { assets: number; trends: number; projects: number } }
export type ProjectInfo = Project & { trendId: string | null; report?: RemixReport | null };
export interface ProjectPayload { project: ProjectInfo; timeline: Timeline; assets: ProjectAsset[] }
export interface SearchHit { assetId: string; name: string; kind: "said" | "shown"; fromSeconds: number; toSeconds: number; text: string; score: number }

export const api = {
  status: () => req<Status>("GET", "/api/status"),
  catalog: () => req<Catalog>("GET", "/api/catalog"),
  assets: () => req<{ assets: Asset[] }>("GET", "/api/assets"),
  deleteAsset: (id: string) => req("DELETE", `/api/assets/${id}`),
  search: (q: string, projectId?: string) => req<{ hits: SearchHit[] }>("GET", `/api/search?q=${encodeURIComponent(q)}${projectId ? `&projectId=${projectId}` : ""}`),
  projects: () => req<{ projects: ProjectInfo[] }>("GET", "/api/projects"),
  project: (id: string) => req<ProjectPayload>("GET", `/api/projects/${id}`),
  createProject: (b: { name?: string; aspect?: string; assetIds?: string[] }) => req<ProjectPayload>("POST", "/api/projects", b),
  patchProject: (id: string, b: { name?: string; addAssetIds?: string[] }) => req<ProjectPayload>("PATCH", `/api/projects/${id}`, b),
  deleteProject: (id: string) => req("DELETE", `/api/projects/${id}`),
  saveTimeline: (id: string, timeline: Timeline, baseVersion: number, clientId: string) => req<{ timeline: Timeline }>("PUT", `/api/projects/${id}/timeline`, { timeline, baseVersion, clientId }),
  tool: (id: string, name: string, input: unknown, extra: { selection?: string[]; playheadMs?: number } = {}) => req<{ result: any; timeline: Timeline }>("POST", `/api/projects/${id}/tool`, { name, input, ...extra }),
  chat: (id: string) => req<{ messages: ChatMessage[] }>("GET", `/api/projects/${id}/chat`),
  clearChat: (id: string) => req("DELETE", `/api/projects/${id}/chat`),
  revert: (id: string, turnId: string) => req<{ messages: ChatMessage[]; timeline: Timeline }>("POST", `/api/projects/${id}/chat/revert`, { turnId }),
  exportProject: (id: string, b: Record<string, unknown>) => req<{ render: RenderJob }>("POST", `/api/projects/${id}/export`, b),
  renders: (projectId?: string) => req<{ renders: RenderJob[] }>("GET", `/api/renders${projectId ? `?projectId=${projectId}` : ""}`),
  cancelRender: (id: string) => req("POST", `/api/renders/${id}/cancel`),
  trends: () => req<{ trends: TrendPost[]; sounds: TrendSound[] }>("GET", "/api/trends"),
  trend: (id: string) => req<{ trend: TrendPost; asset: Asset | null }>("GET", `/api/trends/${id}`),
  addTrendUrl: (url: string, deep: boolean) => req<{ trend: TrendPost }>("POST", "/api/trends/url", { url, deep }),
  deleteTrend: (id: string) => req("DELETE", `/api/trends/${id}`),
  watch: () => req<{ sources: WatchSource[]; candidates: TrendCandidate[] }>("GET", "/api/watch"),
  addWatch: (b: { platform: string; kind: string; value: string }) => req<{ source: WatchSource }>("POST", "/api/watch", b),
  deleteWatch: (id: string) => req("DELETE", `/api/watch/${id}`),
  refreshWatch: (id: string) => req<{ source: WatchSource; candidates: TrendCandidate[] }>("POST", `/api/watch/${id}/refresh`),
  profile: () => req<{ profile: CreatorProfile }>("GET", "/api/profile"),
  saveProfile: (p: Partial<CreatorProfile>) => req<{ profile: CreatorProfile }>("PUT", "/api/profile", p),
  ideas: () => req<{ ideas: Idea[] }>("GET", "/api/ideas"),
  refreshIdeas: (ai: boolean) => req<{ ideas: Idea[] }>("POST", "/api/ideas/refresh", { ai }),
  autopilot: (b: Record<string, unknown>) => req<ProjectPayload & { report: RemixReport }>("POST", "/api/autopilot", b),
};

/** Upload with progress. Extra fields ride along as form fields. */
export function upload<T>(url: string, files: File[], fields: Record<string, string> = {}, onProgress?: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of files) fd.append("files", f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => { let j: any = null; try { j = JSON.parse(xhr.responseText); } catch { /* not json */ } if (xhr.status >= 200 && xhr.status < 300) resolve(j as T); else reject(new ApiError(xhr.status, j)); };
    xhr.onerror = () => reject(new Error("The upload was interrupted. Check your connection and try again."));
    xhr.send(fd);
  });
}

/** Stream a chat turn. */
export async function streamChat(projectId: string, body: Record<string, unknown>, onEvent: (e: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) { const j = await res.json().catch(() => null); throw new ApiError(res.status, j); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) if (line.startsWith("data: ")) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* partial */ } }
    }
  }
}
export type { CaptionStyle };
