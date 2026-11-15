import type { CaptionStyle, Template, TextStyle, VideoStyle, ExportSettings } from "./types.ts";

export const APP_NAME = "Reelsmith";

// ---------- fonts (all bundled as TTF under assets/fonts, OFL licensed) ----------
export interface FontFace { family: string; weight: number; file: string }
export const FONTS: FontFace[] = [
  { family: "TikTok Sans", weight: 400, file: "TikTokSans_400Regular.ttf" },
  { family: "TikTok Sans", weight: 500, file: "TikTokSans_500Medium.ttf" },
  { family: "TikTok Sans", weight: 700, file: "TikTokSans_700Bold.ttf" },
  { family: "TikTok Sans", weight: 800, file: "TikTokSans_800ExtraBold.ttf" },
  { family: "TikTok Sans", weight: 900, file: "TikTokSans_900Black.ttf" },
  { family: "Montserrat", weight: 500, file: "Montserrat_500Medium.ttf" },
  { family: "Montserrat", weight: 700, file: "Montserrat_700Bold.ttf" },
  { family: "Montserrat", weight: 800, file: "Montserrat_800ExtraBold.ttf" },
  { family: "Montserrat", weight: 900, file: "Montserrat_900Black.ttf" },
  { family: "Poppins", weight: 500, file: "Poppins_500Medium.ttf" },
  { family: "Poppins", weight: 700, file: "Poppins_700Bold.ttf" },
  { family: "Poppins", weight: 800, file: "Poppins_800ExtraBold.ttf" },
  { family: "Poppins", weight: 900, file: "Poppins_900Black.ttf" },
  { family: "Rubik", weight: 700, file: "Rubik_700Bold.ttf" },
  { family: "Rubik", weight: 900, file: "Rubik_900Black.ttf" },
  { family: "Bebas Neue", weight: 400, file: "BebasNeue_400Regular.ttf" },
  { family: "Anton", weight: 400, file: "Anton_400Regular.ttf" },
  { family: "Bangers", weight: 400, file: "Bangers_400Regular.ttf" },
  { family: "Luckiest Guy", weight: 400, file: "LuckiestGuy_400Regular.ttf" },
  { family: "Titan One", weight: 400, file: "TitanOne_400Regular.ttf" },
  { family: "Lilita One", weight: 400, file: "LilitaOne_400Regular.ttf" },
  { family: "Fredoka", weight: 600, file: "Fredoka_600SemiBold.ttf" },
  { family: "Fredoka", weight: 700, file: "Fredoka_700Bold.ttf" },
  { family: "League Spartan", weight: 700, file: "LeagueSpartan_700Bold.ttf" },
  { family: "League Spartan", weight: 900, file: "LeagueSpartan_900Black.ttf" },
  { family: "Archivo Black", weight: 400, file: "ArchivoBlack_400Regular.ttf" },
  { family: "Oswald", weight: 500, file: "Oswald_500Medium.ttf" },
  { family: "Oswald", weight: 700, file: "Oswald_700Bold.ttf" },
  { family: "Inter", weight: 400, file: "Inter_400Regular.ttf" },
  { family: "Inter", weight: 500, file: "Inter_500Medium.ttf" },
  { family: "Inter", weight: 600, file: "Inter_600SemiBold.ttf" },
  { family: "Inter", weight: 700, file: "Inter_700Bold.ttf" },
  { family: "Inter", weight: 800, file: "Inter_800ExtraBold.ttf" },
  { family: "Inter", weight: 900, file: "Inter_900Black.ttf" },
  { family: "DM Sans", weight: 700, file: "DMSans_700Bold.ttf" },
  { family: "Space Grotesk", weight: 500, file: "SpaceGrotesk_500Medium.ttf" },
  { family: "Space Grotesk", weight: 700, file: "SpaceGrotesk_700Bold.ttf" },
  { family: "Courier Prime", weight: 400, file: "CourierPrime_400Regular.ttf" },
  { family: "Courier Prime", weight: 700, file: "CourierPrime_700Bold.ttf" },
  { family: "Instrument Serif", weight: 400, file: "InstrumentSerif_400Regular.ttf" },
  { family: "Instrument Serif Italic", weight: 400, file: "InstrumentSerif_400Regular_Italic.ttf" },
  { family: "DM Serif Display", weight: 400, file: "DMSerifDisplay_400Regular.ttf" },
  { family: "Playfair Display", weight: 700, file: "PlayfairDisplay_700Bold.ttf" },
  { family: "Playfair Display", weight: 900, file: "PlayfairDisplay_900Black.ttf" },
  { family: "Permanent Marker", weight: 400, file: "PermanentMarker_400Regular.ttf" },
  { family: "Caveat", weight: 700, file: "Caveat_700Bold.ttf" },
  { family: "Tilt Neon", weight: 400, file: "TiltNeon_400Regular.ttf" },
];
export const FONT_FAMILIES = [...new Set(FONTS.map((f) => f.family))];
/** Each bundled weight is registered under its own family name so browser canvas and the server canvas pick the identical file. */
export function fontKey(family: string, weight: number): string {
  const faces = FONTS.filter((f) => f.family.toLowerCase() === family.toLowerCase());
  if (!faces.length) return fontKey("Inter", weight);
  let best = faces[0]!;
  for (const f of faces) if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f;
  return `${best.family} ${best.weight}`.replace(/ /g, "_");
}
export function resolveFamily(family: string): string {
  const hit = FONT_FAMILIES.find((f) => f.toLowerCase() === String(family || "").toLowerCase().trim());
  return hit ?? "Inter";
}

