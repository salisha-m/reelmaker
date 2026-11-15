// Small document store on the SQLite that ships with Node. Every record is JSON keyed by (kind, id).
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { DATA_DIR } from "./config.ts";

const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
db.exec("CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id))");
db.exec("CREATE INDEX IF NOT EXISTS docs_kind_updated ON docs (kind, updated_at)");

const qGet = db.prepare("SELECT data FROM docs WHERE kind = ? AND id = ?");
const qPut = db.prepare("INSERT INTO docs (kind, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
const qDel = db.prepare("DELETE FROM docs WHERE kind = ? AND id = ?");
const qList = db.prepare("SELECT data FROM docs WHERE kind = ? ORDER BY created_at DESC");

export function get<T>(kind: string, id: string): T | null {
  const row = qGet.get(kind, id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : null;
}
export function put<T>(kind: string, id: string, data: T): T {
  const now = new Date().toISOString();
  qPut.run(kind, id, JSON.stringify(data), now, now);
  return data;
}
export function del(kind: string, id: string) { qDel.run(kind, id); }
export function list<T>(kind: string): T[] {
  return (qList.all(kind) as { data: string }[]).map((r) => JSON.parse(r.data) as T);
}
export function update<T>(kind: string, id: string, fn: (cur: T) => T | void): T | null {
  const cur = get<T>(kind, id);
  if (!cur) return null;
  const next = fn(cur) ?? cur;
  return put(kind, id, next);
}
let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1296;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`;
}
