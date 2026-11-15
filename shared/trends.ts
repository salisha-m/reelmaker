// Types for trend intelligence: viral posts broken down into blueprints anyone can refill with their own footage.
import type { CaptionMode, ID } from "./types.ts";

export type TrendFormat = "talking-head" | "voiceover-broll" | "montage" | "text-on-video" | "mixed";
export interface TrendSlot { index: number; startMs: number; endMs: number; kind: "talking" | "broll"; onBeat: boolean; note?: string }
export interface TrendOverlay { text: string; startMs: number; endMs: number; position: "top" | "center" | "bottom"; role: "hook" | "label" | "cta" | "caption" }
export interface TrendBlueprint {
  format: TrendFormat;
  durationMs: number;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  hook: { spoken: string | null; onScreen: string | null; seconds: number; type: string; formula: string };
  slots: TrendSlot[];
  pacing: { cuts: number; cutsPerMinute: number; avgShotMs: number; medianShotMs: number; cutsInFirst3s: number; label: "slow" | "medium" | "fast" | "very fast" };
  audio: { hasSpeech: boolean; speechCoverage: number; wordsPerMinute: number | null; hasMusic: boolean; bpm: number | null; beatsMs: number[]; cutsOnBeat: number | null; musicUnderSpeech: boolean };
  captions: { present: boolean | null; look: string; mode: CaptionMode; position: number; uppercase: boolean | null; description: string };
  overlays: TrendOverlay[];
  color: { brightness: number; saturation: number; filterId: string | null };
  structure: string[];
  whyItWorks: string[];
  recreate: string;
  source: "vision" | "heuristic";
}
export interface TrendStats { views: number | null; likes: number | null; comments: number | null; shares: number | null; saves?: number | null }
export interface TrendPost {
  id: ID;
  createdAt: string;
  status: "downloading" | "processing" | "analyzing" | "ready" | "error";
  error: string | null;
  title: string;
  source: { platform: "tiktok" | "instagram" | "youtube" | "upload" | "link"; url: string | null; author: string | null; handle: string | null; caption: string | null; hashtags: string[]; postedAt: string | null };
  stats: TrendStats;
  sound: { title: string; author: string | null; original: boolean } | null;
  soundId: ID | null;
  assetId: ID | null;
  durationMs: number;
  width: number | null;
  height: number | null;
  niche: string[];
  /** 0..100: reach and engagement relative to the rest of the library, with a recency boost. */
  viralScore: number;
  blueprint: TrendBlueprint | null;
  urls: { video: string | null; thumbnail: string | null };
}
export interface TrendSound {
  id: ID;
  title: string;
  author: string | null;
  assetId: ID;
  durationMs: number;
  bpm: number | null;
  /** Posts in the library that use this sound. */
  postIds: ID[];
  totalViews: number;
  createdAt: string;
  urls: { audio: string | null };
}
export interface CreatorProfile { niche: string; audience: string; platforms: string[]; goal: string; tone: string; handle: string }
export interface Idea {
  id: ID;
  createdAt: string;
  title: string;
  hook: string;
  why: string;
  trendId: ID | null;
  format: TrendFormat;
  shotList: string[];
  useAssetIds: ID[];
  missing: string[];
  caption: string;
  hashtags: string[];
  score: number;
  source: "ai" | "rules";
}
export interface WatchSource { id: ID; platform: "tiktok" | "instagram" | "youtube"; kind: "account" | "hashtag" | "sound" | "url"; value: string; lastChecked: string | null; lastError: string | null }
export interface TrendCandidate { id: ID; url: string; platform: string; title: string; author: string | null; views: number | null; likes: number | null; postedAt: string | null; durationSec: number | null; velocity: number | null; sourceId: ID; ingested: boolean }
export interface RemixReport { mode: "talking" | "montage"; durationSeconds: number; hook: string | null; hookOverlay: string | null; usedAssets: string[]; clips: number; brollInserts: number; captionLook: string; captions: number; music: string | null; cutsRemoved: number; secondsRemoved: number; notes: string[]; title: string; postCaption: string; hashtags: string[]; planner: "ai" | "rules" }
