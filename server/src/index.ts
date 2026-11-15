import express, { type Request, type Response, type NextFunction } from "express";
import Busboy from "busboy";
import fs from "node:fs";
import path from "node:path";
import { APP_NAME, CANVAS_PRESETS, CAPTION_TEMPLATES, EFFECT_INFO, EXPORT_PRESETS, FILTERS, FONTS, STYLES, TEMPLATES, TRANSITION_KINDS, fontKey } from "../../shared/catalog.ts";
import type { CreatorProfile } from "../../shared/trends.ts";
import type { ExportSettings, Timeline } from "../../shared/types.ts";
import * as T from "../../shared/timeline.ts";
import { DATA_DIR, FONTS_DIR, PORT, ROOT, dirs } from "./config.ts";
import * as db from "./db.ts";
import { bus, emit, type AppEvent } from "./events.ts";
import { aiStatus } from "./llm.ts";
import { createAsset, deleteAsset, enqueue, getAsset, listAssets, publicAsset, type AssetDoc } from "./pipeline.ts";
import { addAssetsToProject, cancelRender, createProject, deleteProject, getProject, getRender, getTimeline, listProjects, listRenders, listSnapshots, publicProject, publicProjectAssets, restoreSnapshot, saveProject, saveTimeline, snapshot, startExport } from "./projects.ts";
import { addSource, deleteTrend, getTrend, ingestTrendFile, ingestTrendUrl, listCandidates, listSounds, listSources, listTrends, publicSound, publicTrend, refreshSource } from "./trends.ts";
import { aiPlan, getProfile, listIdeas, remix, suggestIdeas } from "./autopilot.ts";
import { TOOLS, runTool, searchAssets, toolJsonSchema, type ToolContext } from "./agent/tools.ts";
import { clearChat, getChat, revertTurn, runChatTurn, SYSTEM_PROMPT } from "./agent/chat.ts";
import { captureFrame, registerFonts } from "./render.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "25mb" }));
const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
const fail = (res: Response, status: number, error: string, code = "ERROR") => res.status(status).json({ error, code });

