/**
 * 账号管理页：后端 handler（app/host/handlers/accounts.ts + src/application/account-plan.ts）与渲染层纯函数的离线单测
 * :memory: 库 + initDb、假 ixBrowser、假批处理器，全部离线。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ERROR_CODES } from "../app/shared/envelope.ts";
import { IPC } from "../app/shared/ipc.ts";
import { ACCOUNTS_ACTIONS, ACCOUNTS_INVOKE } from "../app/shared/channels/accounts.ts";
import { createHostContext } from "../app/host/context.ts";
import { createDispatcher } from "../app/host/dispatch.ts";
import { createAccountsHandlers, createDefaultProcessor, readLlmParams } from "../app/host/handlers/accounts.ts";
import { createAccountDataHandlers } from "../app/host/handlers/account-data.ts";
import { finishedNotice } from "../app/renderer/src/pages/accounts/finished-notice.ts";
import { createBatchResult } from "../src/automation/batch/types.ts";
import { loginView } from "../app/renderer/src/pages/accounts/status.ts";
import { accountSorter, countLogin, filterAccounts } from "../app/shared/logic/account-list.ts";

const CH = ACCOUNTS_INVOKE;

function fakeIx(windows, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async getGroupList() {
      return [];
    },
    async getProfileList(q) {
      calls.push(["list", q]);
      if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:53200");
      return windows;
    },
    async closeProfile(id) {
      calls.push(["close", id]);
      return true;
    },
    async deleteProfile(id) {
      calls.push(["delete", id]);
      return true;
    },
    async openProfile() {
      throw new Error("测试中不应打开窗口");
    },
  };
}

/**
 * 建上下文：临时数据根（不碰仓库根的 config.json / accounts.db）、:memory: 库
 * @param {{ windows?: Array<{ profile_id: number, name: string, group_id?: number }>, ixFail?: boolean, deps?: import("../app/host/handlers/accounts.ts").AccountsHandlerDeps }} [options]
 */
function setup({ windows = [], ixFail = false, deps = {} } = {}) {
  const events = [];
  const waiters = [];
  const ix = fakeIx(windows, { fail: ixFail });
  const ctx = createHostContext({
    dataRoot: mkdtempSync(join(tmpdir(), "abb-accounts-test-")),
    emit: (channel, payload) => {
      events.push([channel, payload]);
      if (channel === IPC.event.taskFinished) waiters.shift()?.(payload);
    },
    log: () => {},
    openDatabase: () => new DatabaseSync(":memory:"),
    ixClient: /** @type {any} */ (ix), // 假客户端只实现账号页用到的四个方法
  });
  // 默认不真的等待重试退避（ixFail 的 ECONNREFUSED 属于可重试错误）
  const handlers = { ...createAccountsHandlers(ctx, { sleep: async () => {}, ...deps }), ...createAccountDataHandlers(ctx) };
  const dispatch = createDispatcher(handlers);
  /** @returns {Promise<any>} 信封里的 data 形状由各用例自行断言 */
  const call = async (channel, ...args) => {
    const env = await dispatch(channel, args);
    if (!env.ok) {
      const e = /** @type {Error & { code: string }} */ (new Error(env.error.message));
      e.code = env.error.code;
      throw e;
    }
    return env.data;
  };
  const finished = () => new Promise((r) => waiters.push(r));
  const items = () => events.filter(([c]) => c === IPC.event.taskItem).map(([, p]) => [p.key, p.status, p.message]);
  return { ctx, ix, events, call, dispatch, finished, logs: () => events.filter(([c]) => c === IPC.event.taskLog).map(([, p]) => p.message), items };
}

const INSERT = `INSERT INTO accounts (email, login_status, browser_profile_id, is_pro, sub2api_status,
  sub2api_account_id, unlock_status, validation_url, last_error) VALUES (?,?,?,?,?,?,?,?,?)`;

function seed(ctx, rows) {
  const stmt = ctx.db().prepare(INSERT);
  for (const r of rows) {
    stmt.run(
      r.email,
      r.login_status ?? "not_logged",
      r.browser_profile_id ?? null,
      r.is_pro ?? "unknown",
      r.sub2api_status ?? "not_linked",
      r.sub2api_account_id ?? null,
      r.unlock_status ?? "none",
      r.validation_url ?? null,
      r.last_error ?? null,
    );
  }
}

const OPTS = { concurrency: 2 };

// ==================== 列表 ====================

