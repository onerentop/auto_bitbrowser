/**
 * automation/batch/types.ts + automation/batch/pro-detection.ts 单测（全离线）
 *
 * pro-detection 全程用实现了 ProDetectPage 的假页面驱动：
 * 不开浏览器、不连 CDP、不访问网络。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addFailed,
  addSkipped,
  addSuccess,
  batchDurationSeconds,
  batchResultToDict,
  batchSuccessRate,
  calculateFamilySlots,
  createAccountMembershipRefreshResult,
  createBatchResult,
  formatPercent1,
  membershipFromProStatus,
  membershipResultToDict,
} from "../src/automation/batch/types.ts";
import {
  CDP_NON_PRO_KEYWORDS,
  CDP_PRO_KEYWORDS,
  checkFamilyStatus,
  checkGoogleOneProStatus,
  checkProStatusViaCdp,
  getFamilyMemberCount,
} from "../src/automation/batch/pro-detection.ts";

// ==================== 假页面 / 假 CDP ====================

/** 实现 ProDetectPage 的假页面：不做任何真实 IO */
function fakeProPage(opts = {}) {
  const calls = { goto: [], waits: [], selectors: [], innerText: 0 };
  return {
    calls,
    url: () => opts.url ?? "https://myaccount.google.com/family",
    title: async () => "",
    goto: async (url, options) => {
      calls.goto.push({ url, options });
      if (opts.gotoThrows) throw new Error("goto boom");
      return null;
    },
    evaluate: async () => null,
    click: async () => {},
    fill: async () => {},
    screenshot: async () => new Uint8Array(),
    innerText: async () => {
      calls.innerText += 1;
      if (opts.innerTextThrows) throw new Error("innerText boom");
      return opts.text ?? "";
    },
    goBack: async () => null,
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: {},
    keyboard: {},
    context: () => null,
    waitForTimeout: async (t) => {
      calls.waits.push(t);
    },
    querySelectorAll: async (selector) => {
      calls.selectors.push(selector);
      if (opts.selectorThrows) throw new Error("selector boom");
      return opts.selectorHits?.[selector] ?? [];
    },
  };
}

/** 假 CDP 服务工厂（对应 Python 的 create_cdp_service） */
function fakeCdp(names, opts = {}) {
  const state = { created: 0, closed: 0 };
  const factory = async () => {
    state.created += 1;
    if (opts.factoryThrows) throw new Error("cdp connect boom");
    return {
      async getInteractiveElementsViaAx() {
        if (opts.axThrows) throw new Error("ax boom");
        return names.map((n) => ({ name: n }));
      },
      async close() {
        state.closed += 1;
      },
    };
  };
  return { factory, state };
}

/** 只实现 updateFamilyMemberCount 的假仓储 */
function fakeRepo() {
  const calls = [];
  return {
    calls,
    updateFamilyMemberCount(email, count) {
      calls.push({ email, count });
      return true;
    },
  };
}

const silent = () => {};

// ==================== BatchResult ====================

test("createBatchResult: 默认字段", () => {
  const r = createBatchResult({ total: 5 });
  assert.deepEqual(r, {
    total: 5,
    success_count: 0,
    failed_count: 0,
    skipped_count: 0,
    results: [],
    start_time: null,
    end_time: null,
  });
});

test("addSuccess / addFailed / addSkipped: 计数与结果条目形状", () => {
  const r = createBatchResult({ total: 3 });
  addSuccess(r, "a@x.com", { browser_id: "1" });
  addFailed(r, "b@x.com", "登录失败", "no_api_key");
  addSkipped(r, "c@x.com", "用户停止");

  assert.equal(r.success_count, 1);
  assert.equal(r.failed_count, 1);
  assert.equal(r.skipped_count, 1);
  assert.deepEqual(r.results[0], { email: "a@x.com", status: "success", data: { browser_id: "1" } });
  assert.deepEqual(r.results[1], {
    email: "b@x.com",
    status: "failed",
    error: "登录失败",
    error_type: "no_api_key",
  });
  assert.deepEqual(r.results[2], { email: "c@x.com", status: "skipped", reason: "用户停止" });

  // 不传 data 时补空对象；不传 errorType 时补 null
  const r2 = createBatchResult({ total: 1 });
  addSuccess(r2, "d@x.com");
  addFailed(r2, "e@x.com", "err");
  assert.deepEqual(r2.results[0].data, {});
  assert.equal(r2.results[1].error_type, null);
});