// ---------- files ----------
const stat = (dir: string, immutable = false) => express.static(dir, { maxAge: immutable ? "7d" : 0, acceptRanges: true, fallthrough: false, index: false });
app.use("/media/original", stat(dirs.uploads, true));
app.use("/media/proxy", stat(dirs.proxies, true));
app.use("/media/thumb", stat(dirs.thumbs));
app.use("/media/render", (req, res, next) => { if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename="${String(req.query.download).replace(/[^\w .-]+/g, "")}"`); next(); }, stat(dirs.renders));
app.use("/fonts", stat(FONTS_DIR, true));

/** Receive multipart uploads straight to disk. */
function receiveFiles(req: Request): Promise<{ files: { tmpPath: string; name: string; mime: string }[]; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 * 1024, files: 50 }, defParamCharset: "utf8" });
    const files: { tmpPath: string; name: string; mime: string }[] = [];
    const fields: Record<string, string> = {};
    const writes: Promise<void>[] = [];
    bb.on("file", (_name, stream, info) => {
      const tmpPath = path.join(dirs.tmp, `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(info.filename || "").toLowerCase().replace(/[^.a-z0-9]/g, "")}`);
      const out = fs.createWriteStream(tmpPath);
      stream.pipe(out);
      writes.push(new Promise((r, j) => { out.on("finish", () => r()); out.on("error", j); stream.on("error", j); }));
      files.push({ tmpPath, name: path.basename(info.filename || "upload"), mime: info.mimeType });
    });
    bb.on("field", (k, v) => { fields[k] = v; });
    bb.on("error", reject);
    bb.on("close", () => { Promise.all(writes).then(() => resolve({ files, fields }), reject); });
    req.pipe(bb);
  });
}

// ---------- status, catalog, events ----------
app.get("/api/status", (_req, res) => res.json({ app: APP_NAME, ai: aiStatus(), counts: { assets: listAssets().filter((a) => !a.origin).length, trends: listTrends().length, projects: listProjects().length } }));
app.get("/api/catalog", (_req, res) => res.json({ captionLooks: CAPTION_TEMPLATES, styles: STYLES, templates: TEMPLATES, fonts: FONTS.map((f) => ({ ...f, key: fontKey(f.family, f.weight), url: `/fonts/${f.file}` })), filters: FILTERS, effects: EFFECT_INFO, exportPresets: EXPORT_PRESETS, canvasPresets: CANVAS_PRESETS, transitions: TRANSITION_KINDS }));
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": connected\n\n");
  const on = (e: AppEvent) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
  bus.on("event", on);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { bus.off("event", on); clearInterval(ping); });
});

// ---------- footage library ----------
const libraryAssets = () => listAssets().filter((a) => a.origin?.kind !== "trend");
app.get("/api/assets", (_req, res) => res.json({ assets: libraryAssets().map(publicAsset) }));
app.post("/api/assets", wrap(async (req, res) => {
  const { files, fields } = await receiveFiles(req);
  if (!files.length) return fail(res, 400, "No file was received.");
  const created = [], errors = [];
  for (const f of files) {
    try { created.push(publicAsset(await createAsset({ tmpPath: f.tmpPath, name: f.name, mime: f.mime, contentType: fields.contentType === "music" ? "music" : "footage" }))); }
    catch (e) { fs.rmSync(f.tmpPath, { force: true }); errors.push({ name: f.name, error: (e as Error).message }); }
  }
  if (fields.projectId) { const p = getProject(fields.projectId); if (p) { addAssetsToProject(p, created.map((a) => a.id)); saveProject(p); } }
  res.status(created.length ? 201 : 400).json({ assets: created, errors });
}));
app.delete("/api/assets/:id", (req, res) => { deleteAsset(req.params.id!); res.json({ ok: true }); });
app.post("/api/assets/:id/reindex", (req, res) => {
  const a = getAsset(req.params.id!);
  if (!a) return fail(res, 404, "Not found");
  for (const k of Object.keys(a.steps) as (keyof AssetDoc["steps"])[]) if (a.steps[k] === "error" || (k === "scenes" && a.steps[k] === "done")) a.steps[k] = "pending";
  a.status = "processing"; db.put("asset", a.id, a); enqueue(a.id);
  res.json({ asset: publicAsset(a) });
});
app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "");
  const scope = req.query.projectId ? (publicProjectAssets(getProject(String(req.query.projectId))!).map((a) => getAsset(a.id)!).filter(Boolean)) : libraryAssets();
  res.json({ hits: searchAssets(scope, q).slice(0, 40) });
});

// ---------- projects ----------
function projectPayload(id: string) {
  const p = getProject(id);
  if (!p) return null;
  return { project: publicProject(p), timeline: getTimeline(id), assets: publicProjectAssets(p) };
}
app.get("/api/projects", (_req, res) => res.json({ projects: listProjects() }));
app.post("/api/projects", (req, res) => { const p = createProject({ name: req.body?.name, aspect: req.body?.aspect, assetIds: req.body?.assetIds }); res.status(201).json(projectPayload(p.id)); });
app.get("/api/projects/:id", (req, res) => { const out = projectPayload(req.params.id!); return out ? res.json(out) : fail(res, 404, "Project not found"); });
app.patch("/api/projects/:id", (req, res) => {
  const p = getProject(req.params.id!);
  if (!p) return fail(res, 404, "Project not found");
  if (typeof req.body?.name === "string" && req.body.name.trim()) p.name = req.body.name.trim().slice(0, 120);
  if (Array.isArray(req.body?.addAssetIds)) addAssetsToProject(p, req.body.addAssetIds);
  saveProject(p);
  res.json(projectPayload(p.id));
});
app.delete("/api/projects/:id", (req, res) => { deleteProject(req.params.id!); res.json({ ok: true }); });
/** The editor saves hand edits here. A stale save (someone else changed the timeline since) is rejected with the current one. */
app.put("/api/projects/:id/timeline", (req, res) => {
  const cur = getTimeline(req.params.id!);
  if (!cur) return fail(res, 404, "Project not found");
  const tl = req.body?.timeline as Timeline | undefined;
  if (!tl?.tracks || !tl.items) return fail(res, 400, "A timeline is required.");
  if (typeof req.body.baseVersion === "number" && req.body.baseVersion !== cur.version) return res.status(409).json({ error: "The timeline changed since you loaded it.", code: "STALE", timeline: cur });
  T.syncCaptions(tl);
  const problems = T.validateTimeline(tl);
  if (problems.length) return fail(res, 422, `That edit would leave the timeline inconsistent: ${problems.slice(0, 2).join("; ")}`, "INVALID");
  tl.version = cur.version + 1;
  saveTimeline(req.params.id!, tl);
  emit({ type: "timeline", projectId: req.params.id!, timeline: tl, by: "editor", clientId: req.body.clientId });
  res.json({ timeline: tl });
});
app.post("/api/projects/:id/tool", wrap(async (req, res) => {
  const ctx: ToolContext = { projectId: req.params.id!, selection: req.body?.selection, playheadMs: req.body?.playheadMs };
  if (req.body?.snapshot !== false) snapshot(ctx.projectId, `Before ${req.body?.name}`);
  const { images: _i, ...r } = await runTool(ctx, String(req.body?.name), req.body?.input ?? {});
  res.status(r.ok ? 200 : 422).json({ result: r, timeline: getTimeline(ctx.projectId) });
}));
app.get("/api/projects/:id/frame", wrap(async (req, res) => {
  const p = getProject(req.params.id!), tl = getTimeline(req.params.id!);
  if (!p || !tl) return fail(res, 404, "Project not found");
  const assets = Object.fromEntries(publicProjectAssets(p).map((a) => [a.id, getAsset(a.id)!]));
  for (const it of Object.values(tl.items)) if (T.isMedia(it) && !assets[it.assetId]) { const a = getAsset(it.assetId); if (a) assets[a.id] = a; }
  res.type("image/jpeg").send(await captureFrame(tl, assets, Number(req.query.t ?? 0) * 1000, Number(req.query.size ?? 720)));
}));
app.get("/api/projects/:id/versions", (req, res) => res.json({ versions: listSnapshots(req.params.id!) }));
app.post("/api/projects/:id/versions/:sid/restore", (req, res) => { const tl = restoreSnapshot(req.params.id!, { id: req.params.sid }); return tl ? res.json({ timeline: tl }) : fail(res, 404, "Version not found"); });

// ---------- chat ----------
app.get("/api/projects/:id/chat", (req, res) => res.json({ messages: getChat(req.params.id!).messages, ai: aiStatus() }));
app.delete("/api/projects/:id/chat", (req, res) => { clearChat(req.params.id!); res.json({ ok: true }); });
app.post("/api/projects/:id/chat", (req, res) => {
  if (!getProject(req.params.id!)) return void fail(res, 404, "Project not found");
  const text = String(req.body?.message ?? "").trim();
  if (!text) return void fail(res, 400, "Say what you want changed.");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  const ctx: ToolContext = { projectId: req.params.id!, selection: req.body?.selection, playheadMs: req.body?.playheadMs, rangeMs: req.body?.rangeMs ?? null };
  runChatTurn(ctx, text.slice(0, 8000), (e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); }, ac.signal)
    .catch((e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: "error", message: (e as Error).message })}\n\n`); })
    .finally(() => res.end());
});
app.post("/api/projects/:id/chat/revert", (req, res) => (revertTurn(req.params.id!, String(req.body?.turnId)) ? res.json({ messages: getChat(req.params.id!).messages, timeline: getTimeline(req.params.id!) }) : fail(res, 404, "Nothing to restore for that message.")));

