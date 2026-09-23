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
  assert.deepEqual(svc.checkTaskConflicts({ enableSharingRunning: true }), [false, "开启共享任务正在执行中"]);
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

test("prepareDetectProCandidates + 文案（:215-267）", () => {
  const accounts = [
    { email: "a", login_status: "logged_in" },
    { email: "b", login_status: "not_logged" },
    { email: "c", login_status: "logged_in" },
  ];
  const r = svc.prepareDetectProCandidates(accounts, ["1", "2", ""]);
  assert.deepEqual(r.validAccounts.map((a) => a.email), ["a"]);
  assert.deepEqual(r.validBrowserIds, ["1"]);
  assert.deepEqual(r.skippedNotLogged, ["b"]);
  assert.deepEqual(r.skippedNoBrowser, ["c"]);
  assert.equal(svc.buildNoDetectProCandidatesMessage(["b"], ["c"]), "没有可检测的账号\n\n❌ 1 个未登录\n❌ 1 个未绑定窗口");
  assert.equal(
    svc.buildDetectProConfirmMessage(1, 1, 1),
    "将检测 1 个已登录账号的 Pro 状态\n\n⚠️ 跳过 1 个未登录账号\n⚠️ 跳过 1 个未绑定窗口账号",
  );
  assert.equal(svc.buildDetectProConfirmMessage(5, 0, 0), "将检测 5 个已登录账号的 Pro 状态");
});

test("buildRefreshMembershipConfirmMessage（界面层 :1083-1093）", () => {
  assert.equal(
    svc.buildRefreshMembershipConfirmMessage(2, 1, 0),
    "将刷新 2 个账号的完整会员信息：\n• Pro 会员状态\n• 家庭组详情（角色、管理员、成员数）\n• 账户所属国家\n\n⚠️ 跳过 1 个未登录账号\n\n是否继续？",
  );
});

test("prepareFamilyJoinCandidates + 文案（:159-212）", () => {
  const accounts = [
    { email: "p", is_pro: "yes", login_status: "logged_in" },
    { email: "f", is_pro: "family_yes", login_status: "logged_in" },
    { email: "n", is_pro: "no", login_status: "not_logged" },
    { email: "u", is_pro: "unknown", login_status: "logged_in" },
    { email: "ok", is_pro: "no", login_status: "logged_in" },
  ];
  const r = svc.prepareFamilyJoinCandidates(accounts, ["1", "2", "3", "", "5"]);
  assert.deepEqual(r.normalAccounts.map((a) => a.email), ["ok"]);
  assert.deepEqual(r.skippedAlreadyPro, ["p", "f"]);
  assert.deepEqual(r.skippedNotLogged, ["n"]);
  assert.deepEqual(r.skippedNoBrowser, ["u"]);
  assert.equal(
    svc.buildNoFamilyCandidatesMessage(["p"], ["n"], ["u"]),
    "没有可加入家庭组的普通账户\n\n⚠️ 1 个已是 Pro 会员\n⚠️ 1 个未登录\n⚠️ 1 个未绑定窗口",
  );
});

test("403 相关：filterLinked / 解锁目标 / 文案（:270-361）", () => {
  const accounts = [
    { email: "a", sub2api_status: "linked", unlock_status: "needs_unlock", browser_profile_id: "1" },
    { email: "b", sub2api_status: "not_linked", unlock_status: "unlock_failed", browser_profile_id: "" },
    { email: "c", sub2api_status: "linked", unlock_status: "none", browser_profile_id: "3" },
  ];
  assert.deepEqual(svc.filterLinkedAccountsForDetect403(accounts).map((a) => a.email), ["a", "c"]);
  assert.equal(
    svc.buildNoLinkedAccountsForDetect403Message(4),
    "选中的 4 个账号中没有已关联的账号\n\n只有 Sub2API 状态为「已关联」的账号才能检测 403",
  );
  const sel = svc.collectUnlockTargetsFromSelected(accounts, ["1", "", "3"]);
  assert.deepEqual(sel.accountsToUnlock.map((a) => a.email), ["a", "b"]);
  assert.deepEqual(sel.browserIds, ["1", ""]);
  const all = svc.collectUnlockTargetsFromAll(accounts);
  assert.deepEqual(all.accountsToUnlock.map((a) => a.email), ["a", "c"]);
  const split = svc.splitAccountsWithBrowser(sel.accountsToUnlock, sel.browserIds);
  assert.deepEqual(split.validBrowserIds, ["1"]);
  assert.deepEqual(split.noBrowserEmails, ["b"]);
  assert.equal(
    svc.buildNoSelectedUnlockTargetsMessage(),
    "选中的账号中没有需要解锁的\n\n请选择 unlock_status 为 needs_unlock 或 unlock_failed 的账号",
  );
  assert.equal(
    svc.buildUnlockAllConfirmMessage(7),
    "未选择账号，是否解锁全部 7 个需要解锁的账号？\n\n提示: 可以先勾选要解锁的账号再点击此按钮",
  );
  assert.equal(
    svc.buildUnlockConfirmMessage(2, 1, null, 0),
    "将解锁 2 个账号\n\n⚠️ 1 个账号未绑定窗口（已跳过）\n\n国家ID: 自动 | 服务ID: 自动",
  );
  assert.equal(svc.buildUnlockConfirmMessage(2, 0, 6, 9), "将解锁 2 个账号\n\n国家ID: 6 | 服务ID: 9");
});

