/**
 * src/application/account-manager-service.ts 与 account-task-orchestrator.ts 的离线单测
 * 文案逐条对照 application/account_manager_service.py / account_task_orchestrator.py
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as svc from "../src/application/account-manager-service.ts";
import * as orch from "../src/application/account-task-orchestrator.ts";
import { createBatchResult } from "../src/automation/batch/types.ts";

function fakeRepo(accounts) {
  return {
    getAccountByEmail: (e) => accounts.find((a) => a.email === e) ?? null,
    getAllAccounts: () => accounts,
  };
}

// ==================== account-manager-service ====================

test("checkTaskConflicts：顺序与文案（:19-47）", () => {
  assert.deepEqual(svc.checkTaskConflicts(), [true, ""]);
  assert.deepEqual(svc.checkTaskConflicts({ workerRunning: true }), [false, "已有任务在执行中"]);
  assert.deepEqual(svc.checkTaskConflicts({ workerRunning: true, waitAction: "删除" }), [
    false,
    "已有任务在执行中，请等待完成后再删除",
  ]);
  // 批量绑定排在最前
  assert.deepEqual(svc.checkTaskConflicts({ workerRunning: true, batchBindRunning: true }), [false, "批量绑定任务正在执行中"]);
});

test("resolveSelectedAccounts：跳过空邮箱与不存在的账号，'-' 视为未绑定", () => {
  const repo = fakeRepo([{ email: "a@x.com" }, { email: "b@x.com" }]);
  const r = svc.resolveSelectedAccounts(repo, [
    ["a@x.com", "11"],
    ["", "12"],
    ["zz@x.com", "13"],
    ["b@x.com", "-"],
  ]);
  assert.deepEqual(r.accounts.map((a) => a.email), ["a@x.com", "b@x.com"]);
  assert.deepEqual(r.browserIds, ["11", ""]);
});

test("collectUnboundEmails / collectMissingBrowserEmails", () => {
  assert.deepEqual(svc.collectUnboundEmails([["a", ""], ["b", "-"], ["c", "3"], ["", ""]]), ["a", "b"]);
  assert.deepEqual(svc.collectMissingBrowserEmails([{ email: "a" }, { email: "b" }], ["", "2"]), ["a"]);
});

test("matchAccountsToWindows：名称去空白小写匹配，已被绑定的窗口归入 alreadyBound", () => {
  const repo = fakeRepo([
    { email: "x@x.com", browser_profile_id: "200" },
    { email: "a@x.com", browser_profile_id: null },
  ]);
  const windows = [
    { name: "  A@X.com ", profile_id: 100 },
    { name: "b@x.com", profile_id: 200 },
    { name: "", profile_id: 300 },
  ];
  const r = svc.matchAccountsToWindows(repo, ["a@x.com", "B@x.com", "c@x.com"], windows);
  assert.deepEqual(r.matched, [["a@x.com", "100"]]);
  assert.deepEqual(r.alreadyBound, [["B@x.com", "200"]]);
  assert.deepEqual(r.notMatched, ["c@x.com"]);
});

test("matchAccountsToWindows：两个大小写不同的邮箱匹配到同一窗口时，只有第一个绑定，第二个归入 alreadyBound", () => {
  const repo = fakeRepo([]);
  const r = svc.matchAccountsToWindows(repo, ["a@x.com", "A@X.com"], [{ name: "a@x.com", profile_id: 7 }]);
  assert.deepEqual(r.matched, [["a@x.com", "7"]]);
  assert.deepEqual(r.alreadyBound, [["A@X.com", "7"]]);
  assert.deepEqual(r.notMatched, []);
});

test("getAccountAndBrowser", () => {
  const repo = fakeRepo([{ email: "a", browser_profile_id: "9" }, { email: "b", browser_profile_id: null }]);
  assert.deepEqual(svc.getAccountAndBrowser(repo, "a").browserId, "9");
  assert.equal(svc.getAccountAndBrowser(repo, "b").browserId, "");
  assert.deepEqual(svc.getAccountAndBrowser(repo, "zz"), { account: null, browserId: "" });
});

test("buildBatchDeleteConfirmMessage（:149-156）", () => {
  assert.equal(
    svc.buildBatchDeleteConfirmMessage(3, true),
    "确定要删除选中的 3 个账号及其对应的浏览器窗口吗？\n\n⚠️ 此操作不可恢复！",
  );
  assert.equal(
    svc.buildBatchDeleteConfirmMessage(2, false),
    "确定要删除选中的 2 个账号吗？\n\n注意：仅删除账号记录，不会删除对应的浏览器窗口。",
  );
});


// ==================== orchestrator ====================

/** 假批处理器：记录每次调用 */
function fakeProcessor() {
  const calls = [];
  const res = (n) => createBatchResult({ total: n, success_count: n });
  return {
    calls,
    stopped: 0,
    async batchLogin(a, b, o) {
      calls.push(["batchLogin", a.length, b, o]);
      return res(a.length);
    },
    stop() {
      this.stopped++;
    },
  };
}

