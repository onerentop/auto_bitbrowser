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
import {
  applyLoginItem,
  applyNoteUpdate,
  applyTagsUpdate,
  accountSorter,
  autoBindNotice,
  countLogin,
  defaultBindSelection,
  filterAccounts,
  hasSameNameWindows,
} from "../app/shared/logic/account-list.ts";

const CH = ACCOUNTS_INVOKE;

/**
 * 假 ixBrowser 客户端（只实现账号页用到的部分）
 * @param {Array<{ profile_id: number, name: string, group_id?: number, note?: string, tag_id?: string }>} windows
 * @param {{ fail?: boolean, tags?: Array<{ id: number, title: string, color: string }>, tagFail?: boolean }} [options]
 */
function fakeIx(windows, { fail = false, tags = [], tagFail = false } = {}) {
  // 词表可变：createTag / deleteTag 会真的改它，模拟 ixBrowser 的行为
  /** @type {Array<{ id: number, title: string, color: string }>} */
  const vocabulary = tags.map((t) => ({ ...t }));
  let nextTagId = 900001;
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
    async updateProfile(profileId, fields) {
      calls.push(["updateProfile", profileId, fields]);
      return true;
    },
    vocabulary,
    async getTagList(q) {
      calls.push(["tagList", q]);
      if (tagFail) throw new Error("connect ECONNREFUSED 127.0.0.1:53200");
      return { total: vocabulary.length, data: vocabulary.map((t) => ({ ...t })) };
    },
    async createTag(title) {
      calls.push(["createTag", title]);
      const id = nextTagId++;
      vocabulary.push({ id, title, color: "#67C23A" });
      return id;
    },
    async updateTag(id, title) {
      calls.push(["updateTag", id, title]);
      const t = vocabulary.find((x) => x.id === id);
      if (t) t.title = title;
    },
    async deleteTag(id) {
      calls.push(["deleteTag", id]);
      const i = vocabulary.findIndex((x) => x.id === id);
      if (i >= 0) vocabulary.splice(i, 1);
    },
  };
}

/**
 * 建上下文：临时数据根（不碰仓库根的 config.json / accounts.db）、:memory: 库
 * @param {{ windows?: Array<{ profile_id: number, name: string, group_id?: number, note?: string, tag_id?: string }>, tags?: Array<{ id: number, title: string, color: string }>, ixFail?: boolean, tagFail?: boolean, deps?: import("../app/host/handlers/accounts.ts").AccountsHandlerDeps }} [options]
 */
