import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, UploadCloud, Loader2 } from "lucide-react";

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; footer?: React.ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label={title}>
      <div className={`card flex max-h-[92vh] w-full flex-col ${wide ? "max-w-5xl" : "max-w-xl"}`}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="h2">{title}</h2>
          <button className="btn-quiet !p-1.5" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function Dropzone({ onFiles, accept, label, hint, compact, busy }: { onFiles: (f: File[]) => void; accept?: string; label: string; hint?: string; compact?: boolean; busy?: number | null }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = useCallback((list: FileList | null) => { if (list?.length) onFiles([...list]); }, [onFiles]);
  return (
    <div
      className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed text-center transition-colors ${over ? "border-accent bg-accent/5" : "border-line bg-bg hover:border-faint"} ${compact ? "gap-1 px-4 py-5" : "gap-2 px-6 py-10"}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
      onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}>
      <input ref={input} type="file" multiple accept={accept} className="hidden" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
      {busy != null ? <Loader2 className="animate-spin text-accent" size={compact ? 18 : 24} /> : <UploadCloud className="text-mute" size={compact ? 18 : 26} />}
      <div className={`font-semibold ${compact ? "text-[13px]" : "text-[15px]"}`}>{busy != null ? `Uploading… ${Math.round(busy * 100)}%` : label}</div>
      {hint && <div className="text-[12px] text-mute">{hint}</div>}
    </div>
  );
}

export function Bar({ value, className = "" }: { value: number; className?: string }) {
  return <div className={`h-1 overflow-hidden rounded-full bg-line ${className}`}><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} /></div>;
}
export function Spinner({ size = 14 }: { size?: number }) { return <Loader2 size={size} className="animate-spin" />; }
export function Empty({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line px-6 py-14 text-center"><div className="text-faint">{icon}</div><div className="text-[15px] font-semibold">{title}</div>{children && <div className="max-w-md text-[13px] leading-relaxed text-mute">{children}</div>}</div>;
}
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return <div className="inline-flex rounded-lg border border-line bg-bg p-0.5">{options.map((o) => <button key={o.id} onClick={() => onChange(o.id)} className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${value === o.id ? "bg-raised text-ink" : "text-mute hover:text-ink"}`}>{o.label}</button>)}</div>;
}
export const PLATFORM: Record<string, { label: string; color: string }> = { tiktok: { label: "TikTok", color: "#25F4EE" }, instagram: { label: "Instagram", color: "#FF5CA8" }, youtube: { label: "YouTube", color: "#FF4D4D" }, upload: { label: "Upload", color: "#8d8d9c" }, link: { label: "Link", color: "#8d8d9c" } };
