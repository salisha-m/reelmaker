import React, { useEffect, useRef } from "react";
import type { CaptionItem, CaptionStyle, Timeline } from "@shared/types";
import { DEFAULT_CAPTION_STYLE } from "@shared/catalog";
import { renderFrame, type RenderResources } from "@shared/render";
import { useApp } from "../store";

const SAMPLE = ["This", "is", "how", "your", "captions", "look"];
/** A live sample of a caption look, drawn by the same code that renders the video. */
export function CaptionPreview({ style, width = 220, height = 96, animate = true }: { style: Partial<CaptionStyle>; width?: number; height?: number; animate?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fontsReady = useApp((s) => s.fontsReady);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !fontsReady) return;
    const W = 1080, H = Math.round((1080 * height) / width);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    const st: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...style, position: 0.5, fontSize: Math.min(style.fontSize ?? 76, 92) * 1.25, animation: "none", tilt: style.tilt ?? 0 };
    const per = st.mode === "word" ? 1 : Math.min(st.maxWordsPerPhrase ?? 3, 4);
    const groups: string[][] = [];
    for (let i = 0; i < SAMPLE.length; i += per) groups.push(SAMPLE.slice(i, i + per));
    const wordMs = 420;
    const total = SAMPLE.length * wordMs;
    const tl: Timeline = { size: { width: W, height: H }, fps: 30, background: "#17171f", tracks: [{ id: "c", kind: "caption", name: "c", muted: false, hidden: false, locked: false, gain: 1, captionStyle: st }], items: {}, transitions: [], markers: [], version: 1 };
    let n = 0;
    groups.forEach((g, gi) => {
      const from = n * wordMs;
      const item: CaptionItem = { id: `c${gi}`, trackId: "c", type: "caption", display: { from, to: from + g.length * wordMs }, linkedItemId: "", manual: true, words: g.map((w, k) => ({ text: w, s: k * wordMs, e: (k + 1) * wordMs, emphasis: w === "captions" })) };
      tl.items[item.id] = item; n += g.length;
    });
    const res: RenderResources = { getFrame: () => null, scratch: () => ({ canvas, ctx }) };
    let raf = 0;
    const start = performance.now();
    const draw = () => {
      const t = animate ? (performance.now() - start) % total : wordMs * 1.5;
      ctx.setTransform((width * dpr) / W, 0, 0, (width * dpr) / W, 0, 0);
      renderFrame(ctx, tl, t, res);
      if (animate) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [style, width, height, animate, fontsReady]);
  return <canvas ref={ref} style={{ width, height }} className="rounded-lg" />;
}
