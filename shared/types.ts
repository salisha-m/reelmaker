// Core data model shared by the server, the renderer and the web editor.
// All timeline times are integer milliseconds. Agent-facing tools use seconds.

export type ID = string;
export type AssetType = "video" | "audio" | "image";
export type TrackKind = "video" | "overlay" | "audio" | "caption";
export type ItemType = "video" | "image" | "audio" | "text" | "caption" | "shape" | "motionGraphic";

// ---------- footage index (what upload processing produces) ----------
export interface SceneSegment {
  start_time: number; // seconds
  end_time: number;
  description: string;
  audio?: string;
}
export interface SceneAnalysis {
  tags: string[];
  summary: string;
  segments: SceneSegment[];
  aspect_ratio?: string;
  duration_seconds?: number;
  /** "vision" when a vision model described the frames, "heuristic" when only signal statistics were available. */
  source?: "vision" | "heuristic";
}
export interface TranscriptWord { word: string; start: number; end: number; probability?: number }
export interface TranscriptSegment { id: number; start: number; end: number; text: string; words: TranscriptWord[]; speaker?: number }
export interface Transcription { language: string; segments: TranscriptSegment[]; total_duration: number }
export interface RhythmData {
  averageBpm: number;
  tempoType: "steady" | "variable" | "none";
  /** [timeSeconds, strength 0..1] */
  pulseBeats: [number, number][];
  downbeats: [number, number][];
  onsets: [number, number][];
  /** [startSeconds, endSeconds] */
  silences: [number, number][];
  detector: { name: string; version: string };
}

export type StepState = "pending" | "running" | "done" | "skipped" | "error";
export interface AssetSteps { probe: StepState; proxy: StepState; thumbnail: StepState; waveform: StepState; transcript: StepState; scenes: StepState; rhythm: StepState }

export interface Asset {
  id: ID;
  name: string;
  type: AssetType;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number;
  fps: number | null;
  hasAudio: boolean;
  rotation: number;
  createdAt: string;
  fileCreatedAt: string | null;
  status: "uploading" | "processing" | "ready" | "error";
  steps: AssetSteps;
  progress: number; // 0..1 overall
  error: string | null;
  contentType: "footage" | "music" | "generated";
  analysis: SceneAnalysis | null;
  transcription: Transcription | null;
  rhythm: RhythmData | null;
  /** Peaks for waveform drawing, normalised 0..1, ~50 per second. */
  waveform?: number[] | null;
  urls: { original: string; proxy: string | null; thumbnail: string | null; sprite?: string | null };
}

/** An asset as seen inside one project: carries the short id the agent uses (video_1, audio_2, image_1). */
export interface ProjectAsset extends Asset { agentId: string }

// ---------- timeline ----------
export interface Keyframe { t: number; value: number; easing?: Easing }
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

export interface Transform {
  /** Offset of the item centre from the canvas centre, in canvas pixels. */
  x: number;
  y: number;
  /** Multiplier on top of the fit size. 1 = fit exactly. */
  scale: number;
  rotation: number; // degrees
  opacity: number; // 0..1
  fit: "cover" | "contain";
  /** Normalised crop of the source, each 0..1 from that edge. */
  crop?: { left: number; top: number; right: number; bottom: number };
  flipH?: boolean;
}

export interface Effect {
  id: string; // brightness | contrast | saturation | temperature | tint | blur | vignette | grayscale | sepia | hue | fade
  value: number;
}

export interface BaseItem {
  id: ID;
  trackId: ID;
  type: ItemType;
  /** Position on the timeline in ms. */
  display: { from: number; to: number };
  name?: string;
  /** Items produced by splitting share the origin of the item they came from. */
  originId?: ID;
  keyframes?: Partial<Record<KeyframeProp, Keyframe[]>>;
}
export type KeyframeProp = "x" | "y" | "scale" | "rotation" | "opacity" | "volume";

export interface MediaItem extends BaseItem {
  type: "video" | "image" | "audio";
  assetId: ID;
  /** Range of the source used, in source ms. For images from=0,to=duration. */
  trim: { from: number; to: number };
  playbackRate: number;
  volume: number; // linear 0..2
  muted: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  transform: Transform;
  effects: Effect[];
  filter?: { id: string; strength: number } | null;
}