test("batchSuccessRate: 分母是 success+failed，不含 skipped", () => {
  const r = createBatchResult({ total: 10 });
  r.success_count = 2;
  r.failed_count = 1;
  r.skipped_count = 7;
  assert.equal(batchSuccessRate(r), 2 / 3);
});

test("batchSuccessRate: 全部 skipped 时分母为 0，返回 0", () => {
  const r = createBatchResult({ total: 4 });
  r.skipped_count = 4;
  assert.equal(batchSuccessRate(r), 0);
});

test("batchDurationSeconds: 有起止时间取差值（秒），缺一个则 0", () => {
  const r = createBatchResult({ total: 1 });
  assert.equal(batchDurationSeconds(r), 0);
  r.start_time = 1_000_000;
  assert.equal(batchDurationSeconds(r), 0);
  r.end_time = 1_002_500;
  assert.equal(batchDurationSeconds(r), 2.5);
});

test("formatPercent1: 常规值与 Python f\"{x:.1%}\" 一致", () => {
  assert.equal(formatPercent1(0), "0.0%");
  assert.equal(formatPercent1(1), "100.0%");
  assert.equal(formatPercent1(0.5), "50.0%");
  assert.equal(formatPercent1(2 / 3), "66.7%");
  assert.equal(formatPercent1(1 / 3), "33.3%");
});

test("formatPercent1: .5 边界按银行家舍入（取偶），与 Python 一致", () => {
  // 0.0625 * 100 = 6.25 → 62|5 → 62 是偶数 → 6.2
  assert.equal(formatPercent1(0.0625), "6.2%");
  // 0.1875 * 100 = 18.75 → 187|5 → 187 是奇数 → 进位到 188 → 18.8
  assert.equal(formatPercent1(0.1875), "18.8%");
  // 0.3125 * 100 = 31.25 → 312|5 → 312 是偶数 → 31.2
  assert.equal(formatPercent1(0.3125), "31.2%");
});

test("batchResultToDict: 字段齐全且 success_rate 是百分比字符串", () => {
  const r = createBatchResult({ total: 3 });
  addSuccess(r, "a@x.com");
  addSuccess(r, "b@x.com");
  addFailed(r, "c@x.com", "boom");
  addSkipped(r, "d@x.com", "跳过");
  r.start_time = 0;
  r.end_time = 3000;

  const dict = batchResultToDict(r);
  assert.deepEqual(Object.keys(dict), [
    "total",
    "success_count",
    "failed_count",
    "skipped_count",
    "success_rate",
    "duration_seconds",
    "results",
  ]);
  assert.equal(dict.total, 3);
  assert.equal(dict.success_count, 2);
  assert.equal(dict.failed_count, 1);
  assert.equal(dict.skipped_count, 1);
  assert.equal(typeof dict.success_rate, "string");
  assert.equal(dict.success_rate, "66.7%");
  assert.equal(dict.duration_seconds, 3);
  assert.equal(dict.results.length, 4);
});

// ==================== AccountMembershipRefreshResult ====================

test("createAccountMembershipRefreshResult: 默认值（family_slots_left = -1）", () => {
  const r = createAccountMembershipRefreshResult({ email: "a@x.com" });
  assert.equal(r.is_pro, "unknown");
  assert.equal(r.membership_type, "unknown");
  assert.equal(r.family_role, "unknown");
  assert.equal(r.has_family_group, "unknown");
  assert.equal(r.family_member_count, 0);
  assert.equal(r.family_slots_left, -1);
  assert.equal(r.success, false);
});

test("membershipFromProStatus: yes → regular/manager 且 success=true", () => {
  const r = membershipFromProStatus("a@x.com", "yes");
  assert.equal(r.membership_type, "regular");
  assert.equal(r.family_role, "manager");
  assert.equal(r.success, true);
});

test("membershipFromProStatus: family_yes → family/member 且 success=true", () => {
  const r = membershipFromProStatus("a@x.com", "family_yes");
  assert.equal(r.membership_type, "family");
  assert.equal(r.family_role, "member");
  assert.equal(r.success, true);
});

test("membershipFromProStatus: no → none/none 且 success=true", () => {
  const r = membershipFromProStatus("a@x.com", "no");
  assert.equal(r.membership_type, "none");
  assert.equal(r.family_role, "none");
  assert.equal(r.success, true);
});

