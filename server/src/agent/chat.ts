// The editing agent. A chat turn runs a tool loop against the project's timeline.
// Backends: the Anthropic API (official SDK, streaming) or the local Claude Code CLI driving
// the same tools through this server's MCP endpoint.
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, ChatSegment } from "../../../shared/types.ts";
import { APP_NAME } from "../../../shared/catalog.ts";
import { AGENT_EFFORT, AGENT_MODEL, CLAUDE_BIN, PORT, llmBackend } from "../config.ts";
import * as db from "../db.ts";
import { anthropic, usageLog } from "../llm.ts";
import { getProject, restoreSnapshot, snapshot } from "../projects.ts";
import { getTrend } from "../trends.ts";
import { templateById } from "../autopilot.ts";
import { TOOLS, runTool, toolByName, toolJsonSchema, type ToolContext } from "./tools.ts";

export const SYSTEM_PROMPT = `You are the editor inside ${APP_NAME}, a video editor for short-form creators. You edit the user's real footage on a real timeline by calling tools. You never generate footage and never describe an edit you did not make.

How the editor works
- The timeline has tracks: video (clips and images), overlay (text, shapes), caption, audio. Items have ids like clip_3, text_2, cap_14. All times in tools are seconds.
- Footage ids look like video_1, audio_1, image_1. Every clip was transcribed word by word and its scenes were described when it was uploaded: listFootage shows what exists, viewFootage gives transcript lines and scenes with times, searchFootage finds a moment by what was said or shown.
- The tools change the same timeline the user sees, live. The user can also edit by hand between your turns, so read context before you change anything.
- A failed tool call changes nothing and tells you why; fix the call and try again.

How to work
- Read first: context for the timeline, listFootage/viewFootage for the material. Then make the edit. Do the work rather than describing a plan, unless the user asks for options first.
- Short-form craft is the default when the user does not say otherwise: the strongest line first (the hook), no dead air, cuts on sentence ends, captions on for speech in a look people actually post with, music low under speech, stop on the last useful word.
- Keep the user's order of points unless they ask you to reorder or the hook needs to move to the front.
- To cut by what is said, use addMedia with transcriptRange (quote the words) or trimStart/trimEnd from the transcript times. To remove pauses, fillers and restarts use cutDeadSpace instead of trimming by hand.
- For captions use addCaptions with a look; restyle with editCaptions. Name emphasis words that carry the point: numbers, the claim, the payoff.
- For music-driven edits use syncToBeats, which puts every cut on the beat. For a format that is already working, use listTrends and applyTrend.
- When the user selected items or highlighted a range, that is what "this", "here" and "the selected clip" mean.
- After a larger change, check your work with captureFrame at one or two moments that matter (the first second, a captioned line).
- If something cannot be made from the footage in the project, say so plainly and say what is missing.

How to answer
- Brief and concrete: what changed, the new length, anything you assumed, anything that did not match the request. No headers, no lists of tool names.
- When you removed material, offer the cut list rather than pasting all of it.`;

interface ChatDoc { projectId: string; messages: ChatMessage[]; api: Anthropic.Beta.BetaMessageParam[]; cliSession: string | null }
export function getChat(projectId: string): ChatDoc {
  return db.get<ChatDoc>("chat", projectId) ?? { projectId, messages: [], api: [], cliSession: null };
}
function saveChat(c: ChatDoc) { db.put("chat", c.projectId, c); }
export function clearChat(projectId: string) { db.del("chat", projectId); }

export type ChatEvent =
  | { type: "start"; turnId: string; backend: string }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error"; summary?: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; message: string };