test("list：窗口名 / 分组由 browser_profile_id 映射；分组与窗口并发请求；未绑定 / 窗口不存在归伪分组", async () => {
  /** @type {string[]} */
  const order = [];
  const s = setup({
    windows: [
      { profile_id: 101, name: "win-a", group_id: 2 },
      { profile_id: 102, name: "win-b" },
    ],
    deps: {
      listGroups: async () => {
        order.push("groups:start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("groups:end");
        return [{ id: 2, title: "业务组" }];
      },
    },
  });
  const origList = s.ix.getProfileList.bind(s.ix);
  s.ix.getProfileList = async (q) => {
    order.push("windows");
    return origList(q);
  };
  seed(s.ctx, [
    { email: "a@x.com", browser_profile_id: "101", login_status: "logged_in" },
    { email: "b@x.com", login_status: "login_failed", last_error: "boom" },
    { email: "c@x.com", browser_profile_id: "999" },
    { email: "d@x.com", browser_profile_id: "102" },
  ]);
  const r = await s.call(CH.accountsList);
  assert.equal(r.windowError, null);
  assert.deepEqual(order.slice(0, 2), ["groups:start", "windows"], "窗口列表应与分组列表并发发出");
  const by = Object.fromEntries(r.rows.map((x) => [x.email, x]));
  assert.deepEqual([by["a@x.com"].window_name, by["a@x.com"].group_id, by["a@x.com"].group_name], ["win-a", 2, "业务组"]);
  assert.deepEqual([by["b@x.com"].browser_profile_id, by["b@x.com"].group_name, by["b@x.com"].last_error], ["", "未绑定窗口", "boom"]);
  assert.deepEqual([by["c@x.com"].window_name, by["c@x.com"].group_name], ["", "窗口不存在"]);
  assert.deepEqual([by["d@x.com"].group_id, by["d@x.com"].group_name], [0, "未分组"]);
  // 真实分组按 ID 升序，伪分组排最后
  assert.deepEqual(r.groups.map((g) => [g.groupName, g.count]), [
    ["未分组", 1],
    ["业务组", 1],
    ["未绑定窗口", 1],
    ["窗口不存在", 1],
  ]);
});

test("list：只下发有 / 无，不含密码 / 2FA 密钥 / 辅助邮箱原文", async () => {
  const s = setup();
  s.ctx.accountRepo().upsertAccount({ email: "a@x.com", password: "PW-SECRET-1", recovery_email: "rec@y.com", secret_key: "TOTPKEYXYZ" });
  s.ctx.accountRepo().upsertAccount({ email: "b@x.com" });
  const r = await s.call(CH.accountsList);
  const by = Object.fromEntries(r.rows.map((x) => [x.email, x]));
  assert.deepEqual([by["a@x.com"].has_password, by["a@x.com"].has_recovery_email, by["a@x.com"].has_secret], [true, true, true]);
  assert.deepEqual([by["b@x.com"].has_password, by["b@x.com"].has_recovery_email, by["b@x.com"].has_secret], [false, false, false]);
  const json = JSON.stringify(r);
  for (const secret of ["PW-SECRET-1", "rec@y.com", "TOTPKEYXYZ"]) assert.ok(!json.includes(secret), `不应下发 ${secret}`);
});

test("list：窗口超过一页时翻页取全量（以前只取前 500 个）", async () => {
  const all = Array.from({ length: 1234 }, (_, i) => ({ profile_id: i + 1, name: `w${i + 1}` }));
  const s = setup();
  /** @type {any[]} */
  const queries = [];
  s.ix.getProfileList = async (q) => {
    queries.push(q);
    const start = (q.page - 1) * q.limit;
    return all.slice(start, start + q.limit);
  };
  seed(s.ctx, [{ email: "last@x.com", browser_profile_id: "1234" }]);
  const r = await s.call(CH.accountsList);
  assert.equal(r.rows[0].window_name, "w1234");
  assert.deepEqual(queries.map((q) => q.page), [1, 2]);
  assert.ok(queries[0].limit >= 1000);
});

test("list：ixBrowser 不可达时名称为空、绑定窗口的账号归「窗口信息获取失败」，不报错", async () => {
  const s = setup({ ixFail: true });
  seed(s.ctx, [{ email: "a@x.com", browser_profile_id: "101" }]);
  const r = await s.call(CH.accountsList);
  assert.match(r.windowError, /ECONNREFUSED/);
  assert.equal(r.rows[0].window_name, "");
  assert.equal(r.rows[0].group_name, "窗口信息获取失败");
});

test("list：窗口翻页遇到可重试错误先重试（1s/2s 退避）再成功；不可重试错误立刻放弃", async () => {
  /** @type {number[]} */
  const sleeps = [];
  const s = setup({ deps: { sleep: async (ms) => void sleeps.push(ms) } });
  let failures = 2;
  s.ix.getProfileList = async () => {
    if (failures-- > 0) throw new Error("exception desc:fetch failed network");
    return [{ profile_id: 101, name: "win-a" }];
  };
  seed(s.ctx, [{ email: "a@x.com", browser_profile_id: "101" }]);
  const r = await s.call(CH.accountsList);
  assert.equal(r.windowError, null);
  assert.equal(r.rows[0].window_name, "win-a");
  assert.deepEqual(sleeps, [1000, 2000]);

  const s2 = setup({ deps: { sleep: async (ms) => void sleeps.push(ms) } });
  sleeps.length = 0;
  s2.ix.getProfileList = async () => {
    throw new Error("profile not exist");
  };
  seed(s2.ctx, [{ email: "a@x.com", browser_profile_id: "101" }]);
  const r2 = await s2.call(CH.accountsList);
  assert.match(r2.windowError, /profile not exist/);
  assert.deepEqual(sleeps, [], "不可重试错误不等待");
});

// ==================== 账号数据（从设置页迁来） ====================

test("账号数据：get 取原文；add 新增 pending；update 不改状态；未知账号拒绝", async () => {
  const s = setup();
  assert.equal(await s.call(CH.accountsAdd, { email: " a@b.com ", password: " pw ", recovery_email: "r@x.com", secret_key: "S" }), true);
  let a = s.ctx.accountRepo().getAccountByEmail("a@b.com");
  assert.ok(a);
  assert.equal(a.status, "pending");
  assert.equal(a.password, " pw ", "密码不 strip");
  assert.deepEqual(await s.call(CH.accountsGet, "a@b.com"), { email: "a@b.com", password: " pw ", recovery_email: "r@x.com", secret_key: "S" });

  s.ctx.accountRepo().upsertAccount({ email: "a@b.com", status: "subscribed" });
  await s.call(CH.accountsUpdate, { email: "a@b.com", password: "pw2", recovery_email: "", secret_key: "S" });
  a = s.ctx.accountRepo().getAccountByEmail("a@b.com");
  assert.ok(a);
  assert.equal(a.status, "subscribed", "编辑不改状态");
  assert.equal(a.password, "pw2");

  const bad = (/** @type {any} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT;
  await assert.rejects(s.call(CH.accountsGet, "nobody@x.com"), bad);
  await assert.rejects(s.call(CH.accountsUpdate, { email: "nobody@x.com", password: "", recovery_email: "", secret_key: "" }), bad);
  await assert.rejects(s.call(CH.accountsAdd, { email: "abc", password: "", recovery_email: "", secret_key: "" }), bad);
  await assert.rejects(s.call(CH.accountsUpdate, { email: "", password: "", recovery_email: "", secret_key: "" }), bad);
  await assert.rejects(s.call(CH.accountsAdd, { email: "a@b.com" }), bad, "缺字段");
});

test("账号数据：导入（已存在只更新非空字段，新账号 pending）；无有效行拒绝", async () => {
  const s = setup();
  s.ctx.accountRepo().upsertAccount({ email: "a@b.com", password: "p", secret_key: "S", status: "subscribed" });
  const r = await s.call(CH.accountsImport, "a@b.com----pw3----new@r.com\nbad\nn@m.com----p----rr@x.com----K");
  assert.deepEqual(r, { success_count: 2, fail_count: 0 });
  const a = s.ctx.accountRepo().getAccountByEmail("a@b.com");
  assert.ok(a);
  assert.deepEqual([a.password, a.recovery_email, a.secret_key, a.status], ["pw3", "new@r.com", "S", "subscribed"]);
  const n = s.ctx.accountRepo().getAccountByEmail("n@m.com");
  assert.ok(n);
  assert.deepEqual([n.status, n.secret_key], ["pending", "K"]);
  const bad = (/** @type {any} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT;
  await assert.rejects(s.call(CH.accountsImport, 42), bad);
  await assert.rejects(s.call(CH.accountsImport, "bad\n# only comment"), bad);
});

test("账号数据：导出文本格式不变，按传入顺序、去重、库里没有的跳过", async () => {
  const s = setup();
  s.ctx.accountRepo().upsertAccount({ email: "a@b.com", password: "pa", recovery_email: "ra@x.com", secret_key: "KA" });
  s.ctx.accountRepo().upsertAccount({ email: "c@d.com", password: "pc" });
  const r = await s.call(CH.accountsExportText, ["c@d.com", "ghost@x.com", "a@b.com", "c@d.com", ""]);
  assert.equal(r.count, 2);
  assert.equal(r.text, '分隔符="----"\nc@d.com----pc--------\na@b.com----pa----ra@x.com----KA\n');
  const bad = (/** @type {any} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT;
  await assert.rejects(s.call(CH.accountsExportText, []), bad);
  await assert.rejects(s.call(CH.accountsExportText, [1]), bad);
});

test("getDefaults：无配置时并发数为 Python 默认值 3", async () => {
  const s = setup();
  assert.deepEqual(await s.call(CH.accountsGetDefaults), { loginConcurrency: 3 });
});

// ==================== 参数校验 ====================

test("参数校验：非法参数一律 INVALID_ARGUMENT", async () => {
  const s = setup();
  const bad = async (channel, args) => {
    const env = await s.dispatch(channel, args);
    assert.equal(env.ok, false, `${channel} ${JSON.stringify(args)}`);
    assert.equal(env.error.code, ERROR_CODES.INVALID_ARGUMENT, `${channel} ${JSON.stringify(args)}`);
  };
  await bad(CH.accountsPrecheck, ["nope", []]);
  // 已删除的操作一律视为未知操作
  for (const removed of ["oauth", "single_oauth", "login_and_oauth", "detect_pro", "refresh_membership_info", "enable_family_sharing", "detect_403", "unlock_403"]) {
    await bad(CH.accountsPrecheck, [removed, []]);
  }
  await bad(CH.accountsPrecheck, ["login", "not-array"]);
  await bad(CH.accountsPrecheck, ["login", [{ email: 1 }]]);
  await bad(CH.accountsPrecheck, ["login", [null]]);
  await bad(CH.accountsPrecheck, ["single_login", [{ email: "a", browserId: "" }, { email: "b", browserId: "" }]]);
  await bad(CH.accountsStart, ["login", [], { concurrency: 0 }]);
  await bad(CH.accountsStart, ["login", [], { concurrency: 11 }]);
  await bad(CH.accountsStart, ["login", [], { concurrency: 2.5 }]);
  await bad(CH.accountsStart, ["login", [], null]);
  await bad(CH.accountsBind, ["a@x.com", "abc"]);
  await bad(CH.accountsBind, ["", "12"]);
  await bad(CH.accountsUnbind, [42]);
  await bad(CH.accountsDeleteOne, [""]);
  await bad(CH.accountsBindCandidates, [null]);
});

// ==================== 预检 ====================

test("precheck：批量登录的前置校验文案（:831-848）", async () => {
  const s = setup();
  seed(s.ctx, [
    { email: "a", browser_profile_id: "1" },
    { email: "b" },
  ]);
  assert.deepEqual(await s.call(CH.accountsPrecheck, "login", []), {
    ok: false,
    level: "info",
    title: "提示",
    message: "请先选择要登录的账号",
  });
  const r = await s.call(CH.accountsPrecheck, "login", [
    { email: "a", browserId: "1" },
    { email: "b", browserId: "" },
  ]);
  assert.deepEqual(r, { ok: false, level: "warning", title: "警告", message: "以下账号未绑定窗口:\nb" });
  const ok = await s.call(CH.accountsPrecheck, "login", [{ email: "a", browserId: "1" }]);
  assert.deepEqual(ok, { ok: true, confirms: [], logs: [], total: 1 });
});


test("precheck：批量绑定按窗口名匹配，ix 不可达时报错", async () => {
  const s = setup({ windows: [{ profile_id: 7, name: "A@x.com" }, { profile_id: 8, name: "zz" }] });
  seed(s.ctx, [{ email: "a@x.com" }, { email: "c@x.com" }, { email: "d@x.com", browser_profile_id: "5" }]);
  const r = await s.call(CH.accountsPrecheck, "batch_bind", [
    { email: "a@x.com", browserId: "" },
    { email: "c@x.com", browserId: "" },
    { email: "d@x.com", browserId: "5" },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.confirms[0].message, "将绑定 1 个账号到对应窗口\n\n❌ 1 个账号未找到匹配窗口:\nc@x.com\n\n是否继续？");

  const s2 = setup({ ixFail: true });
  seed(s2.ctx, [{ email: "a@x.com" }]);
  const e = await s2.call(CH.accountsPrecheck, "batch_bind", [{ email: "a@x.com", browserId: "" }]);
  assert.equal(e.level, "error");
  assert.match(e.message, /^批量绑定失败:\n/);
});

test("precheck：任务运行中返回冲突提示（删除带 wait_action）", async () => {
  const s = setup();
  /** @type {(value?: void) => void} */
  let release = () => {};
  s.ctx.tasks.start("x", "占位", () => new Promise((r) => (release = r)));
  const r = await s.call(CH.accountsPrecheck, "delete", [{ email: "a", browserId: "" }]);
  assert.deepEqual(r, { ok: false, level: "warning", title: "警告", message: "已有任务在执行中，请等待完成后再删除" });
  release();
});

// ==================== 启动任务 ====================

function fakeProcessorFactory() {
  /** @type {{ created: any[], calls: any[], stopped: number, gate: Promise<any> | null }} */
  const state = { created: [], calls: [], stopped: 0, gate: null };
  const factory = (opts) => {
    state.created.push(opts);
    return {
      async batchLogin(a, b, o) {
        state.calls.push(["batchLogin", a.map((x) => x.email), b, o]);
        opts.callback("[1/1] ✓ 成功");
        if (state.gate) await state.gate;
        return createBatchResult({
          total: a.length,
          success_count: a.length,
          results: a.map((x) => ({ email: x.email, status: "success" })),
        });
      },
      stop() {
        state.stopped++;
      },
    };
  };
  return { state, factory };
}

test("start：批量登录作为后台任务运行，传入并发数，结果形状 {type, result}", async () => {
  const p = fakeProcessorFactory();
  const s = setup({ deps: { createProcessor: p.factory } });
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }]);
  const done = s.finished();
  const info = await s.call(CH.accountsStart, "login", [{ email: "a", browserId: "1" }], OPTS);
  assert.equal(info.type, "login");
  assert.equal(info.label, "批量登录");
  const e = await done;
  assert.equal(e.outcome, "succeeded");
  assert.equal(e.result.type, "login");
  assert.equal(e.result.result.success_count, 1);
  assert.equal(p.state.created[0].concurrency, 2);
  assert.deepEqual(p.state.calls[0].slice(0, 3), ["batchLogin", ["a"], ["1"]]);
  const logs = s.logs();
  assert.equal(logs[0], "开始 login 任务，共 1 个账号...");
  assert.ok(logs.includes("登录完成: 成功 1, 失败 0, 跳过 0"));
  // 进度从日志解析
  assert.ok(s.events.some(([c, p2]) => c === IPC.event.taskProgress && p2.current === 1 && p2.total === 1));
  // 批量登录按账号上报条目（任务历史的逐条目来源）
  assert.deepEqual(s.items(), [["a", "成功", ""]]);
});