test("membershipFromProStatus: 其它值 → unknown/unknown 且 success=false", () => {
  const r = membershipFromProStatus("a@x.com", "detection_failed");
  assert.equal(r.is_pro, "detection_failed");
  assert.equal(r.membership_type, "unknown");
  assert.equal(r.family_role, "unknown");
  assert.equal(r.success, false);
});

test("calculateFamilySlots: 普通 Pro 管理员按 6 - max(count,1) 计算", () => {
  const r = membershipFromProStatus("a@x.com", "yes");
  r.family_member_count = 3;
  calculateFamilySlots(r);
  assert.equal(r.family_slots_left, 3);

  r.family_member_count = 6;
  calculateFamilySlots(r);
  assert.equal(r.family_slots_left, 0);

  // 超过 6 人时被 max(0, ...) 夹住
  r.family_member_count = 9;
  calculateFamilySlots(r);
  assert.equal(r.family_slots_left, 0);
});

test("calculateFamilySlots: 成员数为 0 时按 max(count,1) 兜底成 1（剩 5 位）", () => {
  const r = membershipFromProStatus("a@x.com", "yes");
  r.family_member_count = 0;
  calculateFamilySlots(r);
  assert.equal(r.family_slots_left, 5);
});

test("calculateFamilySlots: family_yes 与其它情况一律 -1", () => {
  const fam = membershipFromProStatus("a@x.com", "family_yes");
  fam.family_member_count = 4;
  calculateFamilySlots(fam);
  assert.equal(fam.family_slots_left, -1);

  const none = membershipFromProStatus("a@x.com", "no");
  calculateFamilySlots(none);
  assert.equal(none.family_slots_left, -1);

  // is_pro=yes 但角色不是 manager 也走 -1
  const memberRole = membershipFromProStatus("a@x.com", "yes");
  memberRole.family_role = "member";
  memberRole.family_member_count = 2;
  calculateFamilySlots(memberRole);
  assert.equal(memberRole.family_slots_left, -1);
});

test("membershipResultToDict: 12 个字段全量输出", () => {
  const r = membershipFromProStatus("a@x.com", "yes");
  const dict = membershipResultToDict(r);
  assert.deepEqual(Object.keys(dict), [
    "email",
    "is_pro",
    "membership_type",
    "pro_plan_name",
    "family_role",
    "has_family_group",
    "family_manager_email",
    "family_member_count",
    "family_slots_left",
    "account_country",
    "error_message",
    "success",
  ]);
  assert.equal(dict.email, "a@x.com");
  assert.equal(dict.is_pro, "yes");
});

// ==================== checkProStatusViaCdp ====================

test("checkProStatusViaCdp: 未注入 CDP 工厂时返回 null 并打日志", async () => {
  const logs = [];
  const result = await checkProStatusViaCdp(fakeProPage(), "a@x.com", (m) => logs.push(m));
  assert.equal(result, null);
  assert.ok(logs.some((m) => m.includes("CDP 服务不可用")));
});

test("checkProStatusViaCdp: 命中非会员关键词返回 'no'（优先于 Pro 关键词）", async () => {
  const cdp = fakeCdp(["Manage membership", "Upgrade storage"]);
  const result = await checkProStatusViaCdp(fakeProPage(), "a@x.com", silent, {
    createCdpService: cdp.factory,
  });
  assert.equal(result, "no", "非会员标识必须先于 Pro 标识判定");
  assert.equal(cdp.state.closed, 1, "CDP 服务被关闭");
});

test("checkProStatusViaCdp: 只有 Pro 关键词时返回 'pro'", async () => {
  const cdp = fakeCdp(["Your membership", "下次付款 2026-01-01"]);
  const result = await checkProStatusViaCdp(fakeProPage(), "a@x.com", silent, {
    createCdpService: cdp.factory,
  });
  assert.equal(result, "pro");
});

test("checkProStatusViaCdp: 无任何关键词命中返回 null，且仍关闭 CDP", async () => {
  const cdp = fakeCdp(["随便一个按钮", null]);
  const result = await checkProStatusViaCdp(fakeProPage(), "a@x.com", silent, {
    createCdpService: cdp.factory,
  });
  assert.equal(result, null);
  assert.equal(cdp.state.closed, 1);
});

test("checkProStatusViaCdp: CDP 异常被吞掉并返回 null", async () => {
  const cdp = fakeCdp([], { factoryThrows: true });
  const logs = [];
  const result = await checkProStatusViaCdp(fakeProPage(), "a@x.com", (m) => logs.push(m), {
    createCdpService: cdp.factory,
  });
  assert.equal(result, null);
  assert.ok(logs.some((m) => m.includes("CDP 检测异常")));
});