function editorState(ctx: ToolContext): string {
  const p = getProject(ctx.projectId);
  const parts: string[] = [];
  if (ctx.playheadMs !== undefined) parts.push(`playhead at ${(ctx.playheadMs / 1000).toFixed(2)}s`);
  if (ctx.selection?.length) parts.push(`selected: ${ctx.selection.join(", ")}`);
  if (ctx.rangeMs) parts.push(`highlighted range ${(ctx.rangeMs.from / 1000).toFixed(2)}-${(ctx.rangeMs.to / 1000).toFixed(2)}s`);
  const trend = p?.trendId ? getTrend(p.trendId) : null;
  if (trend?.blueprint) parts.push(`project built from trend "${trend.title}" (${trend.blueprint.format}, hook: ${trend.blueprint.hook.type})`);
  const tpl = templateById(p?.templateId);
  if (tpl) parts.push(`template "${tpl.name}" (follow it unless the user asks otherwise). Structure: ${tpl.guidance.structure} Pacing: ${tpl.guidance.pacing} Captions: ${tpl.guidance.captions} B-roll: ${tpl.guidance.broll} Ending: ${tpl.guidance.ending}`);
  return parts.length ? `[Editor state: ${parts.join("; ")}]\n` : "";
}
function summarize(name: string, result: Record<string, unknown>): string {
  if (result.ok === false) return String(result.error ?? "failed").slice(0, 160);
  const r = result as Record<string, any>;
  switch (name) {
    case "addMedia": return `${r.added?.length ?? 0} clip(s) added`;
    case "cutDeadSpace": return `${r.cuts} cuts, ${r.removedSeconds}s removed`;
    case "addCaptions": return `${r.created} captions`;
    case "deleteItems": return `${r.deleted?.length ?? 0} removed`;
    case "addMusic": return r.ducked ? `music added, ducked under speech` : "music added";
    case "syncToBeats": return `${r.slots} cuts on the beat at ${r.bpm} BPM`;
    case "applyTrend": return `${r.built?.durationSeconds}s ${r.built?.mode} edit`;
    case "exportProject": return `export started`;
    case "captureFrame": return `${r.captured?.length ?? 0} frame(s)`;
    default: return "done";
  }
}
const labelOf = (name: string) => toolByName(name)?.label ?? name;

/** Run one chat turn. Events stream to `send`; the finished assistant message is stored. */
export async function runChatTurn(ctx: ToolContext, userText: string, send: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const backend = llmBackend();
  const chat = getChat(ctx.projectId);
  const turnId = db.newId("turn");
  const user: ChatMessage = { id: db.newId("m"), role: "user", createdAt: new Date().toISOString(), segments: [{ type: "text", text: userText }] };
  chat.messages.push(user);
  saveChat(chat);
  snapshot(ctx.projectId, `Before: ${userText.slice(0, 60)}`, turnId);
  send({ type: "start", turnId, backend });
  const segments: ChatSegment[] = [];
  const pushText = (delta: string) => { const last = segments[segments.length - 1]; if (last?.type === "text") last.text += delta; else segments.push({ type: "text", text: delta }); send({ type: "text", delta }); };
  const toolSeg = (id: string, name: string, status: "running" | "done" | "error", summary?: string) => {
    let seg = segments.find((x): x is Extract<ChatSegment, { type: "tool" }> => x.type === "tool" && x.id === id);
    if (!seg) { seg = { type: "tool", id, name, label: labelOf(name), status }; segments.push(seg); }
    seg.status = status; if (summary) seg.summary = summary;
    send({ type: "tool", id, name, label: seg.label, status, summary });
  };
  const finish = (notice?: string) => {
    if (notice) segments.push({ type: "notice", text: notice });
    const changed = segments.some((x) => x.type === "tool" && toolByName(x.name)?.mutates && x.status === "done");
    const msg: ChatMessage = { id: db.newId("m"), role: "assistant", createdAt: new Date().toISOString(), segments, turnId, revertable: changed };
    const fresh = getChat(ctx.projectId);
    fresh.messages.push(msg); fresh.api = chat.api; fresh.cliSession = chat.cliSession;
    saveChat(fresh);
    send({ type: "done", message: msg });
  };
  try {
    if (backend === "none") {
      pushText("No AI model is connected, so I can't act on that message. Everything else works without one: Autopilot builds edits from trends with rules, and the timeline, captions, beat sync and export are all available by hand. To turn the assistant on, set ANTHROPIC_API_KEY on the server, or install and sign in to Claude Code on the same machine.");
      finish();
    } else if (backend === "anthropic-api") await anthropicTurn(ctx, chat, userText, pushText, toolSeg, finish, signal);
    else await claudeCodeTurn(ctx, chat, userText, pushText, toolSeg, finish, signal);
  } catch (e) {
    const msg = e instanceof Anthropic.AuthenticationError ? "The API key was rejected. Check ANTHROPIC_API_KEY on the server."
      : e instanceof Anthropic.RateLimitError ? "The model is rate limited right now. Try again in a moment."
      : e instanceof Anthropic.APIError ? `The model returned an error (${e.status}). ${e.message}`
      : (e as Error).message;
    if (segments.length) finish(msg); else send({ type: "error", message: msg });
  }
}

