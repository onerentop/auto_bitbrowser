/**
 * 账号健康巡检（只读判定）
 *
 * 本地新增能力：Python 侧没有对应实现（想知道「这批号还有多少能用」只能真的跑批量登录，
 * 会改动会话、耗时、还会触发风控）。这里只读访问 myaccount.google.com，按落点判定
 * `ok` / `need_login` / `suspended` / `window_error`，不提交密码或验证码，因此不产生新会话。
 *
 * 覆盖：四种结论的判定、写库映射、批量编排的计数与逐条目、停止与异常处理。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  applyHealthResult,
  checkAccountHealth,
} from "../src/automation/auto-health-check.ts";
import { executeHealthCheck } from "../src/application/health-check.ts";
import { AccountRepository } from "../src/db/account-repository.ts";
import { initDb } from "../src/db/schema.ts";

const EMAIL = "owner@example.test";
const OTHER = "someone-else@example.test";

/**
 * 假引擎：按导航顺序逐页返回 url / text / html。
 * 与真机一致的地方：navigate 决定当前页，之后的 getCurrentUrl / getPageContent 都读同一页。
 */
function pageEngine(pages) {
  let index = -1;
  const navigated = [];
  return {
    navigated,
    async navigate(url) {
      index += 1;
      navigated.push(url);
      const page = pages[index];
      if (!page) return { success: false, error: "本轮没有更多页面（测试用例写少了）" };
      if (page.fail) return { success: false, error: page.fail };
      return { success: true };
    },
    async wait() {},
    async getCurrentUrl() {
      return pages[index]?.url ?? "";
    },
    async getPageContent() {
      return pages[index]?.text ?? "";
    },
    async getPageHtml() {
      return pages[index]?.html ?? "";
    },
  };
}

const MYACCOUNT = "https://myaccount.google.com/?hl=en";
const PERSONAL_INFO = "https://myaccount.google.com/personal-info?hl=en";