test("CDP 关键词表与 Python 逐字一致（抽样）", () => {
  assert.ok(CDP_NON_PRO_KEYWORDS.includes("upgrade"));
  assert.ok(CDP_NON_PRO_KEYWORDS.includes("choose a plan"));
  assert.ok(CDP_PRO_KEYWORDS.includes("manage membership"));
  assert.ok(CDP_PRO_KEYWORDS.includes("renews on"));
});

// ==================== checkFamilyStatus ====================

test("checkFamilyStatus: CDP 命中成员标识 → family_yes（不查成员数）", async () => {
  const cdp = fakeCdp(["Leave family group"]);
  const repo = fakeRepo();
  const page = fakeProPage({ text: "" });
  const result = await checkFamilyStatus(page, "a@x.com", silent, {
    createCdpService: cdp.factory,
    accountRepo: repo,
  });
  assert.equal(result, "family_yes");
  assert.deepEqual(repo.calls, []);
  assert.equal(page.calls.goto[0].url, "https://myaccount.google.com/family");
});

test("checkFamilyStatus: CDP 命中管理员标识 → yes 且写回成员数", async () => {
  const cdp = fakeCdp(["Manage family group"]);
  const repo = fakeRepo();
  const page = fakeProPage({ text: "3 family members" });
  const result = await checkFamilyStatus(page, "a@x.com", silent, {
    createCdpService: cdp.factory,
    accountRepo: repo,
  });
  assert.equal(result, "yes");
  assert.deepEqual(repo.calls, [{ email: "a@x.com", count: 3 }]);
});

test("checkFamilyStatus: Playwright 兜底命中成员标识 → family_yes", async () => {
  const page = fakeProPage({ text: "您已加入家庭群组，可随时退出家庭群组" });
  const result = await checkFamilyStatus(page, "a@x.com", silent);
  assert.equal(result, "family_yes");
});

test("checkFamilyStatus: Playwright 兜底命中管理员标识 → yes 且写回成员数", async () => {
  const repo = fakeRepo();
  const page = fakeProPage({ text: "管理家庭群组\n4 位家庭成员" });
  const result = await checkFamilyStatus(page, "a@x.com", silent, { accountRepo: repo });
  assert.equal(result, "yes");
  assert.deepEqual(repo.calls, [{ email: "a@x.com", count: 4 }]);
});

test("checkFamilyStatus: 无任何标识时默认 yes", async () => {
  const logs = [];
  const page = fakeProPage({ text: "一个完全无关的页面" });
  const result = await checkFamilyStatus(page, "a@x.com", (m) => logs.push(m));
  assert.equal(result, "yes");
  assert.ok(logs.some((m) => m.includes("未检测到明确的家庭组状态")));
});

test("checkFamilyStatus: 导航异常时兜底返回 yes", async () => {
  const page = fakeProPage({ gotoThrows: true });
  assert.equal(await checkFamilyStatus(page, "a@x.com", silent), "yes");
});

test("checkFamilyStatus: CDP 抛异常时回退 Playwright 分支", async () => {
  const cdp = fakeCdp([], { axThrows: true });
  const logs = [];
  const page = fakeProPage({ text: "退出家庭群组" });
  const result = await checkFamilyStatus(page, "a@x.com", (m) => logs.push(m), {
    createCdpService: cdp.factory,
  });
  assert.equal(result, "family_yes");
  assert.ok(logs.some((m) => m.includes("回退到 Playwright")));
});

// ==================== checkGoogleOneProStatus ====================

test("checkGoogleOneProStatus: 命中非会员标识 → no（先于 Pro 标识）", async () => {
  const page = fakeProPage({ text: "Upgrade\nManage membership" });
  const result = await checkGoogleOneProStatus(page, "a@x.com", silent);
  assert.equal(result, "no");
  assert.equal(page.calls.goto[0].url, "https://one.google.com");
});

test("checkGoogleOneProStatus: 命中 Pro 标识后转入家庭组检测", async () => {
  const page = fakeProPage({ text: "Manage membership\n下次付款" });
  const result = await checkGoogleOneProStatus(page, "a@x.com", silent);
  // 家庭组页面文本相同（假页面统一返回），无家庭标识 → 默认普通 Pro
  assert.equal(result, "yes");
  assert.equal(page.calls.goto.length >= 2, true, "先 one.google.com 再 family 页");
});