test("start：停止会触发 processor.stop，任务结束状态为 stopped", async () => {
  const p = fakeProcessorFactory();
  /** @type {(value?: void) => void} */
  let open = () => {};
  p.state.gate = new Promise((r) => (open = r));
  const s = setup({ deps: { createProcessor: p.factory } });
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }]);
  const done = s.finished();
  await s.call(CH.accountsStart, "login", [{ email: "a", browserId: "1" }], OPTS);
  // 等任务真正跑起来（processor 已创建）
  while (p.state.created.length === 0) await new Promise((r) => setTimeout(r, 1));
  assert.equal(s.ctx.tasks.stop(), true);
  assert.ok(p.state.stopped >= 1);
  open();
  const e = await done;
  assert.equal(e.outcome, "stopped");
  assert.deepEqual(e.result, { type: "stopped", task_type: "login", message: "用户停止任务" });
  // 停止也要保留已处理账号的条目：否则历史显示 total=0，与实际处理量不符
  assert.deepEqual(s.items(), [["a", "成功", ""]]);
});

test("start：已有任务在跑时抛 TASK_BUSY", async () => {
  const s = setup();
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }]);
  /** @type {(value?: void) => void} */
  let release = () => {};
  s.ctx.tasks.start("x", "占位任务", () => new Promise((r) => (release = r)));
  const env = await s.dispatch(CH.accountsStart, ["login", [{ email: "a", browserId: "1" }], OPTS]);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, ERROR_CODES.TASK_BUSY);
  release();
});