const LLM = { apiKey: "k", model: "m", provider: "gemini" };

function workerParams(overrides) {
  const logs = [];
  return {
    logs,
    params: {
      accounts: [{ email: "a" }, { email: "b" }],
      browserIds: ["1", "2"],
      concurrency: 4,
      llm: LLM,
      shouldStop: () => false,
      onStop: () => {},
      log: (m) => logs.push(m),
      progressFromLog: () => {},
      ...overrides,
    },
  };
}

test("executeAccountWorkerTask：login 分派到 batchLogin 并透传 LLM 参数（adapter :43-104）", async () => {
  const p = fakeProcessor();
  let created = null;
  const { params } = workerParams({
    taskType: "login",
    createProcessor: (o) => {
      created = o;
      return p;
    },
  });
  const result = await orch.executeAccountWorkerTask(params);
  assert.equal(created.concurrency, 4);
  assert.equal(p.calls.length, 1);
  const [name, n, ids, opt] = p.calls[0];
  assert.equal(name, "batchLogin");
  assert.equal(n, 2);
  assert.deepEqual(ids, ["1", "2"]);
  assert.deepEqual(opt, LLM);
  assert.equal(result.type, "login");

  // 未知任务类型不调用处理器
  const p2 = fakeProcessor();
  const { params: p2params } = workerParams({ taskType: "oauth", createProcessor: () => p2 });
  assert.deepEqual(await orch.executeAccountWorkerTask(p2params), { type: "unknown" });
  assert.equal(p2.calls.length, 0);
});

test("executeAccountWorkerTask：结果形状照搬 to_dict", async () => {
  const p = fakeProcessor();
  const { params } = workerParams({ taskType: "login", createProcessor: () => p });
  const r = await orch.executeAccountWorkerTask(params);
  assert.deepEqual(Object.keys(r).sort(), ["result", "type"]);
  assert.equal(typeof r.result.success_rate, "string");
  assert.deepEqual(Object.keys(r.result).sort(), [
    "duration_seconds",
    "failed_count",
    "results",
    "skipped_count",
    "success_count",
    "success_rate",
    "total",
  ]);
});

test("executeAccountWorkerTask：onStop 钩子触发 processor.stop；结束时返回 stopped 结果", async () => {
  const p = fakeProcessor();
  let stop = false;
  let hook = null;
  p.batchLogin = async function () {
    // 任务进行中用户点了停止
    stop = true;
    hook();
    return createBatchResult({ total: 1 });
  };
  const { params } = workerParams({
    taskType: "login",
    shouldStop: () => stop,
    onStop: (fn) => (hook = fn),
    createProcessor: () => p,
  });
  const r = await orch.executeAccountWorkerTask(params);
  assert.equal(p.stopped, 1);
  assert.deepEqual(r, { type: "stopped", task_type: "login", message: "用户停止任务" });
});

test("executeAccountWorkerTask：日志回调里发现停止标志也会调 stop 并只记一次「用户停止任务」", async () => {
  const p = fakeProcessor();
  let cb = null;
  const progress = [];
  p.batchLogin = async function () {
    cb("[1/2] ✓ a 成功");
    cb("[2/2] ✗ b 失败");
    return createBatchResult({ total: 2 });
  };
  const { params, logs } = workerParams({
    taskType: "login",
    shouldStop: () => progress.length > 0,
    progressFromLog: (m) => progress.push(m),
    createProcessor: (o) => {
      cb = o.callback;
      return p;
    },
  });
  await orch.executeAccountWorkerTask(params);
  assert.equal(p.stopped, 1);
  assert.equal(logs.filter((l) => l === "用户停止任务").length, 1);
  assert.equal(progress.length, 2, "每条处理器日志都交给进度解析");
});

test("workerFinishedLogLines：登录 / 停止文案（:1399-1429），未知类型返回空", () => {
  assert.deepEqual(orch.workerFinishedLogLines({ type: "stopped", task_type: "login" }), ["任务已停止: login"]);
  assert.deepEqual(
    orch.workerFinishedLogLines({ type: "login", result: { success_count: 1, failed_count: 2, skipped_count: 3 } }),
    ["登录完成: 成功 1, 失败 2, 跳过 3"],
  );
  assert.deepEqual(orch.workerFinishedLogLines({ type: "unknown" }), []);
});

test("truncateLongStrings：只截断超长字符串，字段名不变", () => {
  const long = "x".repeat(600);
  const r = orch.truncateLongStrings({ results: [{ data: { page: long, n: 1 } }] });
  assert.equal(r.results[0].data.page.length, orch.MAX_RESULT_STRING + 1);
  assert.equal(r.results[0].data.n, 1);
});

