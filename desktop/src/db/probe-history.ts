/** 历史仓储探针（只读） */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, resolveDbPath } from "./connection.ts";
import { HistoryRepository, HISTORY_SPECS, type HistoryKind } from "./history-repository.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = resolveDbPath(path.resolve(here, "..", "..", ".."));
const db = openDb(dbPath, { readonly: true });
const repo = new HistoryRepository(db);

const result: Record<string, number> = {};
const sample: Record<string, unknown> = {};

for (const kind of Object.keys(HISTORY_SPECS) as HistoryKind[]) {
  const s = HISTORY_SPECS[kind];
  const map = repo.getHistory(kind);
  const n = Object.keys(map).length;
  result[s.table] = n;
  console.log(`${s.table.padEnd(38)} ${String(n).padStart(4)} 条`);
  const firstKey = Object.keys(map)[0];
  if (firstKey && !sample[s.table]) {
    sample[s.table] = { email: firstKey, value: map[firstKey] };
  }
}

console.log("\n样本（每表第一条）：");
for (const [t, v] of Object.entries(sample)) {
  console.log(`  ${t}: ${JSON.stringify(v)}`);
}

db.close();
console.log("\nJSON:");
console.log(JSON.stringify(result, Object.keys(result).sort()));