test("start：预检不通过时抛 INVALID_ARGUMENT 并带 Python 文案", async () => {
  const s = setup();
  const env = await s.dispatch(CH.accountsStart, ["login", [], OPTS]);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, ERROR_CODES.INVALID_ARGUMENT);
  assert.equal(env.error.message, "请先选择要登录的账号");
});

test("start：删除+窗口 —— 结果形状，窗口先关后删，账号从库中删除", async () => {
  const s = setup();
  seed(s.ctx, [
    { email: "a", browser_profile_id: "11" },
    { email: "b" },
  ]);
  const done = s.finished();
  const info = await s.call(
    CH.accountsStart,
    "delete_with_windows",
    [
      { email: "a", browserId: "11" },
      { email: "b", browserId: "" },
    ],
    OPTS,
  );
  assert.equal(info.type, "batch_delete");
  const e = await done;
  assert.deepEqual(e.result, { total: 2, deleted_accounts: 2, deleted_windows: 1, failed_count: 0, failed_list: [] });
  assert.deepEqual(
    s.ix.calls.map((c) => c.slice(0, 2)),
    [
      ["close", 11],
      ["delete", 11],
    ],
  );
  assert.equal(s.ctx.accountRepo().count(), 0);
  assert.ok(s.logs().includes("批量删除完成: 删除账号 2/2, 失败 0"));
  assert.deepEqual(
    s.items(),
    [
      ["a", "成功", ""],
      ["b", "成功", ""],
    ],
  );
});


test("start：批量绑定 —— 结果形状 {total, success_count, failed_count} 并写库", async () => {
  const s = setup({ windows: [{ profile_id: 7, name: "a@x.com" }] });
  seed(s.ctx, [{ email: "a@x.com" }]);
  const done = s.finished();
  await s.call(CH.accountsStart, "batch_bind", [{ email: "a@x.com", browserId: "" }], OPTS);
  const e = await done;
  assert.deepEqual(e.result, { total: 1, success_count: 1, failed_count: 0, failed_list: [] });
  const boundByEmail = s.ctx.accountRepo().getAccountByEmail("a@x.com");
  assert.ok(boundByEmail);
  assert.equal(boundByEmail.browser_profile_id, "7");
  assert.deepEqual(s.items(), [["a@x.com", "成功", ""]]);
});

// ==================== 单条操作 ====================

