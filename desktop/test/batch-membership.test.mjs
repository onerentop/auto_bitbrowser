/**
 * automation/batch/membership-detect.ts 单测（全离线）
 *
 * 用实现了 MembershipDetectEngine 的假引擎驱动：navigate / extract / getPageContent /
 * getCurrentUrl 全部是预置返回值，**不调用任何 LLM、不开浏览器、不访问网络**。
 * sleep 注入成只记录秒数的假实现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_COUNTRY_EXTRACT_INSTRUCTION,
  ACCOUNT_COUNTRY_EXTRACT_SCHEMA,
  FAMILY_MANAGER_EMAIL_EXTRACT_INSTRUCTION,
  HAS_FAMILY_INDICATORS,
  NO_FAMILY_INDICATORS,
  createAccountCountryExtractModel,
  createFamilyInfoExtractModel,
  detectFamilyDetailsViaBrowserUse,
  extractAccountCountryViaBrowserUse,
} from "../src/automation/batch/membership-detect.ts";

// ==================== 替身 ====================

/**
 * 假引擎（MembershipDetectEngine 的最小实现）。
 * urls：getCurrentUrl 的返回序列（用尽后停在最后一个）
 * navResults / extractResults：按调用顺序出队，用尽后走默认值
 */
function fakeEngine(opts = {}) {
  const calls = { navigate: [], extract: [], content: 0, url: 0 };
  const urls = [...(opts.urls ?? [opts.url ?? "https://myaccount.google.com/family/details"])];
  const navResults = [...(opts.navResults ?? [])];
  const extractResults = [...(opts.extractResults ?? [])];

  return {
    calls,
    async navigate(url, options) {
      calls.navigate.push({ url, options });
      return navResults.length > 0 ? navResults.shift() : { success: true };
    },
    async extract(instruction, schema, options) {
      calls.extract.push({ instruction, schema, options });
      if (extractResults.length > 0) return extractResults.shift();
      return opts.extractResult ?? { success: false, error: "AI 未启用" };
    },
    async getPageContent() {
      calls.content += 1;
      if (opts.contentThrows) throw new Error("页面文本不可用");
      return opts.content ?? "";
    },
    async getCurrentUrl() {
      calls.url += 1;
      if (opts.urlThrows) throw new Error("Page 未初始化");
      return urls.length > 1 ? urls.shift() : urls[0];
    },
  };
}

/** 被就地修改的结果对象（AccountMembershipRefreshResult 的可变字段子集） */
function emptyResult(overrides = {}) {
  return {
    is_pro: "unknown",
    has_family_group: "unknown",
    family_role: "unknown",
    family_member_count: 0,
    family_manager_email: "",
    account_country: "",
    ...overrides,
  };
}

/** 假 sleep：只记录秒数 */
function fakeSleep() {
  const calls = [];
  return { calls, fn: async (s) => void calls.push(s) };
}

const silentOpts = () => ({ log: () => {}, sleep: async () => {} });

// ==================== 提取模型 ====================

test("createFamilyInfoExtractModel / createAccountCountryExtractModel: 默认值照搬 pydantic", () => {
  assert.deepEqual(createFamilyInfoExtractModel(), {
    has_family_group: "unknown",
    family_role: "unknown",
    family_member_count: 0,
    family_manager_email: "",
  });
  assert.deepEqual(createAccountCountryExtractModel(), { account_country: "unknown" });
  assert.equal(createFamilyInfoExtractModel({ family_role: "manager" }).family_role, "manager");
});

test("关键词表包含中英文双语标识", () => {
  assert.ok(HAS_FAMILY_INDICATORS.includes("your family group"));
  assert.ok(HAS_FAMILY_INDICATORS.includes("退出家庭群组"));
  assert.ok(NO_FAMILY_INDICATORS.includes("create a family group"));
  assert.ok(NO_FAMILY_INDICATORS.includes("创建家庭群组"));
});

// ==================== detectFamilyDetailsViaBrowserUse ====================

test("家庭组检测: 导航失败时直接返回，不改动结果", async () => {
  const engine = fakeEngine({ navResults: [{ success: false, error: "超时" }] });
  const result = emptyResult();
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });

  assert.equal(result.has_family_group, "unknown");
  assert.equal(engine.calls.content, 0);
  assert.ok(logs.some((m) => m.includes("导航家庭组页面失败")));
});

test("家庭组检测: 落到 chrome-error 页面时跳过", async () => {
  const engine = fakeEngine({ url: "chrome-error://chromewebdata/", content: "Your family group" });
  const result = emptyResult();
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.has_family_group, "unknown");
  assert.equal(engine.calls.content, 0);
});