type PushText = (d: string) => void;
type ToolSeg = (id: string, name: string, status: "running" | "done" | "error", summary?: string) => void;

async function anthropicTurn(ctx: ToolContext, chat: ChatDoc, userText: string, pushText: PushText, toolSeg: ToolSeg, finish: (n?: string) => void, signal?: AbortSignal) {
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: toolJsonSchema(t) as Anthropic.Beta.BetaTool["input_schema"], eager_input_streaming: true }));
  const messages = chat.api;
  messages.push({ role: "user", content: editorState(ctx) + userText });
  let jsonRetries = 0;
  for (let round = 0; round < 40; round++) {
    if (signal?.aborted) { finish("Stopped."); return; }
    const stream = anthropic().beta.messages.stream({
      model: AGENT_MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: AGENT_EFFORT },
      // a declined request is retried on the fallback model inside the same call
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    }, { signal });
    stream.on("text", (delta) => pushText(delta));
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // with eager input streaming a tool input that cannot be parsed rejects the turn: re-issue it, API errors are rethrown
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      continue;
    }
    usageLog.push({ at: new Date().toISOString(), task: "chat", backend: "anthropic-api", inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, ms: 0 });
    if (message.stop_reason === "refusal") { finish("The model declined this request."); return; }
    if (message.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: message.content }); continue; }
    const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason === "end_turn" || !uses.length) { messages.push({ role: "assistant", content: message.content }); finish(message.stop_reason === "max_tokens" ? "The answer was cut off at the length limit." : undefined); return; }
    // a tool input cut off at the length limit can still parse; never run it
    if (message.stop_reason === "max_tokens") { finish("The model's tool call was cut off, so nothing was changed. Try a narrower request."); return; }
    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      toolSeg(use.id, use.name, "running");
      // runTool validates the input against the tool's schema before anything runs
      const r = await runTool(ctx, use.name, use.input);
      const { images, ...rest } = r;
      const content: Anthropic.Beta.BetaToolResultBlockParam["content"] = [{ type: "text", text: JSON.stringify(rest) }];
      for (const img of images ?? []) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.data.toString("base64") } });
      results.push({ type: "tool_result", tool_use_id: use.id, content, ...(r.ok ? {} : { is_error: true }) });
      toolSeg(use.id, use.name, r.ok ? "done" : "error", summarize(use.name, rest));
    }
    messages.push({ role: "user", content: results });
    chat.api = messages;
  }
  finish("Stopped after many steps. Ask me to continue if the edit is not finished.");
}

