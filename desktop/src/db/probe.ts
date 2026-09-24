/**
 * 数据库探针：只读打开真实 accounts.db，打印各仓储方法的读取结果。
 * 跑法：cd desktop && node --experimental-strip-types src/db/probe.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, resolveDbPath } from "./connection.ts";
import { AccountRepository } from "./account-repository.ts";
import { ProxyRepository } from "./proxy-repository.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..", "..");
const dbPath = resolveDbPath(projectRoot);

function line(s = "") {
  process.stdout.write(s + "\n");
}

line("=".repeat(58));
line("SQLite Node 仓储真机探针（只读）");
line("=".repeat(58));
line(`DB: ${dbPath}`);

// POC 阶段强制只读，绝不写生产库
const db = openDb(dbPath, { readonly: true });
const accounts = new AccountRepository(db);
const proxies = new ProxyRepository(db);

const result: Record<string, unknown> = {};

line("\n[1] 表清单");
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];
line(`  ${tables.length} 张表: ${tables.map((t) => t.name).join(", ")}`);
result["table_count"] = tables.length;

line("\n[2] 账号总数与状态分布");
result["account_count"] = accounts.count();
line(`  总数: ${result["account_count"]}`);
const byStatus = accounts.countByStatus();
result["by_status"] = byStatus;
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  line(`    ${k}: ${v}`);
}

line("\n[3] 前 3 条账号（核对字段读取）");
const all = accounts.getAllAccounts();
result["all_len"] = all.length;
for (const a of all.slice(0, 3)) {
  line(`    ${a.email}  status=${a.status}  login=${a.login_status}  pro=${a.is_pro}  win=${a.browser_profile_id}`);
}

line("\n[4] 按邮箱精确查");
const first = all[0];
if (first) {
  const hit = accounts.getAccountByEmail(first.email);
  result["email_hit"] = hit?.email === first.email;
  line(`  查 ${first.email} -> ${hit ? "命中" : "未命中"}`);
}

line("\n[5] 按状态筛选");
for (const st of ["subscribed", "ineligible", "verified", "error"]) {
  const rows = accounts.getAccountsByStatus(st);
  line(`    status=${st}: ${rows.length} 条`);
  result[`status_${st}`] = rows.length;
}

line("\n[6] 未绑定窗口的账号");
const unbound = accounts.getUnboundAccounts();
result["unbound"] = unbound.length;
line(`  ${unbound.length} 条`);

line("\n[7] 代理与绑定统计");
result["proxy_count"] = proxies.count();
line(`  代理总数: ${result["proxy_count"]}`);
const stats = proxies.getAllProxyUsageStats(3);
result["proxy_stats_len"] = stats.length;
for (const s of stats.slice(0, 5)) {
  line(`    #${s.proxy_id} ${s.proxy_type}://${s.host}:${s.port}  用量 ${s.used_count}/${s.max_count}${s.is_full ? " [满]" : ""}`);
}
const next = proxies.getNextAvailableProxy(3);
result["next_available_proxy"] = next?.id ?? null;
line(`  下一个可用代理: ${next ? `#${next.id}` : "无"}`);

db.close();

line("\n" + "=".repeat(58));
line("JSON 结果：");
line(JSON.stringify(result, Object.keys(result).sort()));