// ---------- text defaults ----------
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: "Montserrat", fontWeight: 900, fontSize: 96, color: "#FFFFFF", align: "center", lineHeight: 1.1, letterSpacing: 0,
  textTransform: "none", strokeColor: null, strokeWidth: 0, shadow: { color: "rgba(0,0,0,0.55)", blur: 18, x: 0, y: 4 }, background: null, maxWidth: 0.86,
};
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: "Montserrat", fontWeight: 900, fontSize: 76, color: "#FFFFFF", align: "center", lineHeight: 1.08, letterSpacing: 0,
  textTransform: "uppercase", strokeColor: "#000000", strokeWidth: 9, shadow: { color: "rgba(0,0,0,0.9)", blur: 0, x: 0, y: 6 }, background: null, maxWidth: 0.82,
  mode: "highlight", highlightStyle: "color", position: 0.66, highlightColor: "#FFE600", emphasisColor: "#39FF14", emphasisScale: 1.18, animation: "pop",
  maxWordsPerPhrase: 3, maxCharsPerLine: 16, maxLines: 2, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, lineBackground: null,
};

// ---------- caption looks ----------
export interface CaptionTemplate { id: string; name: string; description: string; seenIn: string; tags: string[]; accentColor: string; style: Partial<CaptionStyle> }
const SH = (y = 6) => ({ color: "rgba(0,0,0,0.9)", blur: 0, x: 0, y });
/** Caption looks modelled on what short-form creators actually post with. `seenIn` says where each look is common. */
export const CAPTION_TEMPLATES: CaptionTemplate[] = [
  { id: "bold-pop", name: "Bold Pop", seenIn: "Business, podcast and talking-head clips", description: "Montserrat Black, all caps, thick black outline with a hard drop shadow. Two or three words at a time, the spoken word turns yellow, key words go green.", tags: ["highlight", "caps", "most used"], accentColor: "#FFE600",
    style: { mode: "highlight", highlightStyle: "color", fontFamily: "Montserrat", fontWeight: 900, fontSize: 76, textTransform: "uppercase", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 9, shadow: SH(6), highlightColor: "#FFE600", emphasisColor: "#39FF14", emphasisScale: 1.18, animation: "pop", position: 0.66, maxWordsPerPhrase: 3, maxCharsPerLine: 16, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, letterSpacing: 0, lineHeight: 1.08 } },
  { id: "word-box", name: "Word Box", seenIn: "Reels and TikTok explainers, CapCut auto-captions", description: "Poppins ExtraBold. The phrase stays up and the spoken word sits on a rounded colour box that jumps from word to word.", tags: ["karaoke", "box"], accentColor: "#8B5CF6",
    style: { mode: "highlight", highlightStyle: "box", highlightBox: { color: "#8B5CF6", radius: 14, padX: 14, padY: 6, textColor: "#FFFFFF" }, fontFamily: "Poppins", fontWeight: 800, fontSize: 66, textTransform: "none", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 5, shadow: SH(4), animation: "none", position: 0.68, maxWordsPerPhrase: 4, maxCharsPerLine: 20, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1.04, letterSpacing: 0, lineHeight: 1.22 } },
  { id: "tiktok-classic", name: "TikTok Classic", seenIn: "Native TikTok text, storytimes, POVs", description: "TikTok Sans Bold on a tight rounded box behind each line, the look of text typed inside TikTok itself.", tags: ["native", "box"], accentColor: "#FFFFFF",
    style: { mode: "phrase", fontFamily: "TikTok Sans", fontWeight: 700, fontSize: 56, textTransform: "none", color: "#111111", strokeColor: null, strokeWidth: 0, shadow: null, lineBackground: { color: "#FFFFFF", padX: 20, padY: 9, radius: 14 }, background: null, animation: "none", position: 0.7, maxWordsPerPhrase: 6, maxCharsPerLine: 24, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, emphasisColor: "#FE2C55", emphasisScale: 1, highlightColor: "#FE2C55", letterSpacing: 0, lineHeight: 1.42 } },
  { id: "tiktok-outline", name: "TikTok Outline", seenIn: "Native TikTok and Reels captions", description: "TikTok Sans ExtraBold, white with a black outline. Short phrases, sentence case, no animation.", tags: ["native", "phrases"], accentColor: "#FFFFFF",
    style: { mode: "phrase", fontFamily: "TikTok Sans", fontWeight: 800, fontSize: 62, textTransform: "none", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 7, shadow: null, lineBackground: null, background: null, animation: "none", position: 0.7, maxWordsPerPhrase: 5, maxCharsPerLine: 22, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, emphasisColor: "#FFE600", emphasisScale: 1.12, highlightColor: "#FFE600", letterSpacing: 0, lineHeight: 1.12 } },
  { id: "comic-pop", name: "Comic Pop", seenIn: "Challenge, gaming and reaction videos", description: "Bangers, all caps, heavy outline, tilted a few degrees. One or two words slam in at a time; key words go red.", tags: ["word-by-word", "loud"], accentColor: "#FF3B30",
    style: { mode: "word", fontFamily: "Bangers", fontWeight: 400, fontSize: 118, textTransform: "uppercase", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 11, shadow: SH(8), animation: "pop", position: 0.6, maxWordsPerPhrase: 1, maxCharsPerLine: 14, lineBackground: null, background: null, upcomingOpacity: 1, tilt: -4, glow: null, activeScale: 1, emphasisColor: "#FF3B30", emphasisScale: 1.2, highlightColor: "#FFE600", letterSpacing: 2, lineHeight: 1.05 } },
  { id: "karaoke-green", name: "Karaoke", seenIn: "Fitness, motivation and sports edits", description: "Rubik Black, all caps. Three words on screen, the spoken one flips to neon green and grows slightly.", tags: ["highlight", "caps"], accentColor: "#22FF88",
    style: { mode: "highlight", highlightStyle: "color", fontFamily: "Rubik", fontWeight: 900, fontSize: 74, textTransform: "uppercase", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 8, shadow: SH(5), highlightColor: "#22FF88", emphasisColor: "#22FF88", emphasisScale: 1.1, animation: "none", position: 0.66, maxWordsPerPhrase: 3, maxCharsPerLine: 16, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1.12, letterSpacing: 0, lineHeight: 1.08 } },
  { id: "build-up", name: "Build Up", seenIn: "Story and commentary clips", description: "TikTok Sans Black. Words appear one by one as they are spoken and stay until the phrase ends.", tags: ["build", "phrases"], accentColor: "#FFFFFF",
    style: { mode: "highlight", highlightStyle: "color", fontFamily: "TikTok Sans", fontWeight: 900, fontSize: 68, textTransform: "none", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 7, shadow: SH(4), highlightColor: "#FFFFFF", emphasisColor: "#FFE600", emphasisScale: 1.15, animation: "none", position: 0.68, maxWordsPerPhrase: 5, maxCharsPerLine: 20, lineBackground: null, background: null, upcomingOpacity: 0, tilt: 0, glow: null, activeScale: 1.06, letterSpacing: 0, lineHeight: 1.12 } },
  { id: "tall-caps", name: "Tall Caps", seenIn: "Gym edits, cinematic b-roll, quotes", description: "Bebas Neue, wide tracking, soft shadow and no outline. One line at a time.", tags: ["phrases", "cinematic"], accentColor: "#F5F5F5",
    style: { mode: "phrase", fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 92, textTransform: "uppercase", color: "#FFFFFF", strokeColor: null, strokeWidth: 0, shadow: { color: "rgba(0,0,0,0.7)", blur: 18, x: 0, y: 3 }, animation: "fade", position: 0.72, maxWordsPerPhrase: 4, maxCharsPerLine: 22, maxLines: 1, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, emphasisColor: "#FFD60A", emphasisScale: 1.1, highlightColor: "#FFD60A", letterSpacing: 4, lineHeight: 1.0 } },
  { id: "chunky", name: "Chunky Meme", seenIn: "Meme edits, pets, comedy skits", description: "Luckiest Guy in yellow with a fat black outline. Word by word with a bounce.", tags: ["word-by-word", "fun"], accentColor: "#FFD60A",
    style: { mode: "word", fontFamily: "Luckiest Guy", fontWeight: 400, fontSize: 104, textTransform: "uppercase", color: "#FFD60A", strokeColor: "#000000", strokeWidth: 10, shadow: SH(7), animation: "pop", position: 0.62, maxWordsPerPhrase: 1, maxCharsPerLine: 14, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, emphasisColor: "#FFFFFF", emphasisScale: 1.15, highlightColor: "#FFFFFF", letterSpacing: 1, lineHeight: 1.05 } },
  { id: "typewriter", name: "Typewriter", seenIn: "Storytimes, confessions, text-on-video POVs", description: "Courier Prime Bold on dark line boxes, words typing in as they are spoken.", tags: ["build", "story"], accentColor: "#111111",
    style: { mode: "highlight", highlightStyle: "color", fontFamily: "Courier Prime", fontWeight: 700, fontSize: 50, textTransform: "none", color: "#FFFFFF", strokeColor: null, strokeWidth: 0, shadow: null, lineBackground: { color: "rgba(0,0,0,0.82)", padX: 16, padY: 8, radius: 4 }, background: null, highlightColor: "#FFFFFF", emphasisColor: "#FFE600", emphasisScale: 1, animation: "none", position: 0.7, maxWordsPerPhrase: 6, maxCharsPerLine: 26, upcomingOpacity: 0, tilt: 0, glow: null, activeScale: 1, letterSpacing: 0, lineHeight: 1.5 } },
  { id: "soft-serif", name: "Soft Serif", seenIn: "Aesthetic vlogs, day-in-the-life, travel", description: "Instrument Serif Italic, small and lower case, cream with a soft shadow. Quiet on purpose.", tags: ["phrases", "aesthetic"], accentColor: "#F4EBDD",
    style: { mode: "phrase", fontFamily: "Instrument Serif Italic", fontWeight: 400, fontSize: 58, textTransform: "lowercase", color: "#FBF6EC", strokeColor: null, strokeWidth: 0, shadow: { color: "rgba(0,0,0,0.6)", blur: 16, x: 0, y: 2 }, animation: "fade", position: 0.76, maxWordsPerPhrase: 6, maxCharsPerLine: 30, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, emphasisColor: "#FBF6EC", emphasisScale: 1.2, highlightColor: "#FBF6EC", letterSpacing: 0, lineHeight: 1.15 } },
  { id: "clean-pod", name: "Clean Podcast", seenIn: "Podcast clips, interviews, founder content", description: "Inter Bold in the lower third, one line, the spoken word in yellow. Readable without shouting.", tags: ["highlight", "clean"], accentColor: "#FFD60A",
    style: { mode: "highlight", highlightStyle: "color", fontFamily: "Inter", fontWeight: 800, fontSize: 56, textTransform: "none", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 4, shadow: { color: "rgba(0,0,0,0.55)", blur: 12, x: 0, y: 3 }, highlightColor: "#FFD60A", emphasisColor: "#FFD60A", emphasisScale: 1.08, animation: "none", position: 0.78, maxWordsPerPhrase: 5, maxCharsPerLine: 28, maxLines: 1, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1, letterSpacing: 0, lineHeight: 1.15 } },
  { id: "marker", name: "Marker", seenIn: "Art, DIY, casual vlogs", description: "Permanent Marker with a black outline, key words in yellow.", tags: ["phrases", "casual"], accentColor: "#FFE600",
    style: { mode: "phrase", fontFamily: "Permanent Marker", fontWeight: 400, fontSize: 70, textTransform: "none", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 7, shadow: SH(4), animation: "pop", position: 0.68, maxWordsPerPhrase: 4, maxCharsPerLine: 20, lineBackground: null, background: null, upcomingOpacity: 1, tilt: -2, glow: null, activeScale: 1, emphasisColor: "#FFE600", emphasisScale: 1.15, highlightColor: "#FFE600", letterSpacing: 0, lineHeight: 1.1 } },
  { id: "neon", name: "Neon", seenIn: "Night edits, music clips, nightlife", description: "Tilt Neon with a coloured glow. Word by word.", tags: ["word-by-word", "glow"], accentColor: "#FF2D95",
    style: { mode: "word", fontFamily: "Tilt Neon", fontWeight: 400, fontSize: 104, textTransform: "none", color: "#FFFFFF", strokeColor: null, strokeWidth: 0, shadow: null, glow: { color: "#FF2D95", blur: 26 }, animation: "fade", position: 0.6, maxWordsPerPhrase: 1, maxCharsPerLine: 14, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, activeScale: 1, emphasisColor: "#22D3EE", emphasisScale: 1.1, highlightColor: "#22D3EE", letterSpacing: 0, lineHeight: 1.05 } },
  { id: "bubble", name: "Bubble", seenIn: "Lifestyle, food, family content", description: "Fredoka Bold, rounded and friendly, white with a dark outline and a pink word box.", tags: ["karaoke", "friendly"], accentColor: "#FF5CA8",
    style: { mode: "highlight", highlightStyle: "box", highlightBox: { color: "#FF5CA8", radius: 22, padX: 14, padY: 5, textColor: "#FFFFFF" }, fontFamily: "Fredoka", fontWeight: 700, fontSize: 68, textTransform: "none", color: "#FFFFFF", strokeColor: "#1F1F1F", strokeWidth: 6, shadow: SH(4), animation: "none", position: 0.68, maxWordsPerPhrase: 4, maxCharsPerLine: 20, lineBackground: null, background: null, upcomingOpacity: 1, tilt: 0, glow: null, activeScale: 1.04, emphasisColor: "#FFE600", emphasisScale: 1.1, highlightColor: "#FFE600", letterSpacing: 0, lineHeight: 1.22 } },
];
export const captionTemplate = (id: string) => CAPTION_TEMPLATES.find((t) => t.id === id);