test("bindCandidates / bind / unbind / deleteOne", async () => {
  const s = setup({
    windows: [
      { profile_id: 1, name: "w1" },
      { profile_id: 2, name: "w2" },
      { profile_id: 3, name: "" },
    ],
  });
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }, { email: "b", browser_profile_id: "2" }, { email: "c" }]);

  // a 自己绑定的窗口 1 可选；窗口 2 被 b 占用 → 排除
  const cand = await s.call(CH.accountsBindCandidates, "a");
  assert.equal(cand.currentBrowserId, "1");
  assert.equal(cand.windowCount, 3);
  assert.deepEqual(cand.available, [
    { profileId: "1", name: "w1" },
    { profileId: "3", name: "未命名" },
  ]);

  // 绑定到被其它账号占用的窗口 → 拒绝
  const env = await s.dispatch(CH.accountsBind, ["c", "2"]);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, ERROR_CODES.INVALID_ARGUMENT);

  assert.deepEqual(await s.call(CH.accountsBind, "a", "3"), { email: "a", browserId: "3", previousBrowserId: "1" });
  assert.deepEqual(await s.call(CH.accountsUnbind, "a"), { email: "a", browserId: "3" });
  assert.deepEqual(await s.call(CH.accountsUnbind, "a"), { email: "a", browserId: "" });
  const unbound = s.ctx.accountRepo().getAccountByEmail("a");
  assert.ok(unbound);
  assert.equal(unbound.browser_profile_id, "");

  assert.equal(await s.call(CH.accountsDeleteOne, "c"), true);
  assert.equal(s.ctx.accountRepo().getAccountByEmail("c"), null);
});

// ==================== 以数据库为准 / 写库失败 / 忙碌拦截 ====================

test("start：登录任务使用数据库里的窗口 ID，不信任行上的值；库里未绑定按未绑定处理", async () => {
  const p = fakeProcessorFactory();
  const s = setup({ deps: { createProcessor: p.factory } });
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }, { email: "b" }]);
  const done = s.finished();
  await s.call(CH.accountsStart, "login", [{ email: "a", browserId: "99" }], OPTS);
  assert.equal((await done).outcome, "succeeded");
  assert.deepEqual(
    p.state.calls.map((c) => [c[0], c[2]]),
    [["batchLogin", ["1"]]],
  );

  // 行上说已绑定、库里未绑定 → 沿用「未绑定窗口」的前置校验文案
  const r = await s.call(CH.accountsPrecheck, "login", [{ email: "b", browserId: "5" }]);
  assert.deepEqual(r, { ok: false, level: "warning", title: "警告", message: "以下账号未绑定窗口:\nb" });
});

test("start：删除+窗口 —— 行上窗口 ID 与数据库不一致时整条跳过，不误删窗口", async () => {
  const s = setup();
  seed(s.ctx, [
    { email: "a", browser_profile_id: "11" },
    { email: "b", browser_profile_id: "13" },
  ]);
  const rows = [
    { email: "a", browserId: "12" },
    { email: "b", browserId: "13" },
  ];
  const pre = await s.call(CH.accountsPrecheck, "delete_with_windows", rows);
  assert.equal(pre.total, 1);
  assert.deepEqual(pre.logs, ["数据已变化，请刷新后重试: a"]);

  const done = s.finished();
  await s.call(CH.accountsStart, "delete_with_windows", rows, OPTS);
  const e = await done;
  assert.deepEqual(e.result, {
    total: 2,
    deleted_accounts: 1,
    deleted_windows: 1,
    failed_count: 1,
    failed_list: [{ email: "a", error: "数据已变化，请刷新后重试" }],
  });
  assert.deepEqual(
    s.ix.calls.map((c) => c.slice(0, 2)),
    [
      ["close", 13],
      ["delete", 13],
    ],
  );
  assert.ok(s.ctx.accountRepo().getAccountByEmail("a"));
  assert.equal(s.ctx.accountRepo().getAccountByEmail("b"), null);
  assert.ok(s.logs().includes("数据已变化，请刷新后重试: a"));
  // 过期账号也要上报条目：历史里的总数 / 失败数必须与日志里的「失败 1」对得上
  assert.deepEqual(s.items(), [
    ["a", "失败", "数据已变化，请刷新后重试"],
    ["b", "成功", ""],
  ]);

  // 全部不一致 → 直接拒绝
  const w = await s.call(CH.accountsPrecheck, "delete_with_windows", [{ email: "a", browserId: "" }]);
  assert.deepEqual(w, { ok: false, level: "warning", title: "警告", message: "数据已变化，请刷新后重试:\na" });
});

test("delete_one_with_window：用数据库的窗口 ID；与行上不一致或未绑定时拒绝", async () => {
  const s = setup();
  seed(s.ctx, [{ email: "a", browser_profile_id: "21" }, { email: "b" }]);
  assert.deepEqual(await s.call(CH.accountsPrecheck, "delete_one_with_window", [{ email: "a", browserId: "22" }]), {
    ok: false,
    level: "warning",
    title: "警告",
    message: "数据已变化，请刷新后重试:\na",
  });
  assert.deepEqual(await s.call(CH.accountsPrecheck, "delete_one_with_window", [{ email: "b", browserId: "" }]), {
    ok: false,
    level: "warning",
    title: "警告",
    message: "账号 b 未绑定浏览器窗口",
  });
  const pre = await s.call(CH.accountsPrecheck, "delete_one_with_window", [{ email: "a", browserId: "21" }]);
  assert.equal(pre.total, 1);
  assert.match(pre.confirms[0].message, /窗口 ID: 21/);

  const done = s.finished();
  const info = await s.call(CH.accountsStart, "delete_one_with_window", [{ email: "a", browserId: "21" }], OPTS);
  assert.equal(info.label, "删除账号和窗口");
  const e = await done;
  assert.deepEqual(e.result, { total: 1, deleted_accounts: 1, deleted_windows: 1, failed_count: 0, failed_list: [] });
  assert.deepEqual(
    s.ix.calls.map((c) => c.slice(0, 2)),
    [
      ["close", 21],
      ["delete", 21],
    ],
  );
  assert.equal(s.ctx.accountRepo().getAccountByEmail("a"), null);
});

