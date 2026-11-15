import * as db from "../src/db.ts";
for (const s of db.list<any>("sound")) { const posts = s.postIds.map((id: string) => db.get<any>("trend", id)).filter(Boolean); if (posts.some((t: any) => (t.blueprint?.audio.speechCoverage ?? 0) >= 0.25)) { for (const t of posts) { t.soundId = null; db.put("trend", t.id, t); } db.del("sound", s.id); console.log("removed sound", s.title); } }
for (const p of db.list<any>("project")) { db.del("project", p.id); db.del("timeline", p.id); }
process.exit(0);