export interface TextStyle {
  fontFamily: string;
  fontWeight: number;
  fontSize: number; // px at canvas resolution
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  textTransform: "none" | "uppercase" | "lowercase";
  strokeColor: string | null;
  strokeWidth: number;
  shadow: { color: string; blur: number; x: number; y: number } | null;
  background: { color: string; paddingX: number; paddingY: number; radius: number } | null;
  /** Wrap width as a fraction of the canvas width. */
  maxWidth: number;
}

export type TextAnimation = "none" | "fade" | "slide-up" | "slide-left" | "pop" | "typewriter" | "word-reveal";

export interface TextItem extends BaseItem {
  type: "text";
  text: string;
  style: TextStyle;
  transform: Transform;
  animation: { in: TextAnimation; out: TextAnimation; durationMs: number };
  role?: "title" | "lower-third" | "label" | "body";
}

export interface CaptionWord { text: string; s: number; e: number; emphasis?: boolean }
export interface CaptionItem extends BaseItem {
  type: "caption";
  /** The clip whose speech this caption carries. Captions follow, trim and delete with it. */
  linkedItemId: ID;
  /** Words with times in *source* ms of the linked clip's asset. */
  words: CaptionWord[];
  /** Per-item overrides on top of the track's caption style. */
  override?: Partial<CaptionStyle> & { scale?: number };
  /** Caption created by hand (not from a transcript): fixed text and timeline time. */
  manual?: boolean;
}

export type CaptionMode = "phrase" | "word" | "highlight";
export interface CaptionStyle extends TextStyle {
  mode: CaptionMode;
  /** How the spoken word is marked in highlight mode: recoloured, or sitting on a rounded box. */
  highlightStyle?: "color" | "box";
  highlightBox?: { color: string; radius: number; padX: number; padY: number; textColor?: string };
  /** A tight rounded background behind each line (the classic TikTok text box). */
  lineBackground?: { color: string; padX: number; padY: number; radius: number } | null;
  /** Words not spoken yet: 1 shows them normally, lower dims them, 0 hides them until spoken (build-up). */
  upcomingOpacity?: number;
  /** Degrees of tilt for the whole caption. */
  tilt?: number;
  /** Extra glow around the glyphs. */
  glow?: { color: string; blur: number } | null;
  /** The spoken word grows by this factor (1 = none). */
  activeScale?: number;
  /** Vertical centre as a fraction of canvas height (0 top .. 1 bottom). */
  position: number;
  highlightColor: string;
  emphasisColor: string;
  emphasisScale: number;
  animation: "none" | "pop" | "fade" | "slide-up";
  maxWordsPerPhrase: number;
  maxCharsPerLine: number;
  maxLines: number;
}

export interface ShapeItem extends BaseItem {
  type: "shape";
  shape: "rect" | "ellipse" | "line";
  width: number;
  height: number;
  fill: string | null;
  strokeColor: string | null;
  strokeWidth: number;
  roundness: number;
  transform: Transform;
}

// Motion graphics are declarative scenes: layers with animated properties.
export interface MGAnim { prop: "x" | "y" | "scale" | "opacity" | "rotation" | "width" | "height" | "reveal"; from: number; to: number; startMs: number; durationMs: number; easing?: Easing | "back-out" | "spring" }
export interface MGLayer {
  id: string;
  kind: "text" | "rect" | "ellipse" | "line" | "image";
  /** Normalised 0..1 position of the layer anchor inside the canvas. */
  x: number;
  y: number;
  anchor?: "center" | "left" | "right" | "top-left" | "bottom-left" | "top-right" | "bottom-right";
  width?: number; // px
  height?: number;
  text?: string;
  style?: Partial<TextStyle>;
  fill?: string | null;
  strokeColor?: string | null;
  strokeWidth?: number;
  roundness?: number;
  assetId?: ID;
  opacity?: number;
  scale?: number;
  rotation?: number;
  /** Layer is only visible inside this window (ms relative to the item start). */
  showFromMs?: number;
  hideAtMs?: number;
  anims?: MGAnim[];
  /** Applied automatically over the last ms of the layer's life. */
  exit?: { kind: "fade" | "slide-left" | "slide-down" | "scale"; durationMs: number };
}
export interface MotionGraphicItem extends BaseItem {
  type: "motionGraphic";
  title: string;
  description: string;
  layers: MGLayer[];
  transform: Transform;
}