async function claudeCodeTurn(ctx: ToolContext, chat: ChatDoc, userText: string, pushText: PushText, toolSeg: ToolSeg, finish: (n?: string) => void, signal?: AbortSignal) {
  if (!CLAUDE_BIN) throw new Error("Claude Code is not installed on this machine.");
  const q = new URLSearchParams({ project: ctx.projectId });
  if (ctx.selection?.length) q.set("selection", ctx.selection.join(","));
  if (ctx.playheadMs !== undefined) q.set("playhead", String(Math.round(ctx.playheadMs)));
  if (ctx.rangeMs) q.set("range", `${Math.round(ctx.rangeMs.from)}-${Math.round(ctx.rangeMs.to)}`);
  const mcp = JSON.stringify({ mcpServers: { editor: { type: "http", url: `http://127.0.0.1:${PORT}/mcp?${q.toString()}` } } });
  const args = ["-p", editorState(ctx) + userText, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--system-prompt", SYSTEM_PROMPT, "--mcp-config", mcp, "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__editor", "--effort", AGENT_EFFORT, "--max-turns", "60"];
  // name the model: the CLI's own default may be a different model with its own usage limit
  args.push("--model", AGENT_MODEL);
  if (chat.cliSession) args.push("--resume", chat.cliSession);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rs-chat-"));
  const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  signal?.addEventListener("abort", () => child.kill("SIGTERM"));
  let buf = "", stderr = "", finalText = "", sawDelta = false, resultError: string | null = null;
  const names = new Map<string, string>();
  const strip = (n: string) => n.replace(/^mcp__editor__/, "");
  const onLine = (line: string) => {
    if (!line.trim()) return;
    let ev: Record<string, any>;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) chat.cliSession = ev.session_id;
    else if (ev.type === "stream_event") {
      const e = ev.event ?? {};
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) { sawDelta = true; pushText(e.delta.text); }
      else if (e.type === "content_block_start" && e.content_block?.type === "tool_use") { const n = strip(String(e.content_block.name)); names.set(e.content_block.id, n); toolSeg(e.content_block.id, n, "running"); }
    } else if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "tool_use" && !names.has(b.id)) { const n = strip(String(b.name)); names.set(b.id, n); toolSeg(b.id, n, "running"); }
        else if (b.type === "text" && !sawDelta && b.text) pushText(b.text);
      }
      sawDelta = false;
    } else if (ev.type === "user") {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== "tool_result") continue;
        const name = names.get(b.tool_use_id) ?? "tool";
        const text = Array.isArray(b.content) ? b.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : String(b.content ?? "");
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(text); } catch { parsed = { ok: !b.is_error, error: text.slice(0, 200) }; }
        toolSeg(b.tool_use_id, name, b.is_error || parsed.ok === false ? "error" : "done", summarize(name, parsed));
      }
    } else if (ev.type === "result") {
      if (ev.session_id) chat.cliSession = ev.session_id;
      if (typeof ev.result === "string") finalText = ev.result;
      if (ev.is_error || (ev.subtype && ev.subtype !== "success")) resultError = ev.subtype === "error_max_turns" ? "Stopped after many steps. Ask me to continue if the edit is not finished." : String(ev.result ?? ev.subtype ?? "The assistant stopped with an error.");
      usageLog.push({ at: new Date().toISOString(), task: "chat", backend: "claude-code", costUsd: ev.total_cost_usd, inputTokens: ev.usage?.input_tokens, outputTokens: ev.usage?.output_tokens, ms: ev.duration_ms ?? 0 });
    }
  };
  child.stdout.on("data", (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
  if (buf.trim()) onLine(buf);
  fs.rmSync(cwd, { recursive: true, force: true });
  if (signal?.aborted) { finish("Stopped."); return; }
  if (code !== 0 && !finalText && !resultError) throw new Error(`Claude Code exited with an error: ${stderr.trim().split("\n").pop() ?? `code ${code}`}`);
  finish(resultError ?? undefined);
}

export function revertTurn(projectId: string, turnId: string): boolean {
  const tl = restoreSnapshot(projectId, { turnId });
  if (!tl) return false;
  const chat = getChat(projectId);
  for (const m of chat.messages) if (m.turnId === turnId) { m.reverted = true; m.revertable = false; }
  chat.messages.push({ id: db.newId("m"), role: "assistant", createdAt: new Date().toISOString(), segments: [{ type: "notice", text: "Restored the timeline to how it was before that change." }] });
  // the model must not assume its reverted edits still exist
  if (chat.api.length) chat.api.push({ role: "user", content: "[The user reverted your last change. The timeline is back to its earlier state; read context again before editing.]" }, { role: "assistant", content: "Understood. I will read the timeline again before the next edit." });
  saveChat(chat);
  return true;
}
