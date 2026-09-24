/**
 * 真机探针：直连本地 ixBrowser :53200，校验客户端解析结果与本地服务返回一致。
 * 只做只读调用（profile-list / group-list），不打开也不创建窗口。
 *
 * 跑法：在仓库根执行 pnpm run probe:ix
 */
import { IxBrowserClient, IxResponseError } from "./client.ts";

const client = new IxBrowserClient();

function line(s = "") {
  process.stdout.write(s + "\n");
}

const result: Record<string, unknown> = {};

line("=".repeat(58));
line("ixBrowser Node 客户端真机探针");
line("=".repeat(58));

// 1. 分页拉取第一页
line("\n[1] profile-list 第 1 页（limit=5）");
const page1 = await client.getProfileList({ page: 1, limit: 5 });
result["total"] = client.total;
result["page1_count"] = page1.length;
line(`  总窗口数: ${client.total}`);
line(`  本页返回: ${page1.length}`);
for (const p of page1) {
  line(`    #${p.profile_id}  ${p.name}  分组=${p.group_name}  代理=${p.proxy_type}://${p.proxy_ip}:${p.proxy_port}`);
}

// 2. 字段类型校验（调研里标注的陷阱）
line("\n[2] 字段类型校验");
const sample = page1[0];
if (sample) {
  const checks: [string, boolean, string][] = [
    ["profile_id 是 number", typeof sample.profile_id === "number", typeof sample.profile_id],
    ["proxy_port 是 string", typeof sample.proxy_port === "string", typeof sample.proxy_port],
    ["group_id 是 number", typeof sample.group_id === "number", typeof sample.group_id],
    ["last_open_time 是 number", typeof sample.last_open_time === "number", typeof sample.last_open_time],
  ];
  for (const [label, ok, actual] of checks) {
    line(`  ${ok ? "[OK]  " : "[FAIL]"} ${label}（实际 ${actual}）`);
  }
  result["sample_profile_id"] = sample.profile_id;
} else {
  line("  (无数据可校验)");
}

// 3. 按 ID 精确查
if (sample) {
  line("\n[3] 按 profile_id 精确查");
  const one = await client.getProfileById(sample.profile_id);
  line(`  查 #${sample.profile_id} -> ${one ? `命中 ${one.name}` : "未命中"}`);
  result["exact_hit"] = one?.profile_id === sample.profile_id;
}

// 4. 查一个不存在的 ID（调研结论：不报错，返回空列表）
line("\n[4] 查不存在的窗口（预期：不报错，返回空）");
const none = await client.getProfileList({ profileId: 999999999 });
line(`  返回 ${none.length} 条，total=${client.total}`);
result["nonexistent_returns_empty"] = none.length === 0;

// 5. 关闭不存在的窗口（调研结论：抛 code=2007）
line("\n[5] 关闭不存在的窗口（预期：code=2007）");
try {
  await client.closeProfile(999999999);
  line("  [FAIL] 预期抛错但没有");
  result["close_2007"] = false;
} catch (err) {
  if (err instanceof IxResponseError) {
    line(`  [OK]   捕获 IxResponseError code=${err.code} message=${err.message}`);
    result["close_2007"] = err.code === 2007;
  } else {
    line(`  [FAIL] 抛了非预期错误: ${err}`);
    result["close_2007"] = false;
  }
}

// 6. 分组列表
line("\n[6] group-list");
try {
  const groups = await client.getGroupList(1, 100);
  line(`  返回 ${groups.length} 个分组`);
  result["group_count"] = groups.length;
} catch (err) {
  line(`  调用失败: ${err instanceof Error ? err.message : String(err)}`);
  result["group_count"] = null;
}

// 7. 全量分页遍历，验证分页逻辑
line("\n[7] 全量分页遍历（limit=100）");
let all = 0;
let page = 1;
for (;;) {
  const batch = await client.getProfileList({ page, limit: 100 });
  all += batch.length;
  if (batch.length === 0 || all >= client.total) break;
  page += 1;
  if (page > 50) break; // 安全阀
}
line(`  遍历 ${page} 页，累计 ${all} 个窗口（服务端 total=${client.total}）`);
result["paged_total"] = all;

line("\n" + "=".repeat(58));
line("JSON 结果：");
line(JSON.stringify(result));
