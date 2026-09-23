/** Pro 检测逻辑单测 —— 重点覆盖二次验证的 4 个修正分支与 3 组关键词 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySecondaryCheck,
  unwrapExtractData,
  checkProStatusSimple,
  matchesAnyIndicator,
  getStagehandConfig,
  PROVIDER_MAP,
  FAMILY_MEMBER_INDICATORS,
  OWNER_INDICATORS,
  NON_SUBSCRIBER_INDICATORS,
  SUBSCRIPTION_INDICATORS,
} from "../src/automation/pro-status-detector.ts";

const base = { is_subscribed: false, is_family_member: false, plan_name: null };

// ---------------- 二次验证：4 个修正分支 ----------------

test("情况1: AI 说不订阅 + 有家庭成员标识 + 无非订阅标识 → 修正为家庭成员", () => {
  const page = "Your plan: 2 TB. Shared by John Doe. plan manager: John";
  const r = applySecondaryCheck(page, { ...base });
  assert.equal(r.is_subscribed, true);
  assert.equal(r.is_family_member, true);
});

test("情况1 反例: 若有非订阅标识则不修正（新用户页面可能也含 shared 字样）", () => {
  const page = "Shared by John. Upgrade now. Get started";
  const r = applySecondaryCheck(page, { ...base });
  assert.equal(r.is_subscribed, false, "出现 Upgrade 说明是非订阅者");
});

test("情况2a: AI 说不订阅 + 有订阅标识 + 有管理员标识 → 修正为个人订阅者", () => {
  const page = "2 TB plan. Manage membership. Cancel membership";
  const r = applySecondaryCheck(page, { ...base });
  assert.equal(r.is_subscribed, true);
  assert.equal(r.is_family_member, false, "有管理按钮说明是自己的订阅");
});

test("情况2b: AI 说不订阅 + 有订阅标识 + 无管理员标识 → 修正为家庭成员", () => {
  const page = "2 TB plan. Your storage: 100 GB used";
  const r = applySecondaryCheck(page, { ...base });
  assert.equal(r.is_subscribed, true);
  assert.equal(r.is_family_member, true, "有方案名但没有管理入口 → 被共享");
});

test("情况3: AI 说订阅且非家庭 + 有家庭成员标识 + 无管理员标识 → 改为家庭成员", () => {
  const page = "Family storage. Shared by Jane";
  const r = applySecondaryCheck(page, { is_subscribed: true, is_family_member: false, plan_name: "2 TB" });
  assert.equal(r.is_subscribed, true);
  assert.equal(r.is_family_member, true);
});

test("情况3 反例: 有管理员标识时不修正（管理员页面也可能提到 family）", () => {
  const page = "Family storage. Manage membership";
  const r = applySecondaryCheck(page, { is_subscribed: true, is_family_member: false, plan_name: "2 TB" });
  assert.equal(r.is_family_member, false, "管理员有 Manage membership，不应判为家庭成员");
});

test("情况4: AI 说订阅 + 只有非订阅标识 → 修正为非订阅", () => {
  const page = "Upgrade your plan. Get started today";
  const r = applySecondaryCheck(page, { is_subscribed: true, is_family_member: false, plan_name: null });
  assert.equal(r.is_subscribed, false);
  assert.equal(r.is_family_member, false);
});

test("情况4 反例: 有管理员标识或订阅标识时不修正", () => {
  const page = "Upgrade available. Manage membership";
  const r = applySecondaryCheck(page, { is_subscribed: true, is_family_member: false, plan_name: null });
  assert.equal(r.is_subscribed, true, "有 Manage membership，AI 的订阅判断应保留");
});

test("无任何标识时：完全保留 AI 判断", () => {
  const r = applySecondaryCheck("totally blank page", {
    is_subscribed: true,
    is_family_member: true,
    plan_name: "2 TB",
  });
  assert.deepEqual(r, { is_subscribed: true, is_family_member: true, plan_name: "2 TB" });
});

test("plan_name 原样透传，不被二次验证修改", () => {
  const r = applySecondaryCheck("Shared by X", { ...base, plan_name: "Google One AI Premium" });
  assert.equal(r.plan_name, "Google One AI Premium");
});

// ---------------- 关键词组 ----------------

test("关键词匹配大小写不敏感", () => {
  assert.equal(matchesAnyIndicator("MANAGE MEMBERSHIP", OWNER_INDICATORS), true);
  assert.equal(matchesAnyIndicator("shared BY john", FAMILY_MEMBER_INDICATORS), true);
});

test("四组关键词互不重叠（避免同一页面被多组同时命中）", () => {
  // 这是在 Python 里踩过坑的地方：upgrade 若同时算订阅标识会导致误判
  assert.equal(matchesAnyIndicator("upgrade", SUBSCRIPTION_INDICATORS), false);
  assert.equal(matchesAnyIndicator("upgrade", NON_SUBSCRIBER_INDICATORS), true);
});

test("中日英三语关键词均可用", () => {
  assert.equal(matchesAnyIndicator("方案管理员", FAMILY_MEMBER_INDICATORS), true);
  assert.equal(matchesAnyIndicator("プランマネージャー", FAMILY_MEMBER_INDICATORS), true);
  assert.equal(matchesAnyIndicator("取消成员资格", OWNER_INDICATORS), true);
});

// ---------------- unwrapExtractData ----------------

test("unwrap: 正常 JSON 直接取字段", () => {
  const r = unwrapExtractData({ is_subscribed: true, is_family_member: false, plan_name: "2 TB" });
  assert.deepEqual(r, { is_subscribed: true, is_family_member: false, plan_name: "2 TB" });
});

test("unwrap: 从 {content} 包装里抠出 JSON", () => {
  const r = unwrapExtractData({
    content: 'Here you go: {"is_subscribed": true, "is_family_member": true, "plan_name": "2 TB"} done',
  });
  assert.equal(r.is_subscribed, true);
  assert.equal(r.is_family_member, true);
  assert.equal(r.plan_name, "2 TB");
});

test("unwrap: content 里没有 JSON 时返回默认值（不抛错）", () => {
  const r = unwrapExtractData({ content: "nothing here" });
  assert.deepEqual(r, { is_subscribed: false, is_family_member: false, plan_name: null });
});

test("unwrap: 空输入不抛错", () => {
  assert.deepEqual(unwrapExtractData(null), { is_subscribed: false, is_family_member: false, plan_name: null });
  assert.deepEqual(unwrapExtractData(undefined), { is_subscribed: false, is_family_member: false, plan_name: null });
});

// ---------------- 简单检测 ----------------

test("simple: 非 Pro 标识优先于 Pro 标识", () => {
  // 同时出现时必须是 false——这是 Python 里的判定顺序
  assert.equal(checkProStatusSimple("Manage membership. Upgrade now."), false);
});

test("simple: 只有 Pro 标识返回 true", () => {
  assert.equal(checkProStatusSimple("Manage membership. Next payment: May 1"), true);
});

test("simple: 无标识返回 null", () => {
  assert.equal(checkProStatusSimple("some unrelated content"), null);
});

// ---------------- 配置读取 ----------------

test("config: provider 前缀映射", () => {
  assert.equal(PROVIDER_MAP.gemini, "google");
  assert.equal(PROVIDER_MAP.anthropic, "anthropic");
});

function fakeConfig(overrides = {}) {
  const c = {
    provider: "gemini",
    apiKey: "K",
    model: "gemini-2.5-flash",
    baseUrl: "",
    ...overrides,
  };
  return {
    getDefaultProvider: () => c.provider,
    getProviderApiKey: () => c.apiKey,
    getProviderModel: () => c.model,
    getProviderBaseUrl: () => c.baseUrl,
  };
}

test("config: 正常构建 modelName", () => {
  const r = getStagehandConfig(fakeConfig());
  assert.equal(r?.modelName, "google/gemini-2.5-flash");
});

test("config: 缺 api_key 或 model 时返回 null", () => {
  assert.equal(getStagehandConfig(fakeConfig({ apiKey: "" })), null);
  assert.equal(getStagehandConfig(fakeConfig({ model: "" })), null);
});

test("config: anthropic 的 base_url 自动补 /v1", () => {
  const r = getStagehandConfig(fakeConfig({ provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com" }));
  assert.equal(r?.baseUrl, "https://api.example.com/v1");
});

test("config: anthropic 已有 /v1 时不重复追加", () => {
  const r = getStagehandConfig(fakeConfig({ provider: "anthropic", model: "claude-x", baseUrl: "https://api.example.com/v1" }));
  assert.equal(r?.baseUrl, "https://api.example.com/v1");
});

test("config: 非 anthropic 保持 base_url 原样", () => {
  const r = getStagehandConfig(fakeConfig({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" }));
  assert.equal(r?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
});