// ---------- video styles (fonts + colours + grade) ----------
export const STYLES: VideoStyle[] = [
  {
    id: "studio",
    name: "Studio Default",
    description: "The default short-form look: Montserrat Black captions with keyword highlights, heavy titles, a serif italic accent.",
    fonts: { caption: { family: "Montserrat", weight: 900 }, title: { family: "Montserrat", weight: 900 }, accent: { family: "Instrument Serif Italic", weight: 400 } },
    palette: [ { name: "Ink", hex: "#14161A" }, { name: "Paper", hex: "#F6F4EE" }, { name: "Signal", hex: "#5B8CFF" }, { name: "Citrus", hex: "#FFE14D" } ],
    grade: { filterId: null, strength: 0 },
    captionDefaults: {},
    guidance: "The look most short-form talking videos use: heavy all-caps captions with a black outline, the spoken word highlighted, key words in a second colour. Heavy sans titles. No grade unless asked.",
  },
  {
    id: "cinematic",
    name: "Cinematic",
    description: "Warmer grade, larger serif titles, slower emphasis moments.",
    fonts: { caption: { family: "Inter", weight: 600 }, title: { family: "Playfair Display", weight: 700 }, accent: { family: "DM Serif Display", weight: 400 } },
    palette: [ { name: "Umber", hex: "#1C1612" }, { name: "Cream", hex: "#F4EBDD" }, { name: "Amber", hex: "#E0A458" }, { name: "Moss", hex: "#5F7A61" } ],
    grade: { filterId: "warm-film", strength: 70 },
    captionDefaults: { fontFamily: "Inter", fontWeight: 600, color: "#F7F1E6", strokeColor: null, strokeWidth: 0, shadow: { color: "rgba(0,0,0,0.65)", blur: 20, x: 0, y: 4 }, highlightColor: "#E0A458", emphasisColor: "#E0A458", animation: "fade" },
    guidance: "Warm, soft grade on every clip (warm-film filter). Serif titles set large, cream on dark. Hold emphasis moments a beat longer; prefer fades to pops.",
  },
  {
    id: "punchy",
    name: "Punchy Social",
    description: "High-contrast, saturated, heavy all-caps type with a yellow accent. Built for fast short-form.",
    fonts: { caption: { family: "Montserrat", weight: 900 }, title: { family: "Anton", weight: 400 }, accent: { family: "Caveat", weight: 700 } },
    palette: [ { name: "Black", hex: "#0B0B0C" }, { name: "White", hex: "#FFFFFF" }, { name: "Yellow", hex: "#FFE14D" }, { name: "Hot", hex: "#FF4D6D" } ],
    grade: { filterId: "vivid", strength: 55 },
    captionDefaults: { fontFamily: "Montserrat", fontWeight: 900, textTransform: "uppercase", color: "#FFFFFF", strokeColor: "#000000", strokeWidth: 9, highlightColor: "#FFE14D", emphasisColor: "#FFE14D", animation: "pop" },
    guidance: "Loud and fast. Upper-case heavy captions with a thick outline, yellow on the words that matter, a light vivid grade. Titles in condensed display type.",
  },
];

