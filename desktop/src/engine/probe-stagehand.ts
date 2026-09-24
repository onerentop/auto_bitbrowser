/**
 * Stagehand Node SDK 垂直切片验证（只读）
 *
 * 目的：验证 Node 版 Stagehand 能否复现切片所需的能力：
 *   CDP 接管 ixBrowser 窗口 → navigate → observe → extract
 *
 * 安全约束：绝不调用 act()，不点击任何按钮，不登出任何设备。
 *
 * 用法：node --experimental-strip-types src/engine/probe-stagehand.ts <profileId>
 */
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { IxBrowserClient } from "../ixbrowser/client.ts";

const profileId = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isFinite(profileId)) {
  console.error("用法: probe-stagehand.ts <profileId>");
  process.exit(1);
}

const MODEL = process.env["ABB_MODEL"] ?? "google/gemini-2.5-flash";
const API_KEY = process.env["ABB_API_KEY"] ?? "";
if (!API_KEY) {
  console.error("缺少 ABB_API_KEY 环境变量");
  process.exit(1);
}

const log = (s: string) => process.stdout.write(s + "\n");
const result: Record<string, unknown> = { profileId, model: MODEL };

const ix = new IxBrowserClient();
let opened = false;
let sh: InstanceType<typeof Stagehand> | null = null;

try {
  log("=".repeat(58));
  log("Stagehand Node SDK 垂直切片验证（只读）");
  log("=".repeat(58));

  log(`\n[1] 打开 ixBrowser 窗口 #${profileId}`);
  const openResult = await ix.openProfile(profileId);
  opened = true;
  log(`  ws = ${openResult.ws}`);
  result["step1_open"] = true;

  log("\n[2] Stagehand 经 CDP 接管该窗口");
  sh = new Stagehand({
    env: "LOCAL",
    localBrowserLaunchOptions: { cdpUrl: openResult.ws },
    model: { modelName: MODEL, clientOptions: { apiKey: API_KEY } },
    verbose: 0,
  } as never);
  await sh.init();
  log("  连接成功");
  result["step2_connect"] = true;

  // V3 把 act/extract/observe 提到顶层；页面对象走 context
  const ctx = (sh as unknown as { context: { awaitActivePage(ms?: number): Promise<{ goto(u: string, o?: unknown): Promise<unknown>; url(): string }> } }).context;
  const page = await ctx.awaitActivePage(15_000);

  log("\n[3] 导航到 Google 设备页");
  await page.goto("https://myaccount.google.com/device-activity", {
    waitUntil: "domcontentloaded",
  });
  await new Promise((r) => setTimeout(r, 4000));
  const url = page.url();
  log(`  当前 URL = ${url}`);
  result["step3_url"] = url;
  result["step3_logged_in"] = !url.includes("accounts.google.com/signin");

  log("\n[4] observe 识别页面元素");
  const observed = await sh.observe("页面上所有已登录设备的条目");
  const observedList = Array.isArray(observed) ? observed : [];
  log(`  识别到 ${observedList.length} 个候选元素`);
  for (const o of observedList.slice(0, 5)) {
    log(`    - ${JSON.stringify(o).slice(0, 140)}`);
  }
  result["step4_observe_count"] = observedList.length;

  log("\n[5] extract 结构化抽取设备列表");
  const extracted = (await (sh as unknown as {
    extract(i: string, s: unknown): Promise<unknown>;
  }).extract(
    "提取页面上所有设备的名称",
    z.object({ devices: z.array(z.object({ name: z.string() })) }),
  )) as { devices?: { name: string }[] };
  const devices = extracted?.devices ?? [];
  log(`  抽取到 ${devices.length} 台设备`);
  for (const d of devices.slice(0, 8)) log(`    - ${d.name}`);
  result["step5_device_count"] = devices.length;
  result["step5_devices"] = devices.slice(0, 8).map((d) => d.name);

  result["success"] = true;
  log("\n" + "=".repeat(58));
  log("切片验证通过：CDP 连接 / navigate / observe / extract 全部可用");
} catch (err) {
  result["success"] = false;
  result["error"] = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log(`\n[FAIL] ${result["error"]}`);
  if (err instanceof Error && err.stack) log(err.stack.split("\n").slice(0, 5).join("\n"));
} finally {
  try { if (sh) await sh.close(); } catch { /* ignore */ }
  try {
    if (opened) { await ix.closeProfile(profileId); log("\n已关闭 ixBrowser 窗口"); }
  } catch { /* ignore */ }
  log("\nJSON: " + JSON.stringify(result));
}