// ---------- exports ----------
app.post("/api/projects/:id/export", (req, res) => {
  const b = req.body ?? {};
  const preset = EXPORT_PRESETS.find((p) => p.id === b.preset) ?? EXPORT_PRESETS[0]!;
  const settings: ExportSettings = { preset: preset.id, resolution: b.resolution ?? preset.resolution, bitrateMbps: Math.min(80, Math.max(1, Number(b.bitrateMbps ?? preset.bitrateMbps))), format: b.format === "webm" ? "webm" : b.format === "mp4" ? "mp4" : preset.format, fps: b.fps, filename: b.filename, startMs: b.startMs, endMs: b.endMs };
  try {
    let mute: string[] | undefined;
    if (b.muteMusic) { const tl = getTimeline(req.params.id!); mute = tl ? Object.values(tl.items).filter((i) => T.isMedia(i) && getAsset(i.assetId)?.contentType === "music").map((i) => i.id) : []; }
    res.status(202).json({ render: startExport(req.params.id!, settings, { muteItemIds: mute }) });
  } catch (e) { fail(res, 422, (e as Error).message); }
});
app.get("/api/renders", (req, res) => res.json({ renders: listRenders(req.query.projectId ? String(req.query.projectId) : undefined) }));
app.get("/api/renders/:id", (req, res) => { const r = getRender(req.params.id!); return r ? res.json({ render: r }) : fail(res, 404, "Not found"); });
app.post("/api/renders/:id/cancel", (req, res) => { cancelRender(req.params.id!); res.json({ ok: true }); });