// ---------- templates (structure the agent follows) ----------
export const TEMPLATES: Template[] = [
  {
    id: "short-talking-head",
    name: "Short Talking Head",
    description: "One person, one point. Tight, captioned, vertical. Hook first, no dead air, stop on the last useful word.",
    category: "talking-head",
    bestFor: "Opinions, advice, announcements, product updates",
    length: "20-90 seconds",
    aspect: "9:16",
    captions: "3-5 word phrases by default, word-by-word on request",
    music: "Off by default",
    guidance: {
      structure: "Open on the strongest line inside the first two seconds, then two to four points in the order they were spoken, then a close. When a sentence was said more than once, keep the best take, not the first.",
      pacing: "Remove pauses longer than about half a second, filler words and restarts. On sentence breaks alternate the full frame with a slight punch-in (about 110-115% scale) so jump cuts read as intentional.",
      captions: "Phrase captions of 3-5 words in the style's caption font, centred below the mouth, no animation unless asked. Never cover the face.",
      broll: "None by default. If extra clips were uploaded and the speaker mentions what they show, cut to them for 2-3 seconds over the matching words while the voice continues.",
      ending: "Cut on the last useful word. No fade out, no outro, no call to subscribe unless it was spoken.",
    },
    defaults: { captionsOn: true, captionMode: "phrase", musicOn: false, musicVolume: 0.12, removePausesOverMs: 500, targetSeconds: [20, 90], punchIn: true },
    prompts: [
      "Cut this take down to the best 60 seconds for Reels. Keep my strongest take of each point, remove pauses and restarts. Captions on.",
      "Same cut, but make my key line a big bold caption on its own, and add a small lower third with my name for the first 4 seconds.",
      "Add the screen recording as a picture-in-picture top right whenever I talk about the dashboard.",
    ],
    builtin: true,
  },
  {
    id: "vlog",
    name: "Vlog",
    description: "A day built from lots of short clips. Music sets the pace, location changes are the structure, captions only when someone talks.",
    category: "vlog",
    bestFor: "Day-in-the-life, travel days, studio days, errands, trips with friends",
    length: "30-90 seconds short, 3-10 minutes long",
    aspect: "9:16",
    captions: "Only during speech, 3-5 word phrases",
    music: "On by default, ducked under speech",
    guidance: {
      structure: "Chronological, using recording times and file order. A change of location starts a new section. Optional title card or spoken hook at the very start.",
      pacing: "Fast through movement and b-roll, slower while someone is talking. Around two to four seconds a shot on short vlogs. When a music track is present, land b-roll cuts on its beats.",
      captions: "Phrase captions during speech only. None over b-roll.",
      broll: "Anything that is not a talking clip. Cut to the beat and order it to match what is being said.",
      ending: "Last location, last line, then a short music tail (about a second).",
    },
    defaults: { captionsOn: true, captionMode: "phrase", musicOn: true, musicVolume: 0.22, removePausesOverMs: 700, targetSeconds: [30, 90], punchIn: false },
    prompts: [
      "Cut a first draft of this day from all the clips, about 60 seconds, 9:16, to the attached track. Keep me talking where I explain what we're doing. Everything else is b-roll on the beat.",
      "Add a title card at the start in the title font, and a small label when the location changes.",
      "Make it calmer. Longer shots, fewer cuts in the middle, and drop the music to 20% while people are talking.",
    ],
    builtin: true,
  },
  {
    id: "long-podcast",
    name: "Long Podcast",
    description: "The conversation is the point. Keep it in order, switch angles on who is speaking, clean dead air, find clips by topic.",
    category: "podcast",
    bestFor: "Podcasts, interviews, panels, two-person calls",
    length: "15-120 minutes for the episode, 30-90 seconds for clips",
    aspect: "16:9",
    captions: "Off on the full episode, on for clips",
    music: "Intro and outro only, ducked under speech",
    guidance: {
      structure: "Keep the episode in recorded order. Add a cold open only when asked.",
      pacing: "Remove long silences (over about 1.2 seconds) and restarts. Keep short natural pauses and thinking beats.",
      captions: "None on the full episode. For vertical clips use phrase captions placed to clear the bottom 15% of the frame.",
      broll: "With two or more camera angles, align them and cut to whoever is speaking; use the wide shot for laughter and crosstalk. Bring in screen shares when they are mentioned.",
      ending: "Clean out on the last exchange, then outro music if a track was provided.",
    },
    defaults: { captionsOn: false, captionMode: "phrase", musicOn: false, musicVolume: 0.15, removePausesOverMs: 1200, targetSeconds: [900, 7200], punchIn: false },
    prompts: [
      "Find the three strongest 45-second moments in this episode for Shorts: a clear opinion, a story, and a practical tip. List them with timestamps before cutting.",
      "Cut clip two as 9:16 with the speaker centred, word-by-word captions in white, and the guest's name as a lower third for the first 4 seconds.",
      "Clean the full episode: remove dead air over a second and restarts, keep everything in order, no captions.",
    ],
    builtin: true,
  },
  {
    id: "beat-montage",
    name: "Beat Montage",
    description: "Every cut on the beat. Short clips, one song, no speech needed.",
    category: "montage",
    bestFor: "Recaps, highlight reels, travel, product reels, music-driven edits",
    length: "15-45 seconds",
    aspect: "9:16",
    captions: "Off",
    music: "Required, full volume",
    guidance: {
      structure: "Open on the widest or most striking shot on the first downbeat. Order clips for variety (wide, detail, movement), or chronologically when asked. End on the last strong hit and hold the final shot about a second.",
      pacing: "One clip per beat in high-energy sections, one clip every two beats in calmer sections. Pick the most interesting second or two of each clip, favouring movement and faces.",
      captions: "None unless asked. An optional title card on the first beats.",
      broll: "Everything is b-roll. Mute clip audio unless asked to keep it under the music.",
      ending: "Last hit, hold the final shot for one second, music out with a short fade.",
    },
    defaults: { captionsOn: false, captionMode: "phrase", musicOn: true, musicVolume: 1, removePausesOverMs: null, targetSeconds: [15, 45], punchIn: false },
    prompts: [
      "Cut this montage to the beat of the attached track. One clip per beat in the chorus, one every two beats in the verses. Start on the first downbeat, end on the last hit, then hold the final shot for 1 second.",
      "Build a 30-second highlight reel from all the clips, synced to the song. Pick the 8-10 most interesting moments, favour movement and faces.",
    ],
    builtin: true,
  },
];