function setup({ windows = [], tags = [], ixFail = false, tagFail = false, deps = {} } = {}) {
  const events = [];
  const waiters = [];
  const ix = fakeIx(windows, { fail: ixFail, tags, tagFail });
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
  const handlers = {
    ...createAccountsHandlers(ctx, { sleep: async () => {}, ...deps }),
    ...createAccountDataHandlers(ctx, { sleep: async () => {} }),
  };
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

test("list：下发明文密码；2FA 密钥与辅助邮箱原文仍不下发", async () => {
  const s = setup();
  s.ctx.accountRepo().upsertAccount({ email: "a@x.com", password: "PW-SECRET-1", recovery_email: "rec@y.com", secret_key: "TOTPKEYXYZ" });
  s.ctx.accountRepo().upsertAccount({ email: "b@x.com" });
  const r = await s.call(CH.accountsList);
  const by = Object.fromEntries(r.rows.map((x) => [x.email, x]));
  assert.deepEqual([by["a@x.com"].has_password, by["a@x.com"].has_recovery_email, by["a@x.com"].has_secret], [true, true, true]);
  assert.deepEqual([by["b@x.com"].has_password, by["b@x.com"].has_recovery_email, by["b@x.com"].has_secret], [false, false, false]);
  // 用户要求列表直接显示密码（可复制），因此密码明文下发；没有密码时为空串
  assert.equal(by["a@x.com"].password, "PW-SECRET-1");
  assert.equal(by["b@x.com"].password, "");
  // 密钥与辅助邮箱原文仍然不下发
  const json = JSON.stringify(r);
  for (const secret of ["rec@y.com", "TOTPKEYXYZ"]) assert.ok(!json.includes(secret), `不应下发 ${secret}`);
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
  const added = await s.call(CH.accountsAdd, { email: " a@b.com ", password: " pw ", recovery_email: "r@x.com", secret_key: "S" });
  assert.deepEqual(added, { bound: 0, ambiguous: [], notFound: ["a@b.com"], failed: [], alreadyBound: 0, error: null }, "没有同名窗口");
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
  assert.deepEqual(r, {
    success_count: 2,
    fail_count: 0,
    bind: { bound: 0, ambiguous: [], notFound: ["a@b.com", "n@m.com"], failed: [], alreadyBound: 0, error: null },
  });
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

test("自动绑定：导入后按窗口名绑定——唯一同名才绑、同名多个不猜、被占用的不用、已绑定不动", async () => {
  const s = setup({
    windows: [
      { profile_id: 11, name: " A@b.com " },
      { profile_id: 21, name: "dup@x.com" },
      { profile_id: 22, name: "dup@x.com" },
      { profile_id: 31, name: "taken@x.com" },
      { profile_id: 41, name: "old@x.com" },
    ],
  });
  seed(s.ctx, [
    { email: "owner@x.com", browser_profile_id: "31" },
    { email: "old@x.com", browser_profile_id: "99" },
  ]);
  const r = await s.call(
    CH.accountsImport,
    ["a@b.com----p", "dup@x.com----p", "taken@x.com----p", "old@x.com----p", "none@x.com----p"].join("\n"),
  );
  assert.deepEqual(r.bind, {
    bound: 1,
    ambiguous: [{ email: "dup@x.com", windowIds: ["21", "22"] }],
    notFound: ["taken@x.com", "none@x.com"],
    failed: [],
    alreadyBound: 1,
    error: null,
  });
  const bound = (/** @type {string} */ e) => s.ctx.accountRepo().getAccountByEmail(e)?.browser_profile_id ?? null;
  assert.equal(bound("a@b.com"), "11");
  assert.equal(bound("dup@x.com"), null, "同名多个不猜");
  assert.equal(bound("taken@x.com"), null);
  assert.equal(bound("old@x.com"), "99", "已绑定不动");

  // 列表标出同名窗口个数
  const list = await s.call(CH.accountsList);
  const by = Object.fromEntries(list.rows.map((x) => [x.email, x]));
  assert.deepEqual([by["dup@x.com"].same_name_windows, by["a@b.com"].same_name_windows, by["none@x.com"].same_name_windows], [2, 1, 0]);
});

test("自动绑定：添加账号后绑定唯一同名窗口；ixBrowser 不可达时账号照样保存，只在结果里记 error", async () => {
  const s = setup({ windows: [{ profile_id: 5, name: "new@x.com" }] });
  const r = await s.call(CH.accountsAdd, { email: "new@x.com", password: "p", recovery_email: "", secret_key: "" });
  assert.equal(r.bound, 1);
  assert.equal(s.ctx.accountRepo().getAccountByEmail("new@x.com")?.browser_profile_id, "5");

  const s2 = setup({ ixFail: true });
  const r2 = await s2.call(CH.accountsAdd, { email: "new@x.com", password: "p", recovery_email: "", secret_key: "" });
  assert.match(r2.error, /ECONNREFUSED/);
  assert.equal(r2.bound, 0);
  assert.ok(s2.ctx.accountRepo().getAccountByEmail("new@x.com"), "取窗口失败不影响添加");
  const r3 = await s2.call(CH.accountsImport, "imp@x.com----p");
  assert.equal(r3.success_count, 1);
  assert.match(r3.bind.error, /ECONNREFUSED/);
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
  // 已删除的操作一律视为未知操作（batch_bind 已由导入 / 添加后的自动绑定取代）
  for (const removed of ["oauth", "single_oauth", "login_and_oauth", "detect_pro", "refresh_membership_info", "enable_family_sharing", "detect_403", "unlock_403", "batch_bind"]) {
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
        // 与真实批处理器一致：每个账号结束时回调（进度 / 条目 / 关窗都靠它）
        for (const x of a) opts.onAccountDone?.(x.email, "success", "");
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
  // 进度由逐账号回调驱动（不再解析日志）
  assert.ok(s.events.some(([c, p2]) => c === IPC.event.taskProgress && p2.current === 1 && p2.total === 1));
  // 批量登录按账号上报条目（任务历史的逐条目来源）
  assert.deepEqual(s.items(), [["a", "成功", ""]]);
});

test("start：批量登录只关成功账号的窗口，失败的保留；closeWindow=false 时一个都不关", async () => {
  /** 逐账号结果由替身决定：a 成功、b 失败 */
  const factory = (opts) => ({
    async batchLogin() {
      opts.onAccountDone?.("a", "success", "");
      opts.onAccountDone?.("b", "failed", "需要验证码");
      return createBatchResult({
        total: 2,
        success_count: 1,
        failed_count: 1,
        results: [
          { email: "a", status: "success" },
          { email: "b", status: "failed", error: "需要验证码" },
        ],
      });
    },
    stop() {},
  });
  const rows = [
    { email: "a", browserId: "11" },
    { email: "b", browserId: "22" },
  ];
  const seeded = () => [
    { email: "a", browser_profile_id: "11" },
    { email: "b", browser_profile_id: "22" },
  ];

  const s = setup({ deps: { createProcessor: factory } });
  seed(s.ctx, seeded());
  const done = s.finished();
  await s.call(CH.accountsStart, "login", rows, OPTS);
  await done;
  // 关窗走 ixBrowser closeProfile（只关成功的那个）
  assert.deepEqual(s.ix.calls.map((c) => c.slice(0, 2)), [["close", 11]]);
  assert.deepEqual(s.items(), [
    ["a", "成功", ""],
    ["b", "失败", "需要验证码"],
  ]);
  const progress = s.events.filter(([c]) => c === IPC.event.taskProgress).map(([, p]) => [p.current, p.total]);
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]], "进度按账号计数，不按日志行数");

  const s2 = setup({ deps: { createProcessor: factory } });
  seed(s2.ctx, seeded());
  const done2 = s2.finished();
  await s2.call(CH.accountsStart, "login", rows, { concurrency: 2, closeWindow: false });
  await done2;
  assert.deepEqual(s2.ix.calls, [], "取消勾选后一个窗口都不关");
});

test("start：跳过的账号不计进度、不关窗，但仍上报条目", async () => {
  const factory = (opts) => ({
    async batchLogin() {
      opts.onAccountDone?.("a", "success", "");
      opts.onAccountDone?.("b", "skipped", "用户停止");
      return createBatchResult({ total: 2, success_count: 1, skipped_count: 1 });
    },
    stop() {},
  });
  const s = setup({ deps: { createProcessor: factory } });
  seed(s.ctx, [
    { email: "a", browser_profile_id: "11" },
    { email: "b", browser_profile_id: "22" },
  ]);
  const done = s.finished();
  await s.call(CH.accountsStart, "login", [
    { email: "a", browserId: "11" },
    { email: "b", browserId: "22" },
  ], OPTS);
  await done;
  const progress = s.events.filter(([c]) => c === IPC.event.taskProgress).map(([, p]) => [p.current, p.total]);
  assert.deepEqual(progress, [[0, 2], [1, 2]], "跳过只上报条目，不计进度");
  assert.deepEqual(s.items(), [
    ["a", "成功", ""],
    ["b", "跳过", "用户停止"],
  ]);
  assert.deepEqual(s.ix.calls.map((c) => c.slice(0, 2)), [["close", 11]]);
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

// ==================== 单条操作 ====================

test("bindCandidates / bind（重新绑定）/ deleteOne", async () => {
  const s = setup({
    windows: [
      { profile_id: 1, name: "w1" },
      { profile_id: 2, name: "w2" },
      { profile_id: 3, name: "" },
      { profile_id: 4, name: "c" },
    ],
  });
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }, { email: "b", browser_profile_id: "2" }, { email: "c" }]);

  // a 自己绑定的窗口 1 可选；窗口 2 被 b 占用 → 排除
  const cand = await s.call(CH.accountsBindCandidates, "a");
  assert.equal(cand.currentBrowserId, "1");
  assert.equal(cand.windowCount, 4);
  assert.deepEqual(cand.available, [
    { profileId: "1", name: "w1", sameName: false },
    { profileId: "3", name: "未命名", sameName: false },
    { profileId: "4", name: "c", sameName: false },
  ]);
  // 与邮箱同名的窗口排最前并标注
  const candC = await s.call(CH.accountsBindCandidates, "c");
  assert.deepEqual(
    candC.available.map((/** @type {any} */ o) => [o.profileId, o.sameName]),
    [
      ["4", true],
      ["3", false],
    ],
  );

  // 绑定到被其它账号占用的窗口 → 拒绝
  const env = await s.dispatch(CH.accountsBind, ["c", "2"]);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, ERROR_CODES.INVALID_ARGUMENT);

  assert.deepEqual(await s.call(CH.accountsBind, "a", "3"), { email: "a", browserId: "3", previousBrowserId: "1" });
  const rebound = s.ctx.accountRepo().getAccountByEmail("a");
  assert.ok(rebound);
  assert.equal(rebound.browser_profile_id, "3");

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

test("start：仓储写库返回 false 时删除计为失败", async () => {
  const s = setup();
  seed(s.ctx, [{ email: "d", browser_profile_id: "31" }]);
  const repo = s.ctx.accountRepo();
  repo.deleteAccount = () => false;

  const done = s.finished();
  await s.call(CH.accountsStart, "delete_with_windows", [{ email: "d", browserId: "31" }], OPTS);
  const e = await done;
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

test("bind / deleteOne：有任务在跑时抛 TASK_BUSY", async () => {
  const s = setup();
  seed(s.ctx, [{ email: "a", browser_profile_id: "1" }]);
  /** @type {(value?: void) => void} */
  let release = () => {};
  s.ctx.tasks.start("x", "占位", () => new Promise((r) => (release = r)));
  /** @type {Array<[string, unknown[]]>} 通道与参数（数组字面量推断不出元组） */
  const busyCases = [
    [CH.accountsBind, ["a", "2"]],
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

test("自动绑定：有任务在跑时添加 / 导入照常保存账号，但不自动绑定窗口", async () => {
  const s = setup({ windows: [{ profile_id: 5, name: "new@x.com" }, { profile_id: 6, name: "imp@x.com" }] });
  /** @type {(value?: void) => void} */
  let release = () => {};
  s.ctx.tasks.start("x", "占位", () => new Promise((r) => (release = r)));
  const r = await s.call(CH.accountsAdd, { email: "new@x.com", password: "p", recovery_email: "", secret_key: "" });
  assert.equal(r.bound, 0);
  assert.match(r.error, /有任务正在执行/);
  const i = await s.call(CH.accountsImport, "imp@x.com----p");
  assert.equal(i.success_count, 1);
  assert.match(i.bind.error, /有任务正在执行/);
  for (const e of ["new@x.com", "imp@x.com"]) {
    const a = s.ctx.accountRepo().getAccountByEmail(e);
    assert.ok(a, `${e} 已保存`);
    assert.ok(!a.browser_profile_id, `${e} 未绑定`);
  }
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
  assert.equal(finishedNotice(ev("batch_bind", { total: 3, success_count: 2 })), null, "批量绑定已删除");
  assert.deepEqual(finishedNotice(ev("batch_delete", { deleted_accounts: 2, deleted_windows: 1 }, { label: "删除选中" })), {
    title: "删除完成",
    message: "已删除 2 个账号",
  });
  assert.deepEqual(finishedNotice(ev("batch_delete", { deleted_accounts: 2, deleted_windows: 1 }, { label: "删除+窗口" })), {
    title: "删除完成",
    message: "已删除 2 个账号\n已删除 1 个窗口",
  });
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
  password: "",
  note: "",
  tags: [],
  last_login_at: null,
  same_name_windows: 0,
  updated_at: null,
  ...o,
});

test("登录状态：文字 + 色调 + 失败原因（原因原样给出，截断交给界面单行省略）", () => {
  const long = "123456789012345678901234";
  assert.deepEqual(loginView(row({ login_status: "login_failed", last_error: long })), {
    text: "失败",
    tone: "bad",
    reason: long,
  });
  assert.deepEqual(loginView(row({ login_status: "login_failed" })), { text: "失败", tone: "bad", reason: null });
  assert.deepEqual(loginView(row({ login_status: "logged_in", last_error: "旧错误" })), { text: "已登录", tone: "ok", reason: null });
  assert.deepEqual(loginView(row({ login_status: "logging_in" })), { text: "登录中", tone: "busy", reason: null });
  assert.deepEqual(loginView(row({ login_status: null })), { text: "未登录", tone: "none", reason: null });
  assert.deepEqual(loginView(row({ login_status: "weird" })), { text: "weird", tone: "none", reason: null });
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

test("filterAccounts：只看同名窗口（≥2 个）可与其它条件叠加", () => {
  const rows = [
    row({ email: "a@x.com", same_name_windows: 2, group_id: 2 }),
    row({ email: "b@x.com", same_name_windows: 1, group_id: 2 }),
    row({ email: "c@x.com", same_name_windows: 3, group_id: 3 }),
  ];
  const q = (o) => ({ groupId: null, login: "all", text: "", ...o });
  const emails = (list) => list.map((r) => r.email);
  assert.deepEqual(emails(filterAccounts(rows, q({ sameNameOnly: true }))), ["a@x.com", "c@x.com"]);
  assert.deepEqual(emails(filterAccounts(rows, q({ sameNameOnly: true, groupId: 3 }))), ["c@x.com"]);
  assert.equal(filterAccounts(rows, q({ sameNameOnly: false })), rows);
  assert.equal(hasSameNameWindows(row({ same_name_windows: 1 })), false);
});

test("defaultBindSelection：当前绑定 → 唯一同名 → 不选", () => {
  const o = (profileId, sameName) => ({ profileId, sameName });
  assert.equal(defaultBindSelection([o("1", false), o("2", true)], "1"), "1", "重新绑定时默认当前窗口");
  assert.equal(defaultBindSelection([o("1", false), o("2", true)], ""), "2", "唯一同名");
  assert.equal(defaultBindSelection([o("1", false), o("2", true)], "9"), "2", "当前窗口不在候选里时看同名");
  assert.equal(defaultBindSelection([o("2", true), o("3", true)], ""), null, "同名多个不猜");
  assert.equal(defaultBindSelection([o("1", false)], ""), null, "没有同名不默认第一个");
});

test("autoBindNotice：成功 / 需要处理 / 取窗口失败 / 无事可报", () => {
  const base = { bound: 0, ambiguous: [], notFound: [], failed: [], alreadyBound: 0, error: null };
  assert.equal(autoBindNotice({ ...base, alreadyBound: 3 }), null);
  assert.deepEqual(autoBindNotice({ ...base, bound: 2 }), { level: "success", title: "自动绑定窗口", text: "已自动绑定 2 个账号" });
  const w = autoBindNotice({
    ...base,
    bound: 1,
    ambiguous: [{ email: "d@x.com", windowIds: ["1", "2"] }],
    notFound: ["a", "b", "c", "d", "e", "f"],
  });
  assert.ok(w);
  assert.equal(w.level, "warning");
  assert.equal(
    w.text,
    "已自动绑定 1 个账号\n1 个账号有多个同名窗口，需要右键「绑定窗口」手动选择：d@x.com\n6 个账号没找到同名窗口：a、b、c、d、e 等 6 个",
  );
  const e = autoBindNotice({ ...base, error: "获取窗口列表失败：ECONNREFUSED" });
  assert.ok(e);
  assert.equal(e.level, "warning");
  assert.match(e.text, /ECONNREFUSED/);
});

test("applyLoginItem：成功 / 失败 / 跳过就地更新行；未匹配或状态未知时原样返回", () => {
  const rows = [row({ email: "a@x.com", login_status: "logging_in" }), row({ email: "b@x.com" })];
  const item = (key, status, message = "") => ({ key, status, message });
  const ok = applyLoginItem(rows, item("a@x.com", "成功"));
  assert.notEqual(ok, rows, "内容变化时返回新数组");
  assert.deepEqual(
    ok.map((r) => [r.email, r.login_status, r.last_error]),
    [
      ["a@x.com", "logged_in", null],
      ["b@x.com", "not_logged", null],
    ],
  );

  const failed = applyLoginItem(rows, item("b@x.com", "失败", "需要验证码"));
  assert.deepEqual(
    failed.map((r) => [r.email, r.login_status, r.last_error]),
    [
      ["a@x.com", "logging_in", null],
      ["b@x.com", "login_failed", "需要验证码"],
    ],
  );

  assert.equal(applyLoginItem(rows, item("a@x.com", "跳过")), rows, "跳过不动那一行");
  assert.equal(applyLoginItem(rows, item("ghost@x.com", "成功")), rows, "邮箱不在列表里");
  assert.equal(applyLoginItem(rows, item("a@x.com", "怪状态")), rows, "状态不认识");
});

// ==================== 密码 / 验证码 / 备注 ====================

test("list：备注来自窗口（与首页同一份）；未绑定窗口的账号为空串", async () => {
  const s = setup({ windows: [{ profile_id: 101, name: "win-a", note: "历史密码: abc" }] });
  seed(s.ctx, [
    { email: "a@x.com", browser_profile_id: "101" },
    { email: "b@x.com" },
  ]);
  const r = await s.call(CH.accountsList);
  const by = Object.fromEntries(r.rows.map((x) => [x.email, x]));
  assert.equal(by["a@x.com"].note, "历史密码: abc");
  assert.equal(by["b@x.com"].note, "");
});

test("tfaCodes：按数据库密钥算验证码；非法密钥进 invalid；无密钥不出现；只回码不回密钥", async () => {
  const s = setup();
  s.ctx.accountRepo().upsertAccount({ email: "ok@x.com", secret_key: "JBSWY3DPEHPK3PXP" });
  s.ctx.accountRepo().upsertAccount({ email: "padded@x.com", secret_key: " JBSW Y3DP EHPK 3PXP " });
  s.ctx.accountRepo().upsertAccount({ email: "bad@x.com", secret_key: "!!!!" });
  s.ctx.accountRepo().upsertAccount({ email: "none@x.com" });
  const r = await s.call(CH.accountsTfaCodes, ["ok@x.com", "padded@x.com", "bad@x.com", "none@x.com", "ghost@x.com", "ok@x.com"]);
  assert.match(r.codes["ok@x.com"], /^\d{6}$/);
  assert.equal(r.codes["padded@x.com"], r.codes["ok@x.com"], "密钥里的空白先去掉");
  assert.deepEqual(r.invalid, ["bad@x.com"]);
  assert.equal(r.codes["none@x.com"], undefined, "没有密钥的账号不出现在结果里");
  assert.equal(r.codes["ghost@x.com"], undefined);
  assert.ok(r.periodEndsAt > Date.now(), "给出本周期结束时间，界面据此重取");
  assert.deepEqual(Object.keys(r).sort(), ["codes", "invalid", "periodEndsAt"], "绝不回密钥");

  const bad = (/** @type {any} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT;
  await assert.rejects(s.call(CH.accountsTfaCodes, 42), bad);
  await assert.rejects(s.call(CH.accountsTfaCodes, ["a", 1]), bad);
  await assert.rejects(s.call(CH.accountsTfaCodes, [""]), bad);
  await assert.rejects(s.call(CH.accountsTfaCodes, Array.from({ length: 1001 }, (_, i) => `e${i}@x.com`)), bad, "超过上限");
});

test("updateNote：只写 note 一个字段；未绑定窗口 / 参数非法一律拒绝", async () => {
  const s = setup();
  seed(s.ctx, [
    { email: "a@x.com", browser_profile_id: "101" },
    { email: "b@x.com" },
  ]);
  assert.equal(await s.call(CH.accountsUpdateNote, "a@x.com", "第一行\n第二行"), true);
  assert.deepEqual(s.ix.calls, [["updateProfile", 101, { note: "第一行\n第二行" }]], "只传 note，不碰 tfa_secret / name");

  const bad = (/** @type {any} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT;
  await assert.rejects(s.call(CH.accountsUpdateNote, "b@x.com", "x"), bad, "未绑定窗口");
  await assert.rejects(s.call(CH.accountsUpdateNote, "ghost@x.com", "x"), bad);
  await assert.rejects(s.call(CH.accountsUpdateNote, "a@x.com", 42), bad);
  await assert.rejects(s.call(CH.accountsUpdateNote, "a@x.com", "x".repeat(2001)), bad, "太长");
  await assert.rejects(s.call(CH.accountsUpdateNote, "", "x"), bad);
  assert.equal(s.ix.calls.length, 1, "失败的调用不应碰到 ixBrowser");
});

test("applyNoteUpdate：只改那一行；邮箱不在列表里时原样返回", () => {
  const rows = [row({ email: "a@x.com", note: "旧备注" }), row({ email: "b@x.com" })];
  const next = applyNoteUpdate(rows, "a@x.com", "新备注\n第二行");
  assert.notEqual(next, rows);
  assert.deepEqual(
    next.map((r) => [r.email, r.note]),
    [
      ["a@x.com", "新备注\n第二行"],
      ["b@x.com", ""],
    ],
  );
  assert.equal(applyNoteUpdate(rows, "ghost@x.com", "x"), rows);
});

// ==================== 标签（ixBrowser 的标签，同步） ====================

const VOCAB = [
  { id: 142399, title: "已修改2fa", color: "#67C23A" },
  { id: 140180, title: "已使用", color: "#67C23A" },
  { id: 151612, title: "Google Cloud不可用", color: "#67C23A" },
];

test("list：标签由窗口 tag_id + 词表映射（标题含空格也不受影响）；词表失败只记 tagError", async () => {
  const s = setup({
    windows: [
      { profile_id: 101, name: "win-a", tag_id: "142399 151612" },
      { profile_id: 102, name: "win-b", tag_id: "" },
    ],
    tags: VOCAB,
  });
  seed(s.ctx, [
    { email: "a@x.com", browser_profile_id: "101" },
    { email: "b@x.com", browser_profile_id: "102" },
    { email: "c@x.com" },
  ]);
  const r = await s.call(CH.accountsList);
  const by = Object.fromEntries(r.rows.map((x) => [x.email, x]));
  assert.deepEqual(
    by["a@x.com"].tags.map((t) => [t.id, t.title]),
    [
      [142399, "已修改2fa"],
      [151612, "Google Cloud不可用"],
    ],
    "按 tag_id 取词表项；标题里的空格不影响解析",
  );
  assert.deepEqual(by["b@x.com"].tags, [], "窗口没有标签");
  assert.deepEqual(by["c@x.com"].tags, [], "账号未绑定窗口");
  assert.equal(r.tagError, null);
  assert.deepEqual(r.tags.map((t) => t.id), [142399, 140180, 151612], "词表随列表一起下发");
  // 词表请求应与分组 / 窗口并发（同一批 Promise.all）
  assert.equal(s.ix.calls.filter((c) => c[0] === "tagList").length, 1);

  const s2 = setup({ windows: [{ profile_id: 101, name: "win-a", tag_id: "142399" }], tags: VOCAB, tagFail: true });
  seed(s2.ctx, [{ email: "a@x.com", browser_profile_id: "101" }]);
  const r2 = await s2.call(CH.accountsList);
  assert.match(r2.tagError, /ECONNREFUSED/);
  assert.deepEqual(r2.tags, []);
  assert.deepEqual(r2.rows[0].tags, [], "词表取不到时不显示半个标签");
});

test("setTags：只写 tag 一个字段、值是标签名数组；未绑定窗口 / 未知标签 / 非法参数一律拒绝", async () => {
  const s = setup({ tags: VOCAB });
  seed(s.ctx, [
    { email: "a@x.com", browser_profile_id: "101" },
    { email: "b@x.com" },
  ]);
  assert.equal(await s.call(CH.accountsSetTags, "a@x.com", [151612, 142399]), true);
  assert.deepEqual(
    s.ix.calls.filter((c) => c[0] === "updateProfile"),
    [["updateProfile", 101, { tag: ["Google Cloud不可用", "已修改2fa"] }]],
    "只传 tag，值是标签名数组（按传入顺序；标题含空格也原样）",
  );

  const bad = (/** @type {any} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT;
  await assert.rejects(s.call(CH.accountsSetTags, "b@x.com", [142399]), bad, "未绑定窗口");
  await assert.rejects(s.call(CH.accountsSetTags, "ghost@x.com", [142399]), bad);
  await assert.rejects(s.call(CH.accountsSetTags, "a@x.com", [999999]), bad, "词表里没有的标签");
  await assert.rejects(s.call(CH.accountsSetTags, "a@x.com", ["142399"]), bad, "字符串 id 不接受");
  await assert.rejects(s.call(CH.accountsSetTags, "a@x.com", [0]), bad);
  await assert.rejects(s.call(CH.accountsSetTags, "a@x.com", [1.5]), bad);
  await assert.rejects(
    s.call(CH.accountsSetTags, "a@x.com", Array.from({ length: 101 }, (_, i) => i + 1)),
    bad,
    "超过上限",
  );
  assert.equal(await s.call(CH.accountsSetTags, "a@x.com", []), true, "清空标签是合法的");
  assert.deepEqual(s.ix.calls.filter((c) => c[0] === "updateProfile").at(-1), ["updateProfile", 101, { tag: [] }]);
});

test("标签词表：createTag 返回词表项（名字去空白）；updateTag / deleteTag 直通；参数非法拒绝", async () => {
  const s = setup({ tags: VOCAB });
  const created = await s.call(CH.accountsCreateTag, "  新标签  ");
  assert.equal(created.title, "新标签");
  assert.ok(created.id > 0);
  assert.deepEqual(s.ix.calls.filter((c) => c[0] === "createTag"), [["createTag", "新标签"]]);
  assert.ok(created.color !== undefined, "返回词表项（带 ixBrowser 给的颜色）");

  assert.equal(await s.call(CH.accountsUpdateTag, 142399, "改名后"), true);
  assert.deepEqual(s.ix.calls.filter((c) => c[0] === "updateTag"), [["updateTag", 142399, "改名后"]]);
  assert.equal(await s.call(CH.accountsDeleteTag, 140180), true);
  assert.deepEqual(s.ix.calls.filter((c) => c[0] === "deleteTag"), [["deleteTag", 140180]]);

  const bad = (/** @type {any} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT;
  await assert.rejects(s.call(CH.accountsCreateTag, "   "), bad, "空名字");
  await assert.rejects(s.call(CH.accountsCreateTag, "x".repeat(51)), bad, "名字太长");
  await assert.rejects(s.call(CH.accountsCreateTag, 42), bad);
  await assert.rejects(s.call(CH.accountsUpdateTag, 0, "x"), bad);
  await assert.rejects(s.call(CH.accountsUpdateTag, 142399, ""), bad);
  await assert.rejects(s.call(CH.accountsDeleteTag, "142399"), bad);
});

test("filterAccounts：按标签多选筛（命中任一即显示）；applyTagsUpdate 只改那一行", () => {
  const T = (/** @type {number} */ id, /** @type {string} */ title) => ({ id, title, color: "#67C23A" });
  const rows = [
    row({ email: "a@x.com", tags: [T(1, "一")] }),
    row({ email: "b@x.com", tags: [T(2, "二")] }),
    row({ email: "c@x.com", tags: [T(1, "一"), T(2, "二")] }),
    row({ email: "d@x.com" }),
  ];
  const q = (o) => ({ groupId: null, login: "all", text: "", ...o });
  const emails = (list) => list.map((r) => r.email);
  assert.deepEqual(emails(filterAccounts(rows, q({ tagIds: [1] }))), ["a@x.com", "c@x.com"]);
  assert.deepEqual(emails(filterAccounts(rows, q({ tagIds: [2] }))), ["b@x.com", "c@x.com"]);
  assert.deepEqual(
    emails(filterAccounts(rows, q({ tagIds: [1, 2] }))),
    ["a@x.com", "b@x.com", "c@x.com"],
    "任选多个命中任一即显示（OR）",
  );
  assert.deepEqual(emails(filterAccounts(rows, q({ tagIds: [999] }))), []);
  assert.equal(filterAccounts(rows, q({ tagIds: [] })), rows, "空数组不筛");

  const next = applyTagsUpdate(rows, "d@x.com", [T(3, "三")]);
  assert.notEqual(next, rows);
  assert.deepEqual(
    next.map((r) => [r.email, r.tags.map((t) => t.id)]),
    [
      ["a@x.com", [1]],
      ["b@x.com", [2]],
      ["c@x.com", [1, 2]],
      ["d@x.com", [3]],
    ],
  );
  assert.equal(applyTagsUpdate(rows, "ghost@x.com", []), rows);
});