test("开启共享候选 + 文案（:369-439）", () => {
  const accounts = [
    { email: "p", is_pro: "yes", login_status: "logged_in" },
    { email: "f", is_pro: "family_yes", login_status: "logged_in" },
    { email: "q", is_pro: "yes", login_status: "not_logged" },
    { email: "r", is_pro: "yes", login_status: "logged_in" },
  ];
  const r = svc.prepareEnableFamilySharingCandidates(accounts, ["1", "2", "3", ""]);
  assert.deepEqual(r.validAccounts.map((a) => a.email), ["p"]);
  assert.deepEqual(r.skippedNotPro, ["f"]);
  assert.deepEqual(r.skippedNotLogged, ["q"]);
  assert.deepEqual(r.skippedNoBrowser, ["r"]);
  assert.equal(
    svc.buildNoEnableFamilySharingCandidatesMessage(["f"], [], []),
    "没有可开启共享的普通 Pro 账户\n\n⚠️ 1 个不是普通 Pro 账户\n",
  );
  assert.equal(
    svc.buildEnableFamilySharingConfirmMessage(1, 1, 1, 1),
    "将为 1 个普通 Pro 账户开启家庭共享\n\n⚠️ 跳过 1 个非普通 Pro 账户\n⚠️ 跳过 1 个未登录账户\n⚠️ 跳过 1 个未绑定窗口账户",
  );
});

test("allocateToProAccounts：名额 6-max(n,1)、锁定跳过、名额用尽即停（:442-473）", () => {
  const pros = [
    { email: "p1", family_member_count: 4 }, // 2 个名额
    { email: "p2", family_member_count: 0 }, // 视为 1 人 → 5 个名额，但只测到 1 个
  ];
  const invitees = [{ email: "a" }, { email: "locked" }, { email: "b" }, { email: "c" }];
  const lock = { isLocked: (e) => e === "locked" };
  const r = svc.allocateToProAccounts(invitees, pros, lock);
  assert.deepEqual(
    r.assignments.map(([i, p]) => `${i.email}->${p.email}`),
    ["a->p1", "b->p1", "c->p2"],
  );
  assert.equal(r.skippedLockedCount, 1);

  // 名额用尽后停止（while...else: break）
  const full = svc.allocateToProAccounts([{ email: "a" }, { email: "b" }], [{ email: "p", family_member_count: 5 }], {
    isLocked: () => false,
  });
  assert.deepEqual(full.assignments.map(([i]) => i.email), ["a"]);
});

test("buildFamilyAssignmentsPreviewMessage（:476-502）", () => {
  const a = [[{ email: "a" }, { email: "p" }]];
  assert.equal(
    svc.buildFamilyAssignmentsPreviewMessage(a, 3, 1),
    "即将分配 1 个普通账户到家庭组\n\n分配预览:\n  • a -> p\n\n⚠️ 1 个账户因 Pro 名额不足未能分配\n⚠️ 1 个账户正在被其他任务处理，已跳过\n",
  );
  const many = Array.from({ length: 3 }, (_, i) => [{ email: `a${i}` }, { email: "p" }]);
  assert.match(svc.buildFamilyAssignmentsPreviewMessage(many, 3, 0, 2), /  \.\.\. 等 3 个\n$/);
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
    async batchOauth(a, b, o) {
      calls.push(["batchOauth", a.length, b, o]);
      return res(a.length);
    },
    async batchLoginAndOauth(a, b, o) {
      calls.push(["batchLoginAndOauth", a.length, b, o]);
      return { login: res(a.length), oauth: res(1) };
    },
    async batchUnlock403(a, b, o) {
      calls.push(["batchUnlock403", a.length, b, o]);
      return res(a.length);
    },
    async batchRefreshMembershipInfo(a, b, mode) {
      calls.push(["batchRefreshMembershipInfo", a.length, b, mode]);
      const r = res(a.length);
      r.results.push({ _summary: true, pro_regular_count: 1, pro_family_count: 2, non_pro_count: 3 });
      return r;
    },
    stop() {
      this.stopped++;
    },
  };
}

