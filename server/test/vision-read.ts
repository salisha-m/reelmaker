// Dev helper: run the AI frame read on one trend and store the result. Usage: tsx server/test/vision-read.ts "<title contains>"
import * as db from "../src/db.ts";
import { getAsset } from "../src/pipeline.ts";
import { buildBlueprint, listTrends, visionRead } from "../src/trends.ts";
import { usageLog } from "../src/llm.ts";
const t = listTrends().find((x) => x.title.toLowerCase().includes((process.argv[2] ?? "").toLowerCase()))!;
const a = getAsset(t.assetId!)!;
const bp = buildBlueprint(a);
const v = await visionRead(a, bp, { caption: t.source.caption, stats: t.stats });
console.log(JSON.stringify(v, null, 1)?.slice(0, 2400));
console.log("usage", JSON.stringify(usageLog));
process.exit(0);