export type Item = MediaItem | TextItem | CaptionItem | ShapeItem | MotionGraphicItem;

export interface Track {
  id: ID;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  /** Linear gain applied to every item on an audio/video track. */
  gain: number;
  captionStyle?: CaptionStyle;
}

export type TransitionKind = "crossfade" | "fade-black" | "fade-white" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "wipe-left" | "wipe-right" | "zoom-in" | "zoom-out" | "blur";
export interface Transition { id: ID; kind: TransitionKind; fromItemId: ID; toItemId: ID; durationMs: number }
export interface Marker { id: ID; timeMs: number; label: string; color?: string }

export interface Timeline {
  size: { width: number; height: number };
  fps: number;
  background: string;
  /** Index 0 is the top-most layer. */
  tracks: Track[];
  items: Record<ID, Item>;
  transitions: Transition[];
  markers: Marker[];
  /** Bumped on every committed change. */
  version: number;
}

// ---------- templates, styles, references ----------
export interface VideoStyle {
  id: string;
  name: string;
  description: string;
  fonts: { caption: { family: string; weight: number }; title: { family: string; weight: number }; accent: { family: string; weight: number } };
  palette: { name: string; hex: string }[];
  grade: { filterId: string | null; strength: number };
  captionDefaults: Partial<CaptionStyle>;
  guidance: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  bestFor: string;
  length: string;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  captions: string;
  music: string;
  /** Structural guidance handed to the agent. */
  guidance: { structure: string; pacing: string; captions: string; broll: string; ending: string; extra?: string };
  defaults: {
    captionsOn: boolean;
    captionMode: CaptionMode;
    musicOn: boolean;
    musicVolume: number;
    removePausesOverMs: number | null;
    targetSeconds: [number, number];
    punchIn: boolean;
  };
  prompts: string[];
  builtin: boolean;
  styleId?: string;
}

export interface ReferenceRead {
  durationSeconds: number;
  aspectRatio: string;
  cuts: { count: number; perMinute: number; averageShotSeconds: number; medianShotSeconds: number; shotLengths: number[]; rhythm: string };
  captions: { present: boolean; mode: CaptionMode | "unknown"; description: string; position: number | null; case: string; weight: string; color: string | null; strokeColor: string | null; highlightColor: string | null; wordsPerGroup: number | null };
  music: { present: boolean; bpm: number | null; cutsOnBeat: number | null; behavior: string };
  speech: { present: boolean; wordsPerMinute: number | null; hook: string | null };
  color: { description: string; brightness: number; contrast: number; saturation: number; warmth: number; suggestedFilter: string | null };
  structure: string;
  textOverlays: string;
  transitions: string;
  summary: string;
  source: "vision" | "heuristic";
}
export interface ReferenceVideo {
  id: ID;
  title: string;
  platform: "upload" | "instagram" | "tiktok" | "youtube" | "link";
  sourceUrl: string | null;
  durationMs: number;
  width: number | null;
  height: number | null;
  status: "pending" | "processing" | "ready" | "error";
  error: string | null;
  createdAt: string;
  read: ReferenceRead | null;
  urls: { video: string | null; thumbnail: string | null };
}

export interface Project {
  id: ID;
  name: string;
  createdAt: string;
  updatedAt: string;
  templateId: string | null;
  styleId: string;
  referenceId: ID | null;
  thumbnail: string | null;
  durationMs: number;
  itemCount: number;
}

// ---------- chat ----------
export type ChatSegment =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "error"; summary?: string; input?: unknown }
  | { type: "todos"; items: { text: string; done: boolean }[] }
  | { type: "notice"; text: string };
export interface ChatMessage { id: ID; role: "user" | "assistant"; createdAt: string; segments: ChatSegment[]; turnId?: ID; revertable?: boolean; reverted?: boolean }

export interface ExportSettings { preset: string; resolution: "480p" | "720p" | "1080p" | "1440p" | "4k" | "original"; bitrateMbps: number; format: "mp4" | "webm"; fps?: number; filename?: string; startMs?: number; endMs?: number }
export interface RenderJob { id: ID; projectId: ID; status: "queued" | "rendering" | "encoding" | "completed" | "failed" | "cancelled"; progress: number; createdAt: string; finishedAt: string | null; error: string | null; settings: ExportSettings; width: number; height: number; durationMs: number; sizeBytes: number | null; url: string | null; filename: string }