test("checkGoogleOneProStatus: 无任何标识 → null", async () => {
  const logs = [];
  const page = fakeProPage({ text: "空空如也" });
  const result = await checkGoogleOneProStatus(page, "a@x.com", (m) => logs.push(m));
  assert.equal(result, null);
  assert.ok(logs.some((m) => m.includes("未检测到明确的会员/非会员标识")));
});

test("checkGoogleOneProStatus: CDP 判定为 no 时直接返回 no，不做文本分析", async () => {
  const cdp = fakeCdp(["Get started"]);
  const page = fakeProPage({ text: "Manage membership" });
  const result = await checkGoogleOneProStatus(page, "a@x.com", silent, {
    createCdpService: cdp.factory,
  });
  assert.equal(result, "no");
  assert.equal(page.calls.innerText, 0, "走 CDP 分支就不读页面文本");
});

test("checkGoogleOneProStatus: 页面异常 → null", async () => {
  const page = fakeProPage({ gotoThrows: true });
  assert.equal(await checkGoogleOneProStatus(page, "a@x.com", silent), null);
});

// ==================== getFamilyMemberCount ====================

test("getFamilyMemberCount: 选择器命中且数量在 1-6 内直接返回", async () => {
  const page = fakeProPage({ selectorHits: { "[data-member-email]": [1, 2, 3] } });
  assert.equal(await getFamilyMemberCount(page, "a@x.com", silent), 3);
  assert.equal(page.calls.goto.length, 0, "已在家庭页则不再导航");
});

test("getFamilyMemberCount: 选择器数量超范围时继续往下走文本解析", async () => {
  const page = fakeProPage({
    selectorHits: { "[role='listitem']": new Array(20).fill(0) },
    text: "5 位成员",
  });
  assert.equal(await getFamilyMemberCount(page, "a@x.com", silent), 5);
});

test("getFamilyMemberCount: 中文正则解析（X 位家庭成员 / 家庭群组(X) / X 人）", async () => {
  assert.equal(await getFamilyMemberCount(fakeProPage({ text: "共 3 位家庭成员" }), "a", silent), 3);
  assert.equal(await getFamilyMemberCount(fakeProPage({ text: "家庭群组 (4)" }), "a", silent), 4);
  assert.equal(await getFamilyMemberCount(fakeProPage({ text: "当前 2 人" }), "a", silent), 2);
});

test("getFamilyMemberCount: 英文正则解析（X members / Family group(X) / X people）", async () => {
  assert.equal(await getFamilyMemberCount(fakeProPage({ text: "3 family members" }), "a", silent), 3);
  assert.equal(await getFamilyMemberCount(fakeProPage({ text: "6 members" }), "a", silent), 6);
  assert.equal(await getFamilyMemberCount(fakeProPage({ text: "Family group (2)" }), "a", silent), 2);
  assert.equal(await getFamilyMemberCount(fakeProPage({ text: "5 people" }), "a", silent), 5);
});

test("getFamilyMemberCount: 邮箱计数兜底，过滤 support/help", async () => {
  const page = fakeProPage({
    text: "alice@example.com bob@example.com support@google.com help@google.com alice@example.com",
  });
  assert.equal(await getFamilyMemberCount(page, "a@x.com", silent), 2);
});

test("getFamilyMemberCount: 什么都没识别到时默认返回 1", async () => {
  const logs = [];
  const page = fakeProPage({ text: "没有任何可用线索" });
  assert.equal(await getFamilyMemberCount(page, "a@x.com", (m) => logs.push(m)), 1);
  assert.ok(logs.some((m) => m.includes("默认为 1（管理员自己）")));
});

test("getFamilyMemberCount: 不在家庭页时先导航", async () => {
  const page = fakeProPage({ url: "https://one.google.com", text: "3 members" });
  assert.equal(await getFamilyMemberCount(page, "a@x.com", silent), 3);
  assert.equal(page.calls.goto.length, 1);
  assert.equal(page.calls.goto[0].url, "https://myaccount.google.com/family");
  assert.deepEqual(page.calls.waits, [2000]);
});

test("getFamilyMemberCount: 异常时返回 0", async () => {
  const page = fakeProPage({ innerTextThrows: true });
  assert.equal(await getFamilyMemberCount(page, "a@x.com", silent), 0);
});

test("getFamilyMemberCount: 选择器抛异常不中断，继续下一个选择器", async () => {
  const page = fakeProPage({ selectorThrows: true, text: "4 members" });
  assert.equal(await getFamilyMemberCount(page, "a@x.com", silent), 4);
});