// ---------- trends ----------
app.get("/api/trends", (_req, res) => res.json({ trends: listTrends().map(publicTrend), sounds: listSounds().map(publicSound) }));
app.get("/api/trends/:id", (req, res) => { const t = getTrend(req.params.id!); return t ? res.json({ trend: publicTrend(t), asset: t.assetId && getAsset(t.assetId) ? publicAsset(getAsset(t.assetId)!) : null }) : fail(res, 404, "Trend not found"); });
app.post("/api/trends/url", wrap(async (req, res) => { const t = await ingestTrendUrl(String(req.body?.url ?? "").trim(), { deep: req.body?.deep }); res.status(202).json({ trend: publicTrend(t) }); }));
app.post("/api/trends/upload", wrap(async (req, res) => {
  const { files, fields } = await receiveFiles(req);
  if (!files.length) return fail(res, 400, "No file was received.");
  const num = (v?: string) => (v && /^\d[\d,. ]*[kKmM]?$/.test(v.trim()) ? Math.round(parseFloat(v.replace(/[, ]/g, "")) * (/[kK]$/.test(v.trim()) ? 1e3 : /[mM]$/.test(v.trim()) ? 1e6 : 1)) : undefined);
  const out = [];
  for (const f of files) out.push(publicTrend(await ingestTrendFile(f.tmpPath, f.name, { title: files.length === 1 ? fields.title : undefined, platform: (fields.platform as any) || "upload", url: fields.url || null, handle: fields.handle?.replace(/^@/, "") || null, soundTitle: fields.soundTitle || null, stats: { views: num(fields.views), likes: num(fields.likes), comments: num(fields.comments), shares: num(fields.shares) }, hashtags: (fields.hashtags ?? "").split(/[\s,#]+/).filter(Boolean), deep: fields.deep === "1" })));
  res.status(202).json({ trends: out });
}));
app.delete("/api/trends/:id", (req, res) => { deleteTrend(req.params.id!); res.json({ ok: true }); });
app.get("/api/watch", (_req, res) => res.json({ sources: listSources(), candidates: listCandidates().slice(0, 100) }));
app.post("/api/watch", (req, res) => { const b = req.body ?? {}; if (!b.value) return fail(res, 400, "Enter an account, hashtag or link."); res.status(201).json({ source: addSource({ platform: b.platform ?? "tiktok", kind: b.kind ?? "account", value: String(b.value) }) }); });
app.delete("/api/watch/:id", (req, res) => { db.del("watch", req.params.id!); res.json({ ok: true }); });
app.post("/api/watch/:id/refresh", wrap(async (req, res) => res.json(await refreshSource(req.params.id!))));

// ---------- ideas + autopilot ----------
app.get("/api/profile", (_req, res) => res.json({ profile: getProfile() }));
app.put("/api/profile", (req, res) => { const p = { ...getProfile(), ...(req.body ?? {}) } as CreatorProfile; db.put("settings", "profile", p); res.json({ profile: p }); });
app.get("/api/ideas", (_req, res) => res.json({ ideas: listIdeas() }));
app.post("/api/ideas/refresh", wrap(async (req, res) => res.json({ ideas: await suggestIdeas(libraryAssets().filter((a) => a.status === "ready" && a.contentType !== "music"), { ai: req.body?.ai !== false }) })));
app.post("/api/autopilot", wrap(async (req, res) => {
  const b = req.body ?? {};
  const assets = (Array.isArray(b.assetIds) ? b.assetIds : []).map((id: string) => getAsset(id)).filter((a: AssetDoc | null): a is AssetDoc => !!a && a.status === "ready");
  if (!assets.length) return fail(res, 400, "Pick at least one clip that has finished processing.");
  const trend = b.trendId ? getTrend(b.trendId) : null;
  if (b.trendId && !trend?.blueprint) return fail(res, 404, "That trend has not finished analysing yet.");
  let music: AssetDoc | null = null;
  if (b.soundId) { const s = listSounds().find((x) => x.id === b.soundId); music = s ? getAsset(s.assetId) : null; }
  else if (b.musicAssetId) music = getAsset(b.musicAssetId);
  else if (b.music !== "none" && trend?.soundId && trend.blueprint?.audio.hasMusic) { const s = listSounds().find((x) => x.id === trend.soundId); music = s ? getAsset(s.assetId) : null; }
  const footage = assets.filter((a: AssetDoc) => a.contentType !== "music");
  if (!music) music = assets.find((a: AssetDoc) => a.contentType === "music") ?? null;
  const opts = { blueprint: trend?.blueprint ?? null, assets: footage, musicAsset: music, targetSeconds: b.targetSeconds ? Number(b.targetSeconds) : undefined, captionLook: b.captionLook || undefined, captions: b.captions, hookText: b.hookText === "" ? undefined : b.hookText, aspect: b.aspect, topic: b.topic, profile: getProfile() };
  const plan = b.useAi === false ? null : await aiPlan(opts);
  try {
    const { timeline, report } = remix({ ...opts, plan, title: b.name });
    const p = createProject({ name: b.name || (report.title && report.title !== "New edit" ? report.title : trend ? `${trend.title} · my version` : "New edit"), assetIds: [...footage.map((a: AssetDoc) => a.id), ...(music ? [music.id] : [])], trendId: trend?.id ?? null, timeline, report });
    res.status(201).json({ ...projectPayload(p.id), report });
  } catch (e) { fail(res, 422, (e as Error).message); }
}));

// ---------- MCP: the same tools for outside agents (Claude Code, Cursor, ChatGPT...) ----------
const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
function mcpProject(req: Request, args: Record<string, unknown> | undefined): string | null {
  const id = (args?.projectId as string | undefined) ?? (req.query.project ? String(req.query.project) : undefined) ?? listProjects()[0]?.id;
  return id && getProject(id) ? id : null;
}
async function mcpCall(req: Request, msg: { id?: unknown; method?: string; params?: Record<string, any> }): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // notifications need no answer
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: MCP_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params!.protocolVersion : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: APP_NAME.toLowerCase(), version: "0.1.0" }, instructions: `${SYSTEM_PROMPT}\n\nEvery tool takes an optional projectId. Use listProjects to find one, or createProject to start from footage in the library.` });
    case "ping": return reply({});
    case "tools/list":
      return reply({ tools: [
        { name: "listProjects", description: "List the projects with id, name, length and item count.", inputSchema: { type: "object", properties: {} } },
        { name: "createProject", description: "Create a project from footage in the library. Returns its id and the footage ids to use in tools.", inputSchema: { type: "object", properties: { name: { type: "string" }, aspectRatio: { type: "string", enum: ["9:16", "16:9", "1:1", "4:5"] }, assetNames: { type: "array", items: { type: "string" }, description: "File names from the library to include. Omit to include all ready footage." } } } },
        ...TOOLS.map((t) => { const s = toolJsonSchema(t) as { properties?: Record<string, unknown> }; return { name: t.name, description: t.description, inputSchema: { ...s, properties: { ...(s.properties ?? {}), projectId: { type: "string", description: "Project to act on. Defaults to the open project." } } }, annotations: { readOnlyHint: !t.mutates } }; }),
      ] });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const text = (o: unknown, isError = false) => reply({ content: [{ type: "text", text: JSON.stringify(o) }], isError });
      if (name === "listProjects") return text({ ok: true, projects: listProjects().map((p) => ({ id: p.id, name: p.name, seconds: p.durationMs / 1000, items: p.itemCount })) });
      if (name === "createProject") {
        const lib = libraryAssets().filter((a) => a.status === "ready");
        const names = Array.isArray(args.assetNames) ? (args.assetNames as string[]) : null;
        const p = createProject({ name: args.name as string | undefined, aspect: args.aspectRatio as string | undefined, assetIds: (names ? lib.filter((a) => names.includes(a.name)) : lib).map((a) => a.id) });
        return text({ ok: true, projectId: p.id, footage: p.assets.map((a) => ({ id: a.agentId, name: getAsset(a.assetId)?.name })) });
      }
      const projectId = mcpProject(req, args);
      if (!projectId) return text({ ok: false, error: "No project is open. Call listProjects or createProject first." }, true);
      const { projectId: _p, ...input } = args;
      const range = /^(\d+)-(\d+)$/.exec(String(req.query.range ?? ""));
      const r = await runTool({ projectId, selection: req.query.selection ? String(req.query.selection).split(",") : undefined, playheadMs: req.query.playhead ? Number(req.query.playhead) : undefined, rangeMs: range ? { from: Number(range[1]), to: Number(range[2]) } : null }, name, input);
      const { images, ...rest } = r;
      return reply({ content: [{ type: "text", text: JSON.stringify(rest) }, ...(images ?? []).map((i) => ({ type: "image", data: i.data.toString("base64"), mimeType: i.mime }))], isError: !r.ok });
    }
    default: return error(-32601, `Method not found: ${msg.method}`);
  }
}
app.post("/mcp", wrap(async (req, res) => {
  const body = req.body;
  const out = Array.isArray(body) ? (await Promise.all(body.map((m) => mcpCall(req, m)))).filter(Boolean) : await mcpCall(req, body ?? {});
  if (!out || (Array.isArray(out) && !out.length)) return res.status(202).end();
  res.json(out);
}));
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "This server answers POST requests only." } }));

// ---------- web app ----------
const dist = path.join(ROOT, "web/dist");
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|media\/|fonts\/|mcp).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  const notFound = (err as NodeJS.ErrnoException).code === "ENOENT" || err.status === 404;
  if (!notFound) console.error("[api]", err.message);
  res.status(notFound ? 404 : err instanceof T.OpError ? 422 : 500).json({ error: notFound ? "Not found" : err.message, code: err instanceof T.OpError ? err.code : "ERROR" });
});

registerFonts();
// anything left mid-processing by a restart goes back in the queue
for (const a of listAssets()) if (a.status === "processing") { for (const k of Object.keys(a.steps) as (keyof AssetDoc["steps"])[]) if (a.steps[k] === "running") a.steps[k] = "pending"; db.put("asset", a.id, a); enqueue(a.id); }
app.listen(PORT, () => console.log(`${APP_NAME} server on http://127.0.0.1:${PORT}  (data: ${DATA_DIR}, AI: ${aiStatus().backend})`));
