// Model access. Two backends share one interface:
//  - "anthropic-api": the official SDK with ANTHROPIC_API_KEY (production default)
//  - "claude-code":   the local Claude Code CLI in headless mode (works wherever `claude` is signed in)
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AGENT_EFFORT, AGENT_MODEL, CLAUDE_BIN, VISION_MODEL, llmBackend } from "./config.ts";
import { run } from "./media.ts";

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}
let lastError: string | null = null;
/** Why the most recent model request produced no answer, in words a user can act on. */
export const lastLlmError = () => lastError;
export const usageLog: { at: string; task: string; backend: string; inputTokens?: number; outputTokens?: number; costUsd?: number; ms: number }[] = [];

function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[\[{]/);
    if (start < 0) continue;
    for (let end = c.length; end > start; end--) {
      const ch = c[end - 1];
      if (ch !== "}" && ch !== "]") continue;
      try { return JSON.parse(c.slice(start, end)); } catch { /* keep shrinking */ }
    }
  }
  return null;
}

export interface JsonTask { task: string; system: string; prompt: string; imagePaths?: string[]; effort?: "low" | "medium" | "high"; maxTokens?: number; model?: string; timeoutMs?: number }
/** Ask the model for one JSON value. Returns null when no backend is configured or the answer was not JSON. */
export async function jsonTask<T>(t: JsonTask): Promise<T | null> {
  const backend = llmBackend();
  const started = Date.now();
  lastError = null;
  if (backend === "none") { lastError = "No AI model is connected on this server."; return null; }
  try {
    if (backend === "anthropic-api") {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const p of t.imagePaths ?? []) {
        const ext = path.extname(p).toLowerCase();
        content.push({ type: "text", text: `Image file: ${path.basename(p)}` });
        content.push({ type: "image", source: { type: "base64", media_type: ext === ".png" ? "image/png" : "image/jpeg", data: fs.readFileSync(p).toString("base64") } });
      }
      content.push({ type: "text", text: t.prompt });
      const stream = anthropic().beta.messages.stream({
        model: t.model ?? (t.imagePaths?.length ? VISION_MODEL : AGENT_MODEL),
        max_tokens: t.maxTokens ?? 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: t.effort ?? "low" },
        // a declined request is retried on the fallback model inside the same call
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: t.system,
        messages: [{ role: "user", content }],
      });
      const msg = await stream.finalMessage();
      usageLog.push({ at: new Date().toISOString(), task: t.task, backend, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, ms: Date.now() - started });
      if (msg.stop_reason === "refusal") { lastError = "The model declined this request."; return null; }
      const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
      const parsed = extractJson(text) as T | null;
      if (!parsed) lastError = "The model's answer was not in the expected format.";
      return parsed;
    }
    // claude-code backend
    if (!CLAUDE_BIN) return null;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rs-llm-"));
    const images = t.imagePaths ?? [];
    const dirsToAdd = [...new Set(images.map((p) => path.dirname(p)))];
    const prompt = images.length
      ? `${t.prompt}\n\nThe images are on disk. Read every one of them with the Read tool before answering:\n${images.map((p) => `- ${p}`).join("\n")}\n\nAnswer with the JSON only.`
      : `${t.prompt}\n\nAnswer with the JSON only.`;
    const args = ["-p", prompt, "--output-format", "json", "--system-prompt", t.system, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--max-turns", images.length ? String(Math.min(40, images.length + 4)) : "2", "--tools", images.length ? "Read" : ""];
    if (images.length) args.push("--allowedTools", "Read", "--add-dir", ...dirsToAdd);
    // name the model: the CLI's own default may be a different model with its own usage limit
    args.push("--model", t.model ?? (images.length ? VISION_MODEL : AGENT_MODEL));
    args.push("--effort", t.effort ?? "low");
    const r = await run(CLAUDE_BIN, args, { cwd, timeoutMs: t.timeoutMs ?? 240_000 });
    fs.rmSync(cwd, { recursive: true, force: true });
    const outer = extractJson(r.stdout) as { result?: string; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number }; is_error?: boolean } | null;
    usageLog.push({ at: new Date().toISOString(), task: t.task, backend, costUsd: outer?.total_cost_usd, inputTokens: outer?.usage?.input_tokens, outputTokens: outer?.usage?.output_tokens, ms: Date.now() - started });
    if (!outer || outer.is_error || typeof outer.result !== "string") {
      lastError = outer?.is_error && typeof outer.result === "string" ? outer.result : `Claude Code returned no answer (exit ${r.code}).`;
      console.warn(`[llm] ${t.task}: ${lastError} ${r.stderr.slice(0, 200)}`);
      return null;
    }
    const parsed = extractJson(outer.result) as T | null;
    if (!parsed) lastError = "The model's answer was not in the expected format.";
    return parsed;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) lastError = "The API key was rejected. Check ANTHROPIC_API_KEY on the server.";
    else if (err instanceof Anthropic.RateLimitError) lastError = "The model is rate limited right now. Try again in a moment.";
    else if (err instanceof Anthropic.APIError) lastError = `The model returned an error (${err.status}).`;
    else lastError = (err as Error).message;
    console.warn(`[llm] ${t.task}: ${lastError}`);
    return null;
  }
}
export const aiStatus = () => ({ backend: llmBackend(), model: AGENT_MODEL, effort: AGENT_EFFORT, calls: usageLog.length, costUsd: Math.round(usageLog.reduce((s, u) => s + (u.costUsd ?? 0), 0) * 1000) / 1000 });