test("executeBatchDelete：结果形状，窗口删除失败被忽略，账号删除异常计入失败（:262-309）", async () => {
  const deleted = [];
  const closed = [];
  const logs = [];
  const r = await orch.executeBatchDelete({
    accounts: [{ email: "a" }, { email: "b" }, { email: "c" }],
    browserIds: ["1", "", "3"],
    withWindows: true,
    shouldStop: () => false,
    deleteAccount: (e) => {
      if (e === "c") throw new Error("db locked");
      deleted.push(e);
    },
    closeBrowser: async (id) => {
      closed.push(id);
      throw new Error("not open");
    },
    deleteBrowser: async (id) => ({ success: id === "1" }),
    log: (m) => logs.push(m),
    progress: () => {},
  });
  assert.deepEqual(r, {
    total: 3,
    deleted_accounts: 2,
    deleted_windows: 1,
    failed_count: 1,
    failed_list: [{ email: "c", error: "db locked" }],
  });
  assert.deepEqual(deleted, ["a", "b"]);
  // 先删账号、成功后再删窗口：c 删账号失败，不碰它的窗口 3
  assert.deepEqual(closed, ["1"]);
  assert.ok(logs.includes("删除 c 失败: db locked"));

  // 不删窗口时不碰 ixBrowser；停止后立即中断
  let n = 0;
  const r2 = await orch.executeBatchDelete({
    accounts: [{ email: "a" }, { email: "b" }],
    browserIds: ["1", "2"],
    withWindows: false,
    shouldStop: () => n >= 1,
    deleteAccount: () => n++,
    closeBrowser: () => assert.fail("不应关闭窗口"),
    deleteBrowser: () => assert.fail("不应删除窗口"),
    log: () => {},
    progress: () => {},
  });
  assert.equal(r2.deleted_accounts, 1);
});

test("executeBatchBind：结果形状与停止（:233-259）", () => {
  const bound = [];
  const r = orch.executeBatchBind({
    matchedPairs: [
      ["a", "1"],
      ["b", "2"],
    ],
    shouldStop: () => false,
    bindAccount: (e, id) => {
      if (e === "b") throw new Error("x");
      bound.push([e, id]);
    },
    log: () => {},
    progress: () => {},
  });
  assert.deepEqual(r, { total: 2, success_count: 1, failed_count: 1, failed_list: [{ email: "b", error: "x" }] });
  const stopped = orch.executeBatchBind({
    matchedPairs: [["a", "1"]],
    shouldStop: () => true,
    bindAccount: () => assert.fail("不应绑定"),
    log: () => {},
    progress: () => {},
  });
  assert.equal(stopped.success_count, 0);
});

test("executeBatchBind：bindAccount 返回 false 计为失败；窗口已被其他账号占用时跳过", () => {
  const bound = [];
  const logs = [];
  const r = orch.executeBatchBind({
    matchedPairs: [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", "4"],
    ],
    shouldStop: () => false,
    bindAccount: (e, id) => {
      if (e === "b") return false;
      bound.push([e, id]);
      return true;
    },
    ownerOf: (id) => (id === "3" ? "other" : id === "4" ? "d" : null),
    log: (m) => logs.push(m),
    progress: () => {},
  });
  assert.deepEqual(r, {
    total: 4,
    success_count: 2,
    failed_count: 2,
    failed_list: [
      { email: "b", error: "写入数据库失败" },
      { email: "c", error: "窗口 3 已被账号 other 绑定" },
    ],
  });
  // 窗口已绑给自己（d -> 4）不算冲突
  assert.deepEqual(bound, [
    ["a", "1"],
    ["d", "4"],
  ]);
  assert.ok(logs.includes("绑定失败: c - 窗口 3 已被账号 other 绑定"));
});

test("executeBatchDelete：deleteAccount 返回 false 计为失败且不删窗口；非数字窗口 ID 不调用 ixBrowser", async () => {
  const closed = [];
  const logs = [];
  const r = await orch.executeBatchDelete({
    accounts: [{ email: "a" }, { email: "b" }],
    browserIds: ["1", "12abc"],
    withWindows: true,
    shouldStop: () => false,
    deleteAccount: (e) => e !== "a",
    closeBrowser: (id) => closed.push(id),
    deleteBrowser: (id) => {
      closed.push(`del:${id}`);
      return { success: true };
    },
    log: (m) => logs.push(m),
    progress: () => {},
  });
  assert.deepEqual(r, {
    total: 2,
    deleted_accounts: 1,
    deleted_windows: 0,
    failed_count: 1,
    failed_list: [{ email: "a", error: "数据库中未删除该账号" }],
  });
  assert.deepEqual(closed, []);
  assert.ok(logs.includes("窗口 ID 非法，跳过删除窗口: 12abc"));
  assert.equal(orch.isValidWindowId("123"), true);
  assert.equal(orch.isValidWindowId(" 1"), false);
  assert.equal(orch.isValidWindowId(""), false);
});