test("batch_bind：两个大小写不同的邮箱匹配到同一窗口时只绑定第一个", async () => {
  const s = setup({ windows: [{ profile_id: 7, name: "a@x.com" }] });
  seed(s.ctx, [{ email: "a@x.com" }, { email: "A@X.com" }]);
  const rows = [
    { email: "a@x.com", browserId: "" },
    { email: "A@X.com", browserId: "" },
  ];
  const pre = await s.call(CH.accountsPrecheck, "batch_bind", rows);
  assert.equal(pre.total, 1);
  assert.equal(pre.confirms[0].message, "将绑定 1 个账号到对应窗口\n\n⚠️ 1 个窗口已被其他账号绑定（已跳过）\n\n是否继续？");
  const done = s.finished();
  await s.call(CH.accountsStart, "batch_bind", rows, OPTS);
  const e = await done;
  assert.deepEqual(e.result, { total: 1, success_count: 1, failed_count: 0, failed_list: [] });
  const boundA = s.ctx.accountRepo().getAccountByEmail("a@x.com");
  assert.ok(boundA);
  assert.equal(boundA.browser_profile_id, "7");
  const boundUpper = s.ctx.accountRepo().getAccountByEmail("A@X.com");
  assert.ok(boundUpper);
  assert.ok(!boundUpper.browser_profile_id);
});

test("start：仓储写库返回 false 时绑定 / 删除计为失败", async () => {
  const s = setup({ windows: [{ profile_id: 7, name: "a@x.com" }] });
  seed(s.ctx, [{ email: "a@x.com" }, { email: "d", browser_profile_id: "31" }]);
  const repo = s.ctx.accountRepo();
  repo.bindAccountToBrowser = () => false;
  repo.deleteAccount = () => false;

  let done = s.finished();
  await s.call(CH.accountsStart, "batch_bind", [{ email: "a@x.com", browserId: "" }], OPTS);
  let e = await done;
  assert.deepEqual(e.result, {
    total: 1,
    success_count: 0,
    failed_count: 1,
    failed_list: [{ email: "a@x.com", error: "写入数据库失败" }],
  });

  done = s.finished();
  await s.call(CH.accountsStart, "delete_with_windows", [{ email: "d", browserId: "31" }], OPTS);
  e = await done;
  assert.deepEqual(e.result, {
    total: 1,
    deleted_accounts: 0,
    deleted_windows: 0,
    failed_count: 1,
    failed_list: [{ email: "d", error: "数据库中未删除该账号" }],
  });
  // 账号没删掉 → 不碰窗口
  assert.equal(s.ix.calls.filter((c) => c[0] === "close" || c[0] === "delete").length, 0);
});

test("bind / unbind / deleteOne：有任务在跑时抛 TASK_BUSY", async () => {
  const s = setup();
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }]);
  /** @type {(value?: void) => void} */
  let release = () => {};
  s.ctx.tasks.start("x", "占位", () => new Promise((r) => (release = r)));
  /** @type {Array<[string, unknown[]]>} 通道与参数（数组字面量推断不出元组） */
  const busyCases = [
    [CH.accountsBind, ["a", "2"]],
    [CH.accountsUnbind, ["a"]],
    [CH.accountsDeleteOne, ["a"]],
  ];
  for (const [channel, args] of busyCases) {
    const env = await s.dispatch(channel, args);
    assert.equal(env.ok, false, channel);
    assert.equal(env.error.code, ERROR_CODES.TASK_BUSY, channel);
    assert.equal(env.error.message, "已有任务在执行中，请等待完成");
  }
  const boundRow = s.ctx.accountRepo().getAccountByEmail("a");
  assert.ok(boundRow);
  assert.equal(boundRow.browser_profile_id, "1");
  release();
});

test("requireRows：按 email 去重", async () => {
  const p = fakeProcessorFactory();
  const s = setup({ deps: { createProcessor: p.factory } });
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }]);
  const rows = [
    { email: "a", browserId: "1" },
    { email: "a", browserId: "1" },
  ];
  assert.equal((await s.call(CH.accountsPrecheck, "login", rows)).total, 1);
  // 单行操作重复行去重后仍算 1 行
  assert.equal((await s.call(CH.accountsPrecheck, "single_login", rows)).ok, true);
});

test("默认 createProcessor 注入了 db（批处理器拿到仓储，不打「未注入」告警）", () => {
  const s = setup();
  const msgs = [];
  const p = createDefaultProcessor(s.ctx, { concurrency: 2, callback: (m) => msgs.push(m) });
  assert.equal(p.concurrency, 2);
  // accountRepo 是批处理器的私有字段：这里要验证默认工厂确实把仓储注入进去了
  assert.ok(/** @type {Record<string, any>} */ (p).accountRepo);
  assert.equal(msgs.some((m) => m.includes("未注入")), false);
});

test("finishedNotice：照搬 Python 完成提示；failed / stopped 不弹", () => {
  /**
   * 构造任务结束事件：type / result 由用例给，extra 覆盖 label / outcome
   * @param {string} type
   * @param {unknown} result
   * @param {{ label?: string, outcome?: import("../app/shared/ipc.ts").TaskOutcome }} [extra]
   * @returns {Pick<import("../app/shared/ipc.ts").TaskFinishedEvent, "type" | "label" | "outcome" | "result">}
   */
  const ev = (type, result, extra = {}) => ({ type, label: "", outcome: "succeeded", result, ...extra });
  assert.deepEqual(finishedNotice(ev("batch_bind", { total: 3, success_count: 2 })), {
    title: "绑定完成",
    message: "成功绑定 2/3 个账号",
  });
  assert.deepEqual(finishedNotice(ev("batch_delete", { deleted_accounts: 2, deleted_windows: 1 }, { label: "删除选中" })), {
    title: "删除完成",
    message: "已删除 2 个账号",
  });
  assert.deepEqual(finishedNotice(ev("batch_delete", { deleted_accounts: 2, deleted_windows: 1 }, { label: "删除+窗口" })), {
    title: "删除完成",
    message: "已删除 2 个账号\n已删除 1 个窗口",
  });
  assert.equal(finishedNotice(ev("batch_bind", null, { outcome: "failed" })), null);
  assert.equal(finishedNotice(ev("batch_delete", {}, { outcome: "stopped" })), null);
  assert.equal(finishedNotice(ev("login", {})), null);
});