test("家庭组检测: getCurrentUrl 抛错 → Page 对象不可用，提前返回", async () => {
  const engine = fakeEngine({ urlThrows: true });
  const result = emptyResult();
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.ok(logs.some((m) => m.includes("Page 对象不可用")));
  assert.equal(engine.calls.content, 0);
});

test("家庭组检测: 获取页面文本失败时提前返回", async () => {
  const engine = fakeEngine({ contentThrows: true });
  const result = emptyResult();
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.ok(logs.some((m) => m.includes("获取页面文本失败")));
  assert.equal(result.has_family_group, "unknown");
});

test("家庭组检测: 命中无家庭组标识 → has=no / role=none 且提前结束", async () => {
  const engine = fakeEngine({ content: "You can create a family group to share with up to 5 people" });
  const result = emptyResult({ is_pro: "no" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());

  assert.equal(result.has_family_group, "no");
  assert.equal(result.family_role, "none");
  assert.equal(result.family_member_count, 0, "提前 return，不会走到成员数兜底");
  assert.equal(engine.calls.extract.length, 0, "不调用 AI");
});

test("家庭组检测: 命中有家庭组标识 → has=yes", async () => {
  const engine = fakeEngine({ content: "Your family group\nmanager@example.com\nme@x.com" });
  const result = emptyResult({ is_pro: "yes" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.has_family_group, "yes");
});

test("家庭组检测: 既无有家庭组标识也无无家庭组标识 → unknown", async () => {
  const engine = fakeEngine({ content: "一段与家庭组无关的文本" });
  const result = emptyResult({ is_pro: "yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.has_family_group, "unknown");
  assert.ok(logs.some((m) => m.includes("无法从页面文本判断家庭组状态")));
});

test("家庭组检测: is_pro=family_yes 时角色一开始就固定为 member", async () => {
  const engine = fakeEngine({ content: "Delete family group" }); // 只有管理员才有的按钮
  const result = emptyResult({ is_pro: "family_yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });

  assert.equal(result.family_role, "member", "family_yes 的角色不被页面文本覆盖");
  assert.ok(logs.some((m) => m.includes("角色固定为 member")));
  assert.ok(logs.some((m) => m.includes("忽略页面文本检测到的: manager")));
});

test("家庭组检测: 方法1 —— 'Leave family' 按钮 → role=member", async () => {
  const engine = fakeEngine({ content: "Your family group\nLeave family group" });
  const result = emptyResult({ is_pro: "yes" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.family_role, "member");
  assert.equal(result.has_family_group, "yes");
});

test("家庭组检测: 方法1 中文 —— '退出家庭群组' → role=member", async () => {
  const engine = fakeEngine({ content: "你的家庭群组\n退出家庭群组" });
  const result = emptyResult({ is_pro: "yes" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.family_role, "member");
});

test("家庭组检测: 方法2 —— \"X's Family Group\" 提取管理员名 → role=member", async () => {
  const engine = fakeEngine({ content: "Bruna's Family Group" });
  const result = emptyResult({ is_pro: "yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.family_role, "member");
  assert.ok(logs.some((m) => m.includes("检测到管理员名: 'Bruna'")));
});

test("家庭组检测: 方法3 —— 邮箱上下文出现 'Family manager' → role=manager", async () => {
  const engine = fakeEngine({ content: "Your family group\nme@x.com  Family manager" });
  const result = emptyResult({ is_pro: "yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.family_role, "manager");
  assert.ok(logs.some((m) => m.includes("邮箱上下文检测到 'Family manager'")));
});

test("家庭组检测: 方法4 —— 管理员专属按钮 → role=manager", async () => {
  const engine = fakeEngine({ content: "Your family group\nInvite family members" });
  const result = emptyResult({ is_pro: "yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.family_role, "manager");
  assert.ok(logs.some((m) => m.includes("管理员专属按钮")));
});

test("家庭组检测: 成员数正则（X members / X 位成员 / 家庭群组(X)）", async () => {
  for (const [text, expected] of [
    ["Your family group\n4 members", 4],
    ["你的家庭群组\n3 位成员", 3],
    ["你的家庭群组\n家庭群组 (5)", 5],
  ]) {
    const result = emptyResult({ is_pro: "yes" });
    await detectFamilyDetailsViaBrowserUse(
      fakeEngine({ content: text }),
      "me@x.com",
      result,
      silentOpts(),
    );
    assert.equal(result.family_member_count, expected, text);
  }
});

test("家庭组检测: 成员数超出 1-6 时不采用，回落邮箱计数", async () => {
  const engine = fakeEngine({ content: "Your family group\n99 members\nboss@example.com me@x.com" });
  const result = emptyResult({ is_pro: "yes" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.family_member_count, 2);
});

test("家庭组检测: 邮箱计数过滤 support/help/noreply/@google.com", async () => {
  const engine = fakeEngine({
    content:
      "Your family group\nboss@example.com\nkid@example.com\nsupport@foo.com\nnoreply@foo.com\nhelp@foo.com\nsomeone@google.com",
  });
  const result = emptyResult({ is_pro: "yes" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.family_member_count, 2);
});

test("家庭组检测: 有家庭组但页面只有 1 个邮箱 → 按至少 2 人算", async () => {
  const engine = fakeEngine({ content: "Your family group\nme@x.com" });
  const result = emptyResult({ is_pro: "family_yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.family_member_count, 2);
  assert.ok(logs.some((m) => m.includes("通过邮箱计数提取成员数: 2")));
});

test("家庭组检测: 完全提取不到成员数且 has=yes 时默认 2", async () => {
  const engine = fakeEngine({ content: "Your family group" });
  const result = emptyResult({ is_pro: "yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.family_member_count, 2);
  assert.ok(logs.some((m) => m.includes("默认成员数: 2")));
});

test("家庭组检测: 从页面文本提取管理员邮箱（排除当前用户），不再调 AI", async () => {
  const engine = fakeEngine({ content: "Your family group\nboss@example.com\nme@x.com" });
  const result = emptyResult({ is_pro: "family_yes" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.family_manager_email, "boss@example.com");
  assert.equal(engine.calls.extract.length, 0, "页面文本已拿到邮箱就不走 AI");
});

test("家庭组检测: 管理员邮箱缺失且 has=yes 时用 AI 补充（返回结构化 JSON）", async () => {
  const engine = fakeEngine({
    content: "Your family group",
    extractResults: [{ success: true, data: { family_manager_email: "boss@example.com" } }],
  });
  const result = emptyResult({ is_pro: "family_yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });

  assert.equal(result.family_manager_email, "boss@example.com");
  assert.equal(engine.calls.extract.length, 1);
  assert.equal(engine.calls.extract[0].instruction, FAMILY_MANAGER_EMAIL_EXTRACT_INSTRUCTION);
  assert.deepEqual(engine.calls.extract[0].options, { timeoutMs: 30000, maxSteps: 6 });
  assert.ok(logs.some((m) => m.includes("AI 提取管理员邮箱成功")));
});

test("家庭组检测: AI 返回 {content:'...'} 包装格式时能解出邮箱", async () => {
  const engine = fakeEngine({
    content: "Your family group",
    extractResults: [
      { success: true, data: { content: '找到了: {"family_manager_email": "boss@example.com"}' } },
    ],
  });
  const result = emptyResult({ is_pro: "family_yes" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.family_manager_email, "boss@example.com");
});

test("家庭组检测: AI 返回的邮箱就是当前用户时不采用", async () => {
  const engine = fakeEngine({
    content: "Your family group",
    extractResults: [{ success: true, data: { family_manager_email: "me@x.com" } }],
  });
  const result = emptyResult({ is_pro: "family_yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.family_manager_email, "");
  assert.ok(logs.some((m) => m.includes("AI 未找到管理员邮箱")));
});

test("家庭组检测: AI 提取失败只记日志，不影响已有结果", async () => {
  const engine = fakeEngine({
    content: "Your family group",
    extractResults: [{ success: false, error: "quota exceeded" }],
  });
  const result = emptyResult({ is_pro: "family_yes" });
  const logs = [];
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.family_manager_email, "");
  assert.equal(result.has_family_group, "yes");
  assert.ok(logs.some((m) => m.includes("AI 提取失败: quota exceeded")));
});

test("家庭组检测: sleep 被注入并按秒调用（页面加载等待 3 秒）", async () => {
  const sleep = fakeSleep();
  await detectFamilyDetailsViaBrowserUse(
    fakeEngine({ content: "Your family group\nboss@x.com" }),
    "me@x.com",
    emptyResult({ is_pro: "yes" }),
    { log: () => {}, sleep: sleep.fn },
  );
  assert.deepEqual(sleep.calls, [3]);
});

test("家庭组检测: 导航使用 myaccount.google.com/family/details 且 timeoutMs=15000", async () => {
  const engine = fakeEngine({ content: "Your family group" });
  await detectFamilyDetailsViaBrowserUse(engine, "me@x.com", emptyResult(), silentOpts());
  assert.deepEqual(engine.calls.navigate[0], {
    url: "https://myaccount.google.com/family/details",
    options: { timeoutMs: 15000 },
  });
});

// ==================== extractAccountCountryViaBrowserUse ====================

test("国家提取: AI 返回结构化国家名 → 写入结果", async () => {
  const engine = fakeEngine({
    urls: ["https://myaccount.google.com/personal-info"],
    extractResults: [{ success: true, data: { account_country: "Japan" } }],
  });
  const result = emptyResult();
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, silentOpts());

  assert.equal(result.account_country, "Japan");
  assert.equal(engine.calls.extract[0].instruction, ACCOUNT_COUNTRY_EXTRACT_INSTRUCTION);
  assert.equal(engine.calls.extract[0].schema, ACCOUNT_COUNTRY_EXTRACT_SCHEMA);
  assert.deepEqual(engine.calls.extract[0].options, { timeoutMs: 30000, maxSteps: 10 });
});

test("国家提取: AI 返回 unknown → 结果保持 unknown", async () => {
  const engine = fakeEngine({
    extractResults: [{ success: true, data: { account_country: "unknown" } }],
  });
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.account_country, "unknown");
  assert.ok(logs.some((m) => m.includes("未检测到国家，设为 unknown")));
});

test("国家提取: AI 提取失败 → unknown", async () => {
  const engine = fakeEngine({ extractResults: [{ success: false, error: "boom" }] });
  const result = emptyResult();
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, silentOpts());
  assert.equal(result.account_country, "unknown");
});

test("国家提取: {content:'...'} 里内嵌 JSON 时能解析出来", async () => {
  const engine = fakeEngine({
    extractResults: [{ success: true, data: { content: 'result: {"account_country": "Brazil"}' } }],
  });
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.account_country, "Brazil");
  assert.ok(logs.some((m) => m.includes("从 content 中提取 JSON")));
});

test("国家提取: {content:'自然语言'} 时用 COUNTRY_PATTERNS 兜底", async () => {
  const engine = fakeEngine({
    extractResults: [{ success: true, data: { content: "The country is Japan for this account." } }],
  });
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.account_country.trim().startsWith("Japan"), true);
  assert.ok(logs.some((m) => m.includes("从自然语言中提取国家")));
});

test("国家提取: 导航失败 → unknown", async () => {
  const engine = fakeEngine({ navResults: [{ success: false, error: "DNS 失败" }] });
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.account_country, "unknown");
  assert.equal(engine.calls.extract.length, 0);
  assert.ok(logs.some((m) => m.includes("导航账号设置页面失败")));
});

test("国家提取: 起始在错误页面时先恢复再继续", async () => {
  const engine = fakeEngine({
    urls: ["chrome-error://chromewebdata/", "https://myaccount.google.com/personal-info"],
    extractResults: [{ success: true, data: { account_country: "Canada" } }],
  });
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });

  assert.equal(engine.calls.navigate[0].url, "https://myaccount.google.com", "先恢复到简单页面");
  assert.equal(engine.calls.navigate[1].url, "https://myaccount.google.com/personal-info");
  assert.equal(result.account_country, "Canada");
  assert.ok(logs.some((m) => m.includes("尝试恢复")));
});

test("国家提取: 恢复导航失败 → 跳过并置 unknown", async () => {
  const engine = fakeEngine({
    urls: ["about:blank"],
    navResults: [{ success: false, error: "还是不行" }],
  });
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.account_country, "unknown");
  assert.equal(engine.calls.navigate.length, 1);
  assert.ok(logs.some((m) => m.includes("页面恢复失败，跳过国家提取")));
});

test("国家提取: 导航后仍停在错误页面 → unknown 且不调 AI", async () => {
  const engine = fakeEngine({
    urls: ["https://myaccount.google.com", "chrome-error://chromewebdata/"],
  });
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.account_country, "unknown");
  assert.equal(engine.calls.extract.length, 0);
  assert.ok(logs.some((m) => m.includes("导航后仍在错误页面")));
});

test("国家提取: 整体异常被 catch 并置 unknown", async () => {
  const engine = fakeEngine();
  engine.navigate = async () => {
    throw new Error("引擎已关闭");
  };
  const result = emptyResult();
  const logs = [];
  await extractAccountCountryViaBrowserUse(engine, "me@x.com", result, {
    log: (m) => logs.push(m),
    sleep: async () => {},
  });
  assert.equal(result.account_country, "unknown");
  assert.ok(logs.some((m) => m.includes("国家提取失败")));
});

test("国家提取: sleep 按秒注入（页面加载等待 2 秒）", async () => {
  const sleep = fakeSleep();
  await extractAccountCountryViaBrowserUse(fakeEngine(), "me@x.com", emptyResult(), {
    log: () => {},
    sleep: sleep.fn,
  });
  assert.deepEqual(sleep.calls, [2]);
});
