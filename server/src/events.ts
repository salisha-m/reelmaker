import { EventEmitter } from "node:events";
export const bus = new EventEmitter();
bus.setMaxListeners(200);
export type AppEvent = { type: string; [k: string]: unknown };
export function emit(e: AppEvent) { bus.emit("event", e); }