test("readLlmParams：照搬 get_config_from_manager —— 无 provider / 无 key 时全部为 null", () => {
  const cfg = (provider, key, model) => ({
    getAiDefaultProvider: () => provider,
    getAiProviderApiKey: () => key,
    getAiProviderModel: () => model,
  });
  assert.deepEqual(readLlmParams(cfg("", "k", "m")), { apiKey: null, model: null, provider: null });
  assert.deepEqual(readLlmParams(cfg("gemini", "", "m")), { apiKey: null, model: null, provider: null });
  assert.deepEqual(readLlmParams(cfg("gemini", "k", "m")), { apiKey: "k", model: "m", provider: "gemini" });
});

test("handler 工厂不打开数据库（惰性）", () => {
  const ctx = createHostContext({
    dataRoot: mkdtempSync(join(tmpdir(), "abb-accounts-test-")),
    emit: () => {},
    log: () => {},
    openDatabase: () => {
      throw new Error("不应打开数据库");
    },
  });
  // 账号管理页的通道分两张表登记（批量任务 / 账号数据），合起来恰好覆盖 ACCOUNTS_INVOKE，且互不重叠
  const tasks = Object.keys(createAccountsHandlers(ctx));
  const data = Object.keys(createAccountDataHandlers(ctx));
  assert.equal(tasks.filter((k) => data.includes(k)).length, 0);
  assert.deepEqual([...tasks, ...data].sort(), Object.values(ACCOUNTS_INVOKE).sort());
});

// ==================== 账号健康巡检（F2） ====================

/** 健康巡检的「正常」结论：对象字面量会把 status 放宽成 string，这里标注回字面量联合 */
/** @type {import("../src/application/health-check.ts").HealthCheckResult} */
const HC_OK = { status: "ok", message: "已登录", url: "https://myaccount.google.com/?hl=en", reason: "页面显示了该邮箱" };

test("health_check 是受支持的动作，预检通过后返回账号数", async () => {
  assert.ok(ACCOUNTS_ACTIONS.includes("health_check"));
  const s = setup();
  seed(s.ctx, [{ email: "a@x.com", browser_profile_id: "11" }]);
  const pre = await s.call(CH.accountsPrecheck, "health_check", [{ email: "a@x.com", browserId: "11" }]);
  assert.deepEqual(pre, { ok: true, confirms: [], logs: [], total: 1 });
});

test("health_check：未选择账号时提示；已有任务在跑时拒绝", async () => {
  const s = setup();
  assert.deepEqual(await s.call(CH.accountsPrecheck, "health_check", []), {
    ok: false,
    level: "info",
    title: "提示",
    message: "请先选择要巡检的账号",
  });

  seed(s.ctx, [{ email: "a@x.com", browser_profile_id: "11" }]);
  /** @type {(value?: void) => void} */
  let release = () => {};
  s.ctx.tasks.start("x", "占位任务", () => new Promise((r) => (release = r)));
  const busy = await s.call(CH.accountsPrecheck, "health_check", [{ email: "a@x.com", browserId: "11" }]);
  assert.deepEqual(busy, {
    ok: false,
    level: "warning",
    title: "警告",
    message: "已有任务在执行中，请等待完成后再巡检",
  });
  release();
});

test("health_check：后台任务逐个巡检、统计四种结论、上报逐条目", async () => {
  const calls = [];
  const answers = {
    "a@x.com": HC_OK,
    "b@x.com": { status: "need_login", message: "需要登录", url: "", reason: "" },
    "c@x.com": { status: "suspended", message: "账号已被停用", url: "", reason: "" },
  };
  const s = setup({
    deps: {
      healthCheck: async (browserId, account) => {
        calls.push([browserId, account.email]);
        // 值形状就是 HealthCheckResult：对象字面量里 status 会放宽成 string，这里断言回字面量联合
        return /** @type {import("../src/application/health-check.ts").HealthCheckResult} */ (answers[account.email]);
      },
    },
  });
  seed(s.ctx, [
    { email: "a@x.com", browser_profile_id: "11" },
    { email: "b@x.com", browser_profile_id: "12" },
    { email: "c@x.com", browser_profile_id: "13" },
  ]);
  const rows = [
    { email: "a@x.com", browserId: "11" },
    { email: "b@x.com", browserId: "12" },
    { email: "c@x.com", browserId: "13" },
  ];

  const done = s.finished();
  const info = await s.call(CH.accountsStart, "health_check", rows, OPTS);
  assert.equal(info.type, "health_check");
  const e = await done;
  assert.equal(e.outcome, "succeeded");
  assert.equal(e.result.total, 3);
  assert.equal(e.result.ok, 1);
  assert.equal(e.result.need_login, 1);
  assert.equal(e.result.suspended, 1);
  assert.equal(e.result.window_error, 0);
  assert.deepEqual(calls, [["11", "a@x.com"], ["12", "b@x.com"], ["13", "c@x.com"]]);
  assert.deepEqual(s.items(), [
    ["a@x.com", "成功", "已登录"],
    ["b@x.com", "失败", "需要登录"],
    ["c@x.com", "失败", "账号已被停用"],
  ]);
  assert.ok(s.logs().includes("巡检完成: 正常 1，需要登录 1，已停用 1，窗口异常 0"));
  assert.ok(s.events.some(([c, p]) => c === IPC.event.taskProgress && p.current === 3 && p.total === 3));
  // 只读承诺：巡检不动 ixBrowser（不开关窗口、不删不改）
  assert.deepEqual(s.ix.calls, []);
});