const LLM = { apiKey: "k", model: "m", provider: "gemini" };

function workerParams(overrides) {
  const logs = [];
  const client = { closed: 0, async close() { this.closed++; } };
  return {
    logs,
    client,
    params: {
      accounts: [{ email: "a" }, { email: "b" }],
      browserIds: ["1", "2"],
      concurrency: 4,
      smsToken: null,
      countryId: null,
      projectId: null,
      maxRetries: null,
      autoBindProxy: false,
      llm: LLM,
      shouldStop: () => false,
      onStop: () => {},
      log: (m) => logs.push(m),
      progressFromLog: () => {},
      createSub2ApiClient: () => client,
      ...overrides,
    },
  };
}

test("executeAccountWorkerTask：各任务类型分派到正确方法与参数（adapter :43-104）", async () => {
  const cases = [
    ["login", "batchLogin"],
    ["oauth", "batchOauth"],
    ["login_and_oauth", "batchLoginAndOauth"],
    ["unlock_403", "batchUnlock403"],
    ["refresh_membership_info", "batchRefreshMembershipInfo"],
    ["detect_pro", "batchRefreshMembershipInfo"],
  ];
  for (const [taskType, method] of cases) {
    const p = fakeProcessor();
    let created = null;
    const { params, client } = workerParams({
      taskType,
      smsToken: "tok",
      countryId: 6,
      projectId: 7,
      maxRetries: 2,
      createProcessor: (o) => {
        created = o;
        return p;
      },
    });
    const result = await orch.executeAccountWorkerTask(params);
    assert.equal(created.concurrency, 4, taskType);
    assert.equal(p.calls.length, 1, taskType);
    const [name, n, ids, opt] = p.calls[0];
    assert.equal(name, method, taskType);
    assert.equal(n, 2);
    assert.deepEqual(ids, ["1", "2"]);
    assert.equal(result.type, taskType);

    if (taskType === "login") assert.deepEqual(opt, LLM);
    if (taskType === "oauth" || taskType === "login_and_oauth") {
      assert.equal(opt.sub2apiClient, client);
      assert.equal(opt.autoBindProxy, false);
      assert.equal(opt.apiKey, "k");
      assert.equal(client.closed, 1, "sub2api 客户端用完要关闭");
    }
    if (taskType === "unlock_403") {
      assert.deepEqual(opt, { smsToken: "tok", countryId: 6, projectId: 7, maxRetries: 2, ...LLM });
    }
    if (taskType === "refresh_membership_info") assert.equal(opt, "full");
    if (taskType === "detect_pro") assert.equal(opt, "pro_only");
  }
});

