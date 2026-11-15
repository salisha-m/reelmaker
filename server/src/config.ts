import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data"));
export const PORT = Number(process.env.PORT ?? 8787);
export const FONTS_DIR = path.join(ROOT, "assets/fonts");
export const PY = process.env.PYTHON ?? (fs.existsSync(path.join(ROOT, ".venv/bin/python")) ? path.join(ROOT, ".venv/bin/python") : "python3");
export const PY_DIR = path.join(ROOT, "server/py");
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? (fs.existsSync(path.join(DATA_DIR, "models/whisper/small/model.bin")) ? path.join(DATA_DIR, "models/whisper/small") : "small");
export const YTDLP = process.env.YTDLP ?? (fs.existsSync(path.join(ROOT, ".venv/bin/yt-dlp")) ? path.join(ROOT, ".venv/bin/yt-dlp") : "yt-dlp");

export const dirs = {
  uploads: path.join(DATA_DIR, "uploads"),
  proxies: path.join(DATA_DIR, "proxies"),
  thumbs: path.join(DATA_DIR, "thumbs"),
  audio: path.join(DATA_DIR, "audio"),
  frames: path.join(DATA_DIR, "frames"),
  renders: path.join(DATA_DIR, "renders"),
  tmp: path.join(DATA_DIR, "tmp"),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

function which(bin: string): string | null {
  try { return execFileSync("which", [bin], { encoding: "utf8" }).trim() || null; } catch { return null; }
}
/** Which model backend answers AI requests. */
export type LlmBackend = "anthropic-api" | "claude-code" | "none";
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? which("claude");
export function llmBackend(): LlmBackend {
  const forced = process.env.AI_BACKEND as LlmBackend | undefined;
  if (forced) return forced;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic-api";
  if (CLAUDE_BIN) return "claude-code";
  return "none";
}
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";
export const VISION_MODEL = process.env.VISION_MODEL ?? AGENT_MODEL;
export const AGENT_EFFORT = (process.env.AGENT_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";
/** Describing frames with a vision model costs model usage per clip; off unless asked for. */
export const VISION_INDEXING = process.env.VISION_INDEXING === "1";