function repo() {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  db.prepare(
    `INSERT INTO accounts (email, login_status, password, secret_key, last_error)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(EMAIL, "not_logged", "old-pass", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", null);
  return new AccountRepository(db);
}

// ==================== 判定 ====================

test("checkAccountHealth：myaccount 页面显示该邮箱 → ok", async () => {
  const engine = pageEngine([{ url: MYACCOUNT, text: `隐私与个性化 ${EMAIL} 首页` }]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "ok");
  assert.equal(r.url, MYACCOUNT);
  assert.match(r.reason, /myaccount/);
  assert.equal(engine.navigated.length, 1, "ok 不应再多跑一次导航");
});

test("checkAccountHealth：邮箱只出现在 HTML 属性里（aria-label）也算 ok", async () => {
  const engine = pageEngine([
    { url: MYACCOUNT, text: "Google 账号", html: `<a aria-label="${EMAIL} 的账号">头像</a>` },
  ]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "ok");
});

test("checkAccountHealth：跳回登录页 → need_login", async () => {
  const engine = pageEngine([
    { url: "https://accounts.google.com/v3/signin/identifier?continue=...", text: "登录 使用您的 Google 账号" },
  ]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "need_login");
  assert.match(r.reason, /accounts\.google\.com/);
});

test("checkAccountHealth：在 myaccount 但页面显示的是别的账号 → need_login（先试第二个页面）", async () => {
  const engine = pageEngine([
    { url: MYACCOUNT, text: `隐私与个性化 ${OTHER}` },
    { url: PERSONAL_INFO, text: `个人信息 ${OTHER}` },
  ]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "need_login");
  assert.equal(engine.navigated.length, 2, "应把两个验证页面都试过");
  assert.match(r.reason, /未显示该邮箱/);
});

test("checkAccountHealth：第一个页面看不到邮箱、第二个页面看到了 → ok", async () => {
  const engine = pageEngine([
    { url: MYACCOUNT, text: "隐私与个性化" },
    { url: PERSONAL_INFO, text: `个人信息 ${EMAIL}` },
  ]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "ok");
  assert.equal(r.url, PERSONAL_INFO);
});

test("checkAccountHealth：停用页（地址含 /disabled）→ suspended，且优先于邮箱匹配", async () => {
  const engine = pageEngine([
    { url: "https://accounts.google.com/v3/signin/disabled?continue=...", text: `您的账号 ${EMAIL} 已被停用` },
  ]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "suspended");
  assert.match(r.reason, /disabled|停用/);
});

test("checkAccountHealth：文本出现停用关键词 → suspended", async () => {
  const engine = pageEngine([{ url: MYACCOUNT, text: `${EMAIL} Your account has been disabled` }]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "suspended");
});

test("checkAccountHealth：两个页面都导航失败 → window_error（不能误判成需要登录）", async () => {
  const engine = pageEngine([{ fail: "Target closed" }, { fail: "Target closed" }]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "window_error");
  assert.match(r.message, /Target closed/);
});

test("checkAccountHealth：导航成功但拿不到页面地址 → window_error", async () => {
  const engine = pageEngine([{ url: "", text: "" }, { url: "", text: "" }]);
  const r = await checkAccountHealth(engine, EMAIL);
  assert.equal(r.status, "window_error");
});

// ==================== 写库映射 ====================

test("applyHealthResult：ok → logged_in（顺带清掉上一次的错误）", () => {
  const r = repo();
  r.updateLoginStatus(EMAIL, "login_failed", "上次的失败原因");
  applyHealthResult(r, EMAIL, { status: "ok", message: "已登录", url: MYACCOUNT, reason: "" });
  const row = /** @type {any} */ (r.getAccountByEmail(EMAIL));
  assert.equal(row.login_status, "logged_in");
  assert.equal(row.last_error, null);
});

test("applyHealthResult：need_login → not_logged", () => {
  const r = repo();
  r.updateLoginStatus(EMAIL, "login_failed", "上次的失败原因");
  applyHealthResult(r, EMAIL, { status: "need_login", message: "需要登录", url: "", reason: "" });
  const row = /** @type {any} */ (r.getAccountByEmail(EMAIL));
  assert.equal(row.login_status, "not_logged");
});

test("applyHealthResult：suspended → login_failed，last_error 写明停用", () => {
  const r = repo();
  applyHealthResult(r, EMAIL, { status: "suspended", message: "账号已被停用", url: "", reason: "" });
  const row = /** @type {any} */ (r.getAccountByEmail(EMAIL));
  assert.equal(row.login_status, "login_failed");
  assert.equal(row.last_error, "账号已被停用");
});

test("applyHealthResult：window_error 不改 login_status，只记一条问题消息", () => {
  const r = repo();
  applyHealthResult(r, EMAIL, { status: "ok", message: "已登录", url: MYACCOUNT, reason: "" });
  assert.equal(/** @type {any} */ (r.getAccountByEmail(EMAIL)).login_status, "logged_in");

  applyHealthResult(r, EMAIL, {
    status: "window_error",
    message: "窗口打不开: Target closed",
    url: "",
    reason: "",
  });
  const row = /** @type {any} */ (r.getAccountByEmail(EMAIL));
  assert.equal(row.login_status, "logged_in", "窗口坏 ≠ 账号状态变坏");
  assert.equal(row.last_error, "窗口打不开: Target closed");
});

test("回归：updateLoginStatus(logged_in) 会清空 last_error —— 所以 window_error 不能走它", () => {
  const r = repo();
  r.setLastError(EMAIL, "窗口打不开: Target closed");
  assert.equal(/** @type {any} */ (r.getAccountByEmail(EMAIL)).last_error, "窗口打不开: Target closed");
  r.updateLoginStatus(EMAIL, "logged_in");
  assert.equal(/** @type {any} */ (r.getAccountByEmail(EMAIL)).last_error, null, "这就是必须单独用 setLastError 的原因");
});

// ==================== 批量编排 ====================

function account(email) {
  return { email, password: "p", secret_key: "s" };
}

test("executeHealthCheck：逐账号巡检、计数、上报逐条目、进度到 total", async () => {
  const items = [];
  const progress = [];
  const logs = [];
  const answers = {
    "a@x.com": { status: "ok", message: "已登录", url: MYACCOUNT, reason: "" },
    "b@x.com": { status: "need_login", message: "需要登录", url: "", reason: "" },
    "c@x.com": { status: "suspended", message: "账号已被停用", url: "", reason: "" },
    "d@x.com": { status: "window_error", message: "窗口打不开: closed", url: "", reason: "" },
  };
  const summary = await executeHealthCheck({
    accounts: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"].map(account),
    browserIds: ["1", "2", "3", "4"],
    check: async (_browserId, acc) => answers[acc.email],
    shouldStop: () => false,
    log: (m) => logs.push(m),
    progress: (i) => progress.push(i),
    item: (k, s, m) => items.push([k, s, m]),
  });

  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 1);
  assert.equal(summary.need_login, 1);
  assert.equal(summary.suspended, 1);
  assert.equal(summary.window_error, 1);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  assert.deepEqual(
    items.map((i) => [i[0], i[1]]),
    [
      ["a@x.com", "成功"],
      ["b@x.com", "失败"],
      ["c@x.com", "失败"],
      ["d@x.com", "错误"],
    ],
  );
  assert.ok(logs.some((m) => m.includes("a@x.com") && m.includes("已登录")));
});

test("executeHealthCheck：未绑定窗口的账号记 window_error，不去连引擎", async () => {
  const called = [];
  const items = [];
  const summary = await executeHealthCheck({
    accounts: [account("a@x.com"), account("b@x.com")],
    browserIds: ["", "2"],
    check: async (browserId) => {
      called.push(browserId);
      return { status: "ok", message: "已登录", url: MYACCOUNT, reason: "" };
    },
    shouldStop: () => false,
    log: () => {},
    progress: () => {},
    item: (k, s, m) => items.push([k, s, m]),
  });

  assert.deepEqual(called, ["2"], "未绑定窗口不应调用 check");
  assert.equal(summary.window_error, 1);
  assert.equal(summary.ok, 1);
  assert.deepEqual(items[0], ["a@x.com", "错误", "未绑定窗口"]);
});

test("executeHealthCheck：某个账号巡检抛错记 window_error，不影响后面的账号", async () => {
  const items = [];
  const summary = await executeHealthCheck({
    accounts: [account("a@x.com"), account("b@x.com")],
    browserIds: ["1", "2"],
    check: async (_b, acc) => {
      if (acc.email === "a@x.com") throw new Error("Target closed");
      return { status: "ok", message: "已登录", url: MYACCOUNT, reason: "" };
    },
    shouldStop: () => false,
    log: () => {},
    progress: () => {},
    item: (k, s, m) => items.push([k, s, m]),
  });

  assert.equal(summary.window_error, 1);
  assert.equal(summary.ok, 1);
  assert.match(items[0][2], /Target closed/);
  assert.deepEqual(items[1].slice(0, 2), ["b@x.com", "成功"]);
});

test("executeHealthCheck：中途停止只为已处理的账号上报条目，不补假条目", async () => {
  const items = [];
  let done = 0;
  const summary = await executeHealthCheck({
    accounts: [account("a@x.com"), account("b@x.com"), account("c@x.com")],
    browserIds: ["1", "2", "3"],
    check: async () => {
      done += 1;
      return { status: "ok", message: "已登录", url: MYACCOUNT, reason: "" };
    },
    shouldStop: () => done >= 2,
    log: () => {},
    progress: () => {},
    item: (k, s, m) => items.push([k, s, m]),
  });

  assert.equal(summary.ok, 2);
  assert.equal(summary.results.length, 2);
  assert.deepEqual(items.map((i) => i[0]), ["a@x.com", "b@x.com"]);
});

test("executeHealthCheck：没有 window_error 之外的路径会改动 login_status（只读承诺）", async () => {
  // 巡检本身不碰引擎的写操作：这里断言编排层只调用 check，不调用任何 fill / click
  const engineCalls = [];
  /** @type {() => Promise<import("../src/application/health-check.ts").HealthCheckResult>} */
  const fakeCheck = async () => {
    engineCalls.push("check");
    return { status: "ok", message: "已登录", url: MYACCOUNT, reason: "" };
  };
  await executeHealthCheck({
    accounts: [account("a@x.com")],
    browserIds: ["1"],
    check: fakeCheck,
    shouldStop: () => false,
    log: () => {},
    progress: () => {},
  });
  assert.deepEqual(engineCalls, ["check"]);
});