test("executeAccountWorkerTask：结果形状照搬 to_dict；login_and_oauth 拆成两段", async () => {
  const p = fakeProcessor();
  const { params } = workerParams({ taskType: "login_and_oauth", createProcessor: () => p });
  const r = await orch.executeAccountWorkerTask(params);
  assert.deepEqual(Object.keys(r).sort(), ["login_result", "oauth_result", "type"]);
  assert.equal(r.login_result.success_count, 2);
  assert.equal(r.oauth_result.total, 1);
  assert.equal(typeof r.login_result.success_rate, "string");

  const p2 = fakeProcessor();
  const { params: p2params } = workerParams({ taskType: "login", createProcessor: () => p2 });
  const r2 = await orch.executeAccountWorkerTask(p2params);
  assert.deepEqual(Object.keys(r2.result).sort(), [
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

test("workerFinishedLogLines：_summary 行与各类型文案（:1399-1429）", () => {
  const p = fakeProcessor();
  return p.batchRefreshMembershipInfo([{}, {}], ["1", "2"], "pro_only").then((r) => {
    const lines = orch.workerFinishedLogLines({ type: "detect_pro", result: orch.batchResultPayload(r) });
    assert.deepEqual(lines, ["Pro 检测完成: Pro 1, Pro(家庭组) 2, 非Pro 3, 失败 0"]);
    assert.deepEqual(orch.workerFinishedLogLines({ type: "stopped", task_type: "oauth" }), ["任务已停止: oauth"]);
    assert.deepEqual(
      orch.workerFinishedLogLines({ type: "login", result: { success_count: 1, failed_count: 2, skipped_count: 3 } }),
      ["登录完成: 成功 1, 失败 2, 跳过 3"],
    );
  });
});

test("truncateLongStrings：只截断超长字符串，字段名不变", () => {
  const long = "x".repeat(600);
  const r = orch.truncateLongStrings({ results: [{ data: { page: long, n: 1 } }] });
  assert.equal(r.results[0].data.page.length, orch.MAX_RESULT_STRING + 1);
  assert.equal(r.results[0].data.n, 1);
});

test("executeDetect403：结果形状、缺 account_id 时查询、需要解锁时写库（:312-383）", async () => {
  const updates = [];
  const repo = {
    updateSub2apiStatus: (...a) => updates.push(["sub2api", ...a]),
    updateUnlockStatus: (...a) => updates.push(["unlock", ...a]),
  };
  const client = {
    closed: 0,
    async checkAccountExists(email) {
      return email === "b" ? 22 : null;
    },
    async testAccountConnection(id) {
      if (id === 11) return { success: false, data: { needs_unlock: true, validation_url: "https://v" } };
      if (id === 22) return { success: true };
      return { success: false, data: {}, error: "boom" };
    },
    async close() {
      this.closed++;
    },
  };
  const logs = [];
  const progress = [];
  const r = await orch.executeDetect403({
    accounts: [
      { email: "a", sub2api_status: "linked", sub2api_account_id: 11 },
      { email: "b", sub2api_status: "linked", sub2api_account_id: null },
      { email: "c", sub2api_status: "linked", sub2api_account_id: null },
      { email: "d", sub2api_status: "not_linked" },
      { email: "e", sub2api_status: "linked", sub2api_account_id: 33 },
    ],
    shouldStop: () => false,
    log: (m) => logs.push(m),
    progress: (i) => progress.push(i),
    createSub2ApiClient: () => client,
    repo,
  });
  assert.deepEqual(r, { total: 4, needs_unlock: 1, accounts: ["a"] });
  assert.deepEqual(updates, [
    ["unlock", "a", "needs_unlock", "https://v"],
    ["sub2api", "b", "linked", 22],
    ["sub2api", "c", "not_linked"],
  ]);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  assert.ok(logs.includes("[c] 在 Sub2API 中未找到，修正状态为未关联"));
  assert.ok(logs.includes("[e] 检测失败: boom"));
  assert.equal(client.closed, 1);

  // 没有已关联账号 → 骨架 total=0
  const empty = await orch.executeDetect403({
    accounts: [{ email: "x", sub2api_status: "not_linked" }],
    shouldStop: () => false,
    log: () => {},
    progress: () => {},
    createSub2ApiClient: () => client,
    repo,
  });
  assert.deepEqual(empty, { total: 0, needs_unlock: 0, accounts: [] });
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

test("executeEnableFamilySharing：结果形状（:170-230）", async () => {
  const r = await orch.executeEnableFamilySharing({
    accounts: [{ email: "a" }, { email: "b" }, { email: "c" }, { email: "d" }],
    browserIds: ["1", "2", "3", "4"],
    shouldStop: () => false,
    log: () => {},
    progress: () => {},
    runEnableSharing: async (acc) => {
      if (acc.email === "a") return { success: true, message: "", wasAlreadyEnabled: true };
      if (acc.email === "b") return { success: true, message: "", familyCreated: true };
      if (acc.email === "c") return { success: false, message: "" };
      throw new Error("boom");
    },
  });
  assert.deepEqual(r, {
    total: 4,
    success_count: 1,
    already_enabled_count: 1,
    family_created_count: 1,
    failed_count: 2,
    failed_list: [
      { email: "c", error: "未知错误" },
      { email: "d", error: "boom" },
    ],
  });
});