// ---------- colour filters ----------
export interface FilterPreset { id: string; name: string; description: string; effects: { id: string; value: number }[] }
/** Effect values are deltas at 100% strength. brightness/contrast/saturation: percent points; temperature/tint: -100..100; vignette 0..100; fade 0..100. */
export const FILTERS: FilterPreset[] = [
  { id: "warm-film", name: "Warm Film", description: "Warm, slightly lifted blacks, soft contrast.", effects: [ { id: "temperature", value: 26 }, { id: "contrast", value: 8 }, { id: "saturation", value: -6 }, { id: "fade", value: 10 }, { id: "vignette", value: 22 } ] },
  { id: "cool-teal", name: "Cool Teal", description: "Cool shadows, crisp contrast.", effects: [ { id: "temperature", value: -24 }, { id: "tint", value: -8 }, { id: "contrast", value: 12 }, { id: "saturation", value: 4 } ] },
  { id: "vivid", name: "Vivid", description: "Punchy contrast and colour.", effects: [ { id: "contrast", value: 16 }, { id: "saturation", value: 24 }, { id: "brightness", value: 3 } ] },
  { id: "moody", name: "Moody", description: "Darker, desaturated, strong vignette.", effects: [ { id: "brightness", value: -10 }, { id: "contrast", value: 18 }, { id: "saturation", value: -22 }, { id: "vignette", value: 40 } ] },
  { id: "bright-clean", name: "Bright Clean", description: "Lifted, airy, neutral.", effects: [ { id: "brightness", value: 9 }, { id: "contrast", value: -4 }, { id: "saturation", value: 6 } ] },
  { id: "vintage", name: "Vintage", description: "Faded, warm, low saturation.", effects: [ { id: "sepia", value: 28 }, { id: "fade", value: 18 }, { id: "saturation", value: -14 }, { id: "vignette", value: 26 } ] },
  { id: "mono", name: "Mono", description: "Black and white with firm contrast.", effects: [ { id: "grayscale", value: 100 }, { id: "contrast", value: 14 } ] },
];
export const EFFECT_IDS = ["brightness", "contrast", "saturation", "temperature", "tint", "blur", "vignette", "grayscale", "sepia", "hue", "fade"] as const;
export const EFFECT_INFO: Record<string, { name: string; min: number; max: number; unit: string; description: string }> = {
  brightness: { name: "Brightness", min: -100, max: 100, unit: "%", description: "Lighter or darker. 0 is unchanged." },
  contrast: { name: "Contrast", min: -100, max: 100, unit: "%", description: "0 is unchanged." },
  saturation: { name: "Saturation", min: -100, max: 100, unit: "%", description: "-100 is greyscale, 0 unchanged." },
  temperature: { name: "Temperature", min: -100, max: 100, unit: "", description: "Negative is cooler (blue), positive warmer (orange)." },
  tint: { name: "Tint", min: -100, max: 100, unit: "", description: "Negative is green, positive magenta." },
  blur: { name: "Gaussian blur", min: 0, max: 100, unit: "px", description: "Blur radius at 1080p." },
  vignette: { name: "Vignette", min: 0, max: 100, unit: "%", description: "Darkens the corners." },
  grayscale: { name: "Greyscale", min: 0, max: 100, unit: "%", description: "" },
  sepia: { name: "Sepia", min: 0, max: 100, unit: "%", description: "" },
  hue: { name: "Hue rotate", min: -180, max: 180, unit: "deg", description: "" },
  fade: { name: "Fade", min: 0, max: 100, unit: "%", description: "Lifts the blacks for a matte look." },
};

