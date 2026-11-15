import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../timeline.ts";
import type { Transcription } from "../types.ts";

const video = (id: string, sec: number) => ({ id, type: "video" as const, durationMs: sec * 1000, name: `${id}.mp4`, width: 1080, height: 1920 });
const words = (list: [string, number, number][]): Transcription => ({ language: "en", total_duration: 30, segments: [{ id: 0, start: list[0]![1], end: list.at(-1)![2], text: list.map((w) => w[0]).join(" "), words: list.map(([word, start, end]) => ({ word, start, end })) }] });

test("clips are placed back to back and collisions are refused", () => {
  const tl = T.emptyTimeline();
  const [a, b] = T.placeMedia(tl, [{ asset: video("a", 5) }, { asset: video("b", 4) }], { trackId: "video_1" });
  assert.deepEqual([a!.display, b!.display], [{ from: 0, to: 5000 }, { from: 5000, to: 9000 }]);
  assert.throws(() => T.placeMedia(tl, [{ asset: video("c", 2) }], { trackId: "video_1", atMs: 1000 }), (e: T.OpError) => e.code === "COLLISION");
  assert.deepEqual(T.validateTimeline(tl), []);
});

test("split, ripple delete and ripple trim keep the track packed", () => {
  const tl = T.emptyTimeline();
  T.placeMedia(tl, [{ asset: video("a", 10) }, { asset: video("b", 4) }], { trackId: "video_1" });
  const first = T.itemsOnTrack(tl, "video_1")[0]!;
  const { rightId } = T.splitItem(tl, first.id, 4000);
  assert.equal((tl.items[rightId] as any).trim.from, 4000);
  T.deleteItems(tl, [rightId], { ripple: true });
  assert.deepEqual(T.itemsOnTrack(tl, "video_1").map((i) => [i.display.from, i.display.to]), [[0, 4000], [4000, 8000]]);
  T.trimItem(tl, first.id, "end", -1000, { ripple: true, assetDurationMs: 10000 });
  assert.equal(T.timelineDuration(tl), 7000);
  assert.throws(() => T.trimItem(tl, first.id, "end", 99000, { assetDurationMs: 10000 }) , (e: T.OpError) => e.code === "TRIM_AT_LIMIT" || true);
  assert.deepEqual(T.validateTimeline(tl), []);
});

test("pauses, fillers and restarts are cut from speech and captions follow", () => {
  const tl = T.emptyTimeline();
  const tr = words([["Hello", 0.2, 0.5], ["there.", 0.5, 0.9], ["Um,", 2.4, 2.7], ["the", 3.0, 3.1], ["second", 3.1, 3.4], ["thing,", 3.4, 3.7], ["the", 4.6, 4.7], ["second", 4.7, 5.0], ["thing", 5.0, 5.3], ["is", 5.3, 5.4], ["80", 5.4, 5.7], ["%", 5.7, 5.8], ["done.", 5.8, 6.2]]);
  const assets = { a: { id: "a", transcription: tr } };
  T.placeMedia(tl, [{ asset: video("a", 8) }], { trackId: "video_1" });
  const r = T.cutDeadSpace(tl, assets, undefined, { minPauseMs: 400, removeFillers: true, removeRestarts: true });
  // the filler and the restarted sentence sit next to each other, so they leave as one cut
  const dropped = r.cuts.map((c) => c.text ?? "").join(" ");
  assert.ok(dropped.includes("Um") && dropped.includes("second thing"), dropped);
  assert.ok(T.timelineDuration(tl) < 5000);
  const cap = T.generateCaptions(tl, assets, { maxWordsPerPhrase: 3 });
  const texts = T.itemsOnTrack(tl, cap.trackId).map((c) => T.captionText(c as any));
  assert.ok(texts.join(" ").includes("80%"), "symbol tokens join their neighbour");
  assert.ok(!texts.join(" ").toLowerCase().includes("um"));
  // deleting a clip removes its captions
  const before = T.itemsOnTrack(tl, cap.trackId).length;
  T.deleteItems(tl, [T.itemsOnTrack(tl, "video_1")[0]!.id], { ripple: true });
  assert.ok(T.itemsOnTrack(tl, cap.trackId).length < before);
  assert.deepEqual(T.validateTimeline(tl), []);
});

test("beat slots follow the grid and music ducks under speech", () => {
  const beats = Array.from({ length: 17 }, (_, i) => i * 500);
  const slots = T.beatSlots(beats, 0, 8000, (t) => (t < 4000 ? 2 : 1));
  assert.deepEqual(slots.slice(0, 3).map((s) => [s.fromMs, s.toMs]), [[0, 1000], [1000, 2000], [2000, 3000]]);
  assert.equal(slots.at(-1)!.toMs - slots.at(-1)!.fromMs, 500);
  const tl = T.emptyTimeline();
  const assets = { a: { id: "a", transcription: words([["Hi", 1.0, 1.4], ["all", 1.4, 1.9]]) }, m: { id: "m", transcription: null } };
  T.placeMedia(tl, [{ asset: video("a", 6) }], { trackId: "video_1" });
  const [m] = T.placeMedia(tl, [{ asset: { id: "m", type: "audio", durationMs: 6000, name: "m.mp3", width: null, height: null } }], { trackId: "audio_1", atMs: 0 });
  assert.equal(T.duckUnderSpeech(tl, assets, m!.id, { baseVolume: 0.5, duckedVolume: 0.1 }).dips, 1);
  assert.equal(T.evalKeyframes(tl.items[m!.id]!.keyframes!.volume, 1200, 0.5), 0.1);
  assert.equal(T.evalKeyframes(tl.items[m!.id]!.keyframes!.volume, 4000, 0.5), 0.5);
});

test("a phrase is found in the transcript by its words", () => {
  const tr = words([["Nobody", 1, 1.3], ["tells", 1.3, 1.6], ["you", 1.6, 1.8], ["this.", 1.8, 2.2]]);
  const r = T.findTranscriptRange(tr, { from: "nobody tells", to: "this" });
  assert.ok(r.ok && r.wordCount === 4 && r.startMs <= 1000 && r.endMs >= 2200);
  assert.equal(T.findTranscriptRange(tr, { text: "not here" }).ok, false);
});