test("health_check：未绑定窗口的账号记 window_error，不去连引擎；某个账号抛错也不影响后面的", async () => {
  const calls = [];
  const s = setup({
    deps: {
      healthCheck: async (browserId, account) => {
        calls.push(account.email);
        if (account.email === "b@x.com") throw new Error("Target closed");
        return HC_OK;
      },
    },
  });
  seed(s.ctx, [
    { email: "a@x.com" },
    { email: "b@x.com", browser_profile_id: "12" },
    { email: "c@x.com", browser_profile_id: "13" },
  ]);
  const rows = [
    { email: "a@x.com", browserId: "" },
    { email: "b@x.com", browserId: "12" },
    { email: "c@x.com", browserId: "13" },
  ];

  const done = s.finished();
  await s.call(CH.accountsStart, "health_check", rows, OPTS);
  const e = await done;
  assert.deepEqual(calls, ["b@x.com", "c@x.com"], "未绑定窗口的账号不应调用巡检");
  assert.equal(e.result.window_error, 2);
  assert.equal(e.result.ok, 1);
  assert.deepEqual(s.items(), [
    ["a@x.com", "错误", "未绑定窗口"],
    ["b@x.com", "错误", "窗口打不开: Target closed"],
    ["c@x.com", "成功", "已登录"],
  ]);
});

test("finishedNotice：巡检完成弹汇总（成功才弹）", () => {
  const notice = finishedNotice({
    type: "health_check",
    label: "健康巡检（3 个账号）",
    outcome: "succeeded",
    result: { total: 3, ok: 1, need_login: 1, suspended: 0, window_error: 1 },
  });
  assert.deepEqual(notice, {
    title: "巡检完成",
    message: "正常 1 个\n需要登录 1 个\n已停用 0 个\n窗口异常 1 个",
  });
  assert.equal(
    finishedNotice({ type: "health_check", label: "x", outcome: "stopped", result: {} }),
    null,
  );
});

// ==================== 渲染层纯函数 ====================

const row = (o) => ({
  email: "x",
  login_status: "not_logged",
  last_error: null,
  browser_profile_id: "",
  window_name: "",
  group_id: -1,
  group_name: "未绑定窗口",
  has_password: false,
  has_recovery_email: false,
  has_secret: false,
  last_login_at: null,
  updated_at: null,
  ...o,
});

test("登录状态文案与颜色（:505-523）", () => {
  const long = "123456789012345678901234";
  assert.deepEqual(loginView(row({ login_status: "login_failed", last_error: long })), {
    text: "失败: 12345678901234567890...",
    color: "#F44336",
    tooltip: `错误原因: ${long}`,
  });
  assert.equal(loginView(row({ login_status: "login_failed" })).text, "失败");
  assert.equal(loginView(row({ login_status: null })).text, "未登录");
  assert.equal(loginView(row({ login_status: "weird" })).text, "weird");
});

test("filterAccounts：分组 / 登录状态 / 搜索（邮箱包含、窗口ID 前缀、窗口名包含）叠加；无条件原样返回", () => {
  const rows = [
    row({ email: "Alice@X.com", login_status: "logged_in", browser_profile_id: "101", window_name: "win-a", group_id: 2 }),
    row({ email: "bob@x.com", login_status: "login_failed", last_error: "x", browser_profile_id: "1010", window_name: "店铺B", group_id: 2 }),
    row({ email: "carol@x.com", login_status: null, group_id: -1 }),
    row({ email: "dave@x.com", login_status: "not_logged", browser_profile_id: "203", group_id: 3 }),
    row({ email: "eve@x.com", login_status: "logging_in", browser_profile_id: "204", group_id: 3 }),
  ];
  const q = (o) => ({ groupId: null, login: "all", text: "", ...o });
  const emails = (list) => list.map((r) => r.email);
  assert.equal(filterAccounts(rows, q({})), rows);
  assert.deepEqual(emails(filterAccounts(rows, q({ login: "logged_in" }))), ["Alice@X.com"]);
  assert.deepEqual(emails(filterAccounts(rows, q({ login: "login_failed" }))), ["bob@x.com"]);
  assert.deepEqual(emails(filterAccounts(rows, q({ login: "not_logged" }))), ["carol@x.com", "dave@x.com"], "空与 not_logged 都算未登录");
  assert.deepEqual(emails(filterAccounts(rows, q({ groupId: -1 }))), ["carol@x.com"]);
  assert.deepEqual(emails(filterAccounts(rows, q({ text: "  ALICE " }))), ["Alice@X.com"]);
  assert.deepEqual(emails(filterAccounts(rows, q({ text: "101" }))), ["Alice@X.com", "bob@x.com"], "窗口ID 前缀");
  assert.deepEqual(emails(filterAccounts(rows, q({ text: "店铺" }))), ["bob@x.com"], "窗口名");
  assert.deepEqual(emails(filterAccounts(rows, q({ groupId: 2, login: "logged_in", text: "win" }))), ["Alice@X.com"]);
  assert.deepEqual(countLogin(rows), { all: 5, logged_in: 1, not_logged: 2, login_failed: 1 });
});

test("accountSorter：模拟 antd（降序时把结果取反），未绑定窗口 / 从未登录的空值无论升降序都在最后", () => {
  const rows = [
    row({ email: "b@x.com", browser_profile_id: "20", last_login_at: "2026-09-20 08:00:00" }),
    row({ email: "a@x.com", browser_profile_id: "", last_login_at: null }),
    row({ email: "C@x.com", browser_profile_id: "9", last_login_at: "2026-09-23 16:14:36" }),
  ];
  const antd = (key, order) =>
    [...rows]
      .sort((x, y) => {
        const r = accountSorter(key)(x, y, order);
        return order === "descend" ? -r : r;
      })
      .map((r) => r.email);
  assert.deepEqual(antd("windowId", "ascend"), ["C@x.com", "b@x.com", "a@x.com"], "数值比较：9 < 20");
  assert.deepEqual(antd("windowId", "descend"), ["b@x.com", "C@x.com", "a@x.com"]);
  assert.deepEqual(antd("lastLogin", "descend"), ["C@x.com", "b@x.com", "a@x.com"]);
  assert.deepEqual(antd("lastLogin", "ascend"), ["b@x.com", "C@x.com", "a@x.com"]);
  assert.deepEqual(antd("email", "ascend"), ["a@x.com", "b@x.com", "C@x.com"], "不区分大小写");
});