// ---------- export ----------
export interface ExportPreset { id: string; name: string; description: string; resolution: ExportSettings["resolution"]; bitrateMbps: number; format: "mp4" | "webm"; fps?: number }
export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "social", name: "Instagram / TikTok", description: "1080p · 20 Mbps · Optimized for social", resolution: "1080p", bitrateMbps: 20, format: "mp4" },
  { id: "shorts", name: "YouTube Shorts", description: "1080p · 20 Mbps · 60fps ready", resolution: "1080p", bitrateMbps: 20, format: "mp4" },
  { id: "high", name: "High Quality", description: "Original · 35 Mbps · Maximum fidelity", resolution: "original", bitrateMbps: 35, format: "mp4" },
  { id: "balanced", name: "Balanced", description: "Original · 10 Mbps · Quality & size", resolution: "original", bitrateMbps: 10, format: "mp4" },
  { id: "small", name: "Small File", description: "720p · 5 Mbps · Fast uploads", resolution: "720p", bitrateMbps: 5, format: "mp4" },
  { id: "webm", name: "WebM", description: "1080p · VP9 · For the web", resolution: "1080p", bitrateMbps: 8, format: "webm" },
];
export const RESOLUTION_SHORT_SIDE: Record<string, number> = { "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440, "4k": 2160 };

export const CANVAS_PRESETS = [
  { id: "9:16", label: "9:16 vertical · 1080×1920", width: 1080, height: 1920 },
  { id: "16:9", label: "16:9 horizontal · 1920×1080", width: 1920, height: 1080 },
  { id: "1:1", label: "1:1 square · 1080×1080", width: 1080, height: 1080 },
  { id: "4:5", label: "4:5 portrait · 1080×1350", width: 1080, height: 1350 },
];

export const TRANSITION_KINDS = ["crossfade", "fade-black", "fade-white", "slide-left", "slide-right", "slide-up", "slide-down", "wipe-left", "wipe-right", "zoom-in", "zoom-out", "blur"] as const;

export const FILLER_WORDS = new Set(["um", "uh", "uhm", "umm", "erm", "er", "ah", "hmm", "mm", "mhm", "uhh"]);
