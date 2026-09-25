/**
 * AI 批量任务（替换手机号 / 替换辅助邮箱 / 修改2SV手机 / 修改验证器 / 踢出设备）
 * 分派、accountInfo 取数、逐行事件、停止、结果形状、加载构树、参数校验。
 * 全部离线：automation 函数是假的，ixBrowser 客户端是假的，:memory: 库 + 临时数据根。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ERROR_CODES } from "../app/shared/envelope.ts";
import { IPC } from "../app/shared/ipc.ts";
import { AI_TASKS_INVOKE, AI_TASK_KINDS, AI_TASK_LOGIN_FILTERS } from "../app/shared/channels/ai-tasks.ts";
import { createHostContext } from "../app/host/context.ts";
import { createDispatcher } from "../app/host/dispatch.ts";
import { createAiTasksHandlers, parseStartArgs } from "../app/host/handlers/ai-tasks.ts";
import { buildAiTaskRows, describeOutcome } from "../src/application/ai-task-runner.ts";
import { HistoryRepository } from "../src/db/history-repository.ts";

// ==================== 工具 ====================

/**
 * @param {{ groups?: any[], windows?: any[] }} [opts]
 * @returns {any}
 */
function fakeIx({ groups = [], windows = [] } = {}) {
  return {
    async getGroupList() {
      return groups;
    },
    async getProfileList() {
      return windows;
    },
    async openProfile() {
      throw new Error("测试中不应打开窗口");
    },
  };
}

/**
 * 假 automation：记录调用参数；behavior[email] 决定结果（默认成功）
 * @param {Record<string, any>} [behavior]
 * @param {Record<string, any>} [hooks]
 * @param {Record<string, string>} [login] 执行前确认登录的结果：email → "fail"（默认成功）
 * @returns {{ calls: any[], loginCalls: any[], seq: string[], automation: any }}
 */
function fakeAutomation(behavior = {}, hooks = {}, login = {}, check = {}) {
  const calls = [];
  /** @type {any[]} */
  const loginCalls = [];
  /** @type {string[]} */
  const seq = [];
  const pick = (name, args) => {
    calls.push({ name, args });
    seq.push(`${name}:${args[1]?.email}`);
    hooks.onCall?.(name, args);
    const email = args[1]?.email;
    const b = behavior[email] ?? "ok";
    if (b === "throw") throw new Error(`炸了: ${email}`);
    return b;
  };
  return {
    calls,
    loginCalls,
    seq,
    automation: {
      async autoReplaceRecoveryPhone(...args) {
        const b = pick("phone", args);
        return b === "fail" ? [false, "手机号替换失败原因"] : [true, "辅助手机号替换成功"];
      },
      async autoReplaceRecoveryEmail(...args) {
        const b = pick("email", args);
        return b === "fail" ? [false, "", "timeout"] : [true, "辅助邮箱替换成功", null];
      },
      async autoModify2svPhone(...args) {
        const b = pick("2sv", args);
        return b === "fail" ? [false, ""] : [true, "2SV 手机号修改成功"];
      },
      async autoModifyAuthenticator(...args) {
        const b = pick("auth", args);
        if (b === "fail") return [false, "", null];
        if (b === "nosecret") return [true, "身份验证器修改成功", null];
        return [true, "身份验证器修改成功，新密钥已保存", "ABCDEFGHIJKLMNOP"];
      },
      async autoKickDevices(...args) {
        const b = pick("kick", args);
        return Object.assign(b === "fail" ? [false, "踢出出错"] : [true, "成功踢出 2 个设备"], { kickedCount: 2 });
      },
      async autoChangePassword(...args) {
        const b = pick("password", args);
        return b === "fail" ? [false, "改密失败"] : [true, "密码已修改"];
      },
      // 执行前的「只读检查」：check[email] = "in"（已登录）/ "throw"；默认「未登录」，走登录流程
      async checkGoogleLogin(browserId, account) {
        seq.push(`check:${account?.email}`);
        const email = String(account?.email ?? "");
        if (check[email] === "throw") throw new Error("检查炸了");
        return { signedIn: check[email] === "in", otherAccount: false, url: "https://myaccount.google.com/" };
      },
      // 未登录时才调用的「登录」：login[email] = "fail" / "throw" / "stuck"；模拟真实函数的写库行为
      async autoGoogleLogin(browserId, account, opts) {
        loginCalls.push({ browserId, account, opts });
        seq.push(`login:${account?.email}`);
        hooks.onLogin?.(account?.email);
        const email = String(account?.email ?? "");
        if (login[email] === "throw") throw new Error("登录炸了");
        if (login[email] === "stuck") {
          // 只写到「登录中」就返回（模拟异常中断）：handler 不应广播 logging_in
          opts?.accountRepo?.updateLoginStatus(email, "logging_in");
          return { success: false, message: "中断", email, browserId, loginStatus: "logging_in" };
        }
        if (login[email] === "fail") {
          const message = "需要验证码: 人机验证";
          opts?.accountRepo?.updateLoginStatus(email, "login_failed", message);
          return { success: false, message, email, browserId, loginStatus: "login_failed", errorType: "captcha_required" };
        }
        opts?.accountRepo?.updateLoginStatus(email, "logged_in");
        return { success: true, message: "登录成功", email, browserId, loginStatus: "logged_in" };
      },
    },
  };
}

/**
 * @param {{ groups?: any[], windows?: any[], behavior?: Record<string, any>, hooks?: Record<string, any>, ctxOverrides?: Record<string, any>, windowNames?: Record<string, string | null>, login?: Record<string, string>, check?: Record<string, string> }} [options]
 */
function setup({ groups = [], windows = [], behavior = {}, hooks = {}, ctxOverrides = {}, windowNames, login = {}, check = {} } = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), "abb-ai-tasks-"));
  const events = [];
  const waiters = [];
  const done = [];
  const ix = fakeIx({ groups, windows });
  const base = createHostContext({
    dataRoot,
    emit: (channel, payload) => {
      events.push([channel, payload]);
      if (channel === IPC.event.taskFinished) (waiters.length ? waiters.shift()(payload) : done.push(payload));
    },
    log: () => {},
    openDatabase: () => new DatabaseSync(":memory:"),
    ixClient: ix,
  });
  const ctx = { ...base, ...ctxOverrides };
  const fake = fakeAutomation(behavior, { ...hooks, ctx }, login, check);
  const startedNames = new Map();
  const handlers = createAiTasksHandlers(ctx, {
    automation: fake.automation,
    getWindowName: async (pid) => {
      if (windowNames && Object.prototype.hasOwnProperty.call(windowNames, pid)) return windowNames[pid];
      return startedNames.get(pid) ?? null;
    },
  });
  const dispatch = createDispatcher(handlers);
  const call = async (channel, ...args) => {
    // 默认让窗口名与所启动条目的 email 一致（模拟界面数据未过期）；windowNames 可覆盖以测试不一致
    if (channel === START && Array.isArray(args[1])) {
      for (const it of args[1]) if (it && typeof it.profileId === "number") startedNames.set(it.profileId, it.email);
    }
    const env = await dispatch(channel, args);
    if (!env.ok) {
      /** @type {any} */
      const e = new Error(env.error.message);
      e.code = env.error.code;
      throw e;
    }
    return env.data;
  };
  return {
    ctx,
    ix,
    dataRoot,
    events,
    calls: fake.calls,
    loginCalls: fake.loginCalls,
    seq: fake.seq,
    call,
    handlers,
    finished: () => (done.length ? Promise.resolve(done.shift()) : new Promise((r) => waiters.push(r))),
    items: () => events.filter(([c]) => c === IPC.event.taskItem).map(([, p]) => p),
    logs: () => events.filter(([c]) => c === IPC.event.taskLog).map(([, p]) => p.message),
    cleanup: () => rmSync(dataRoot, { recursive: true, force: true }),
  };
}

function seed(ctx, rows) {
  const stmt = ctx.db().prepare("INSERT INTO accounts (email, password, secret_key, status) VALUES (?,?,?,?)");
  for (const r of rows) stmt.run(r.email, r.password ?? null, r.secret_key ?? null, r.status ?? "pending");
}

const START = AI_TASKS_INVOKE.aiTasksStart;
const LOAD = AI_TASKS_INVOKE.aiTasksLoad;

// ==================== 定义表 ====================

test("AI_TASK_KINDS：任务名 / 额外输入文案逐字照搬 Python 子类", () => {
  assert.equal(AI_TASK_KINDS.replace_phone.taskName, "替换手机号");
  assert.deepEqual(AI_TASK_KINDS.replace_phone.extraField, {
    key: "newPhone",
    label: "新手机号",
    placeholder: "请输入新手机号（可选，留空则移除手机）",
  });
  assert.equal(AI_TASK_KINDS.replace_email.taskName, "替换辅助邮箱");
  assert.deepEqual(AI_TASK_KINDS.replace_email.extraField, {
    key: "newEmail",
    label: "新辅助邮箱",
    placeholder: "请输入新辅助邮箱（可选，留空则移除）",
  });
  assert.equal(AI_TASK_KINDS.modify_2sv.taskName, "修改2SV手机");
  assert.deepEqual(AI_TASK_KINDS.modify_2sv.extraField, {
    key: "newPhone",
    label: "新 2SV 手机",
    placeholder: "请输入新的两步验证手机号",
  });
  assert.equal(AI_TASK_KINDS.modify_auth.taskName, "修改验证器");
  assert.equal(AI_TASK_KINDS.modify_auth.extraField, null);
  assert.equal(AI_TASK_KINDS.kick_devices.taskName, "踢出设备");
  assert.equal(AI_TASK_KINDS.kick_devices.extraField, null);
  assert.deepEqual(
    AI_TASK_LOGIN_FILTERS.map((o) => o.value),
    ["all", "logged_in", "login_failed", "other", "not_in_db"],
  );
});

test("通道登记：IPC 表包含两个通道，handler 表恰好实现它们", () => {
  const s = setup();
  try {
    assert.equal(IPC.invoke.aiTasksLoad, "abb/aitasks/load");
    assert.equal(IPC.invoke.aiTasksStart, "abb/aitasks/start");
    assert.deepEqual(Object.keys(s.handlers).sort(), Object.values(AI_TASKS_INVOKE).sort());
  } finally {
    s.cleanup();
  }
});

// ==================== 分派 ====================

test("分派：replace_phone 透传 newPhone（去首尾空白），closeAfter:false", async () => {
  const s = setup();
  try {
    await s.call(START, "replace_phone", [{ email: "a@x.com", profileId: 11 }], { newPhone: " 13800 " });
    await s.finished();
    assert.equal(s.calls.length, 1);
    const [bid, info, phone, opts] = s.calls[0].args;
    assert.equal(s.calls[0].name, "phone");
    assert.equal(bid, "11");
    assert.equal(info.email, "a@x.com");
    assert.equal(phone, "13800");
    assert.deepEqual(opts, { closeAfter: false });
  } finally {
    s.cleanup();
  }
});

test("分派：replace_email 透传 newEmail；未传参数时为空串", async () => {
  const s = setup();
  try {
    await s.call(START, "replace_email", [{ email: "a@x.com", profileId: 5 }], { newEmail: "r@y.com" });
    await s.finished();
    assert.equal(s.calls[0].name, "email");
    assert.deepEqual(s.calls[0].args.slice(0, 1), ["5"]);
    assert.equal(s.calls[0].args[2], "r@y.com");
    assert.equal(s.calls[0].args.length, 3);

    await s.call(START, "replace_email", [{ email: "b@x.com", profileId: 6 }], {});
    await s.finished();
    assert.equal(s.calls[1].args[2], "");
  } finally {
    s.cleanup();
  }
});

test("真机回归（2026-09-25）：replace_email 成功后把新辅助邮箱写进数据库；失败不写、空参数不写", async () => {
  const s = setup({ check: { "a@x.com": "in", "b@x.com": "in", "c@x.com": "in" }, behavior: { "b@x.com": "fail" } });
  seed(s.ctx, [{ email: "a@x.com" }, { email: "b@x.com" }, { email: "c@x.com" }]);
  s.ctx.accountRepo().upsertAccount({ email: "a@x.com", recovery_email: "old@y.com" });
  s.ctx.accountRepo().upsertAccount({ email: "b@x.com", recovery_email: "old-b@y.com" });
  s.ctx.accountRepo().upsertAccount({ email: "c@x.com", recovery_email: "old-c@y.com" });
  try {
    await s.call(
      START,
      "replace_email",
      [
        { email: "a@x.com", profileId: 1 },
        { email: "b@x.com", profileId: 2 },
      ],
      { newEmail: " New@Y.com " },
    );
    await s.finished();
    const repo = s.ctx.accountRepo();
    assert.equal(repo.getAccountByEmail("a@x.com")?.recovery_email, "New@Y.com", "成功：写入新辅助邮箱（去首尾空白）");
    assert.equal(repo.getAccountByEmail("b@x.com")?.recovery_email, "old-b@y.com", "失败：不动库里的辅助邮箱");

    await s.call(START, "replace_email", [{ email: "c@x.com", profileId: 3 }], {});
    await s.finished();
    assert.equal(repo.getAccountByEmail("c@x.com")?.recovery_email, "old-c@y.com", "没给新邮箱：不写空值");
  } finally {
    s.cleanup();
  }
});

test("replace_email 成功但写库失败：行状态为失败并说明 Google 侧已改、库没写上（改动不能静默丢失）", async () => {
  const s = setup({ check: { "a@x.com": "in" } });
  seed(s.ctx, [{ email: "a@x.com" }]);
  const repo = s.ctx.accountRepo();
  repo.upsertAccount = () => false; // 模拟写库失败（仓储出错时返回 false）
  try {
    await s.call(START, "replace_email", [{ email: "a@x.com", profileId: 1 }], { newEmail: "n@y.com" });
    const fin = await s.finished();
    assert.equal(fin.result.results[0].status, "失败");
    assert.match(fin.result.results[0].message, /已替换.*写入数据库失败/);
  } finally {
    s.cleanup();
  }
});

test("分派：modify_2sv 不显式传 closeAfter（取函数默认值 true）", async () => {
  const s = setup();
  try {
    await s.call(START, "modify_2sv", [{ email: "a@x.com", profileId: 7 }], { newPhone: "+100" });
    await s.finished();
    assert.equal(s.calls[0].name, "2sv");
    assert.equal(s.calls[0].args.length, 3);
    assert.equal(s.calls[0].args[2], "+100");
  } finally {
    s.cleanup();
  }
});

test("分派：modify_auth 注入 accountRepo / historyRepo / ixClient / projectRoot=dataRoot，并建好历史表", async () => {
  const s = setup();
  try {
    await s.call(START, "modify_auth", [{ email: "a@x.com", profileId: 8 }], {});
    await s.finished();
    assert.equal(s.calls[0].name, "auth");
    const [bid, , opts] = s.calls[0].args;
    assert.equal(bid, "8");
    assert.equal(opts.accountRepo, s.ctx.accountRepo());
    assert.ok(opts.historyRepo instanceof HistoryRepository);
    assert.equal(opts.ixClient, s.ix);
    assert.equal(opts.projectRoot, s.dataRoot);
    // 历史表已建：可直接写入
    opts.historyRepo.addAuthenticatorModification("a@x.com", "SECRET");
    assert.ok(opts.historyRepo.getAuthenticatorModificationHistory()["a@x.com"]);
  } finally {
    s.cleanup();
  }
});

test("分派：kick_devices 只传 browserId 与 accountInfo", async () => {
  const s = setup();
  try {
    /** @type {any} */
    const info = await s.call(START, "kick_devices", [{ email: "a@x.com", profileId: 9 }], {});
    assert.equal(info.type, "ai_kick_devices");
    const fin = await s.finished();
    assert.equal(s.calls[0].name, "kick");
    assert.equal(s.calls[0].args.length, 2);
    assert.equal(fin.result.results[0].message, "成功踢出 2 个设备");
    assert.ok(!s.logs().some((m) => m.includes("并发")), "不再有并发数日志");
  } finally {
    s.cleanup();
  }
});

// ==================== accountInfo / 事件 / 结果 ====================

test("accountInfo 以数据库为准；无记录时为 {email}", async () => {
  const s = setup();
  try {
    seed(s.ctx, [{ email: "db@x.com", password: "pw1", secret_key: "OLD" }]);
    await s.call(
      START,
      "kick_devices",
      [
        { email: "db@x.com", profileId: 1 },
        { email: "none@x.com", profileId: 2 },
      ],
      {},
    );
    await s.finished();
    const [first, second] = s.calls.map((c) => c.args[1]);
    assert.equal(first.email, "db@x.com");
    assert.equal(first.password, "pw1");
    assert.equal(first.secret_key, "OLD");
    assert.deepEqual(second, { email: "none@x.com" });
  } finally {
    s.cleanup();
  }
});

test("item 事件顺序：处理中 → 成功 / 失败 / 错误；日志 `[email] status: message`；结果形状", async () => {
  const s = setup({ behavior: { "b@x.com": "fail", "c@x.com": "throw" } });
  try {
    /** @type {any} */
    const info = await s.call(
      START,
      "replace_email",
      [
        { email: "a@x.com", profileId: 1 },
        { email: "b@x.com", profileId: 2 },
        { email: "c@x.com", profileId: 3 },
        { email: "a@x.com", profileId: 1 }, // 重复，去重
      ],
      { newEmail: "r@y.com" },
    );
    const fin = await s.finished();
    assert.equal(fin.outcome, "succeeded");
    const items = s.items();
    assert.ok(items.every((e) => e.taskId === info.id && e.type === "ai_replace_email"));
    assert.deepEqual(
      items.map((e) => [e.key, e.status, e.message]),
      [
        ["a@x.com", "处理中", "正在替换辅助邮箱..."],
        ["a@x.com", "成功", "辅助邮箱替换成功"],
        ["b@x.com", "处理中", "正在替换辅助邮箱..."],
        ["b@x.com", "失败", ""],
        ["c@x.com", "处理中", "正在替换辅助邮箱..."],
        ["c@x.com", "错误", "炸了: c@x.com"],
      ],
    );
    assert.ok(s.logs().includes("[b@x.com] 失败: "));
    assert.ok(s.logs().includes("开始为 3 个账号执行替换辅助邮箱..."));
    assert.ok(s.logs().includes("✅ 替换辅助邮箱任务完成"));
    assert.deepEqual(fin.result, {
      total: 3,
      success_count: 1,
      failed_count: 2,
      results: [
        { email: "a@x.com", profileId: 1, status: "成功", message: "辅助邮箱替换成功" },
        { email: "b@x.com", profileId: 2, status: "失败", message: "" },
        { email: "c@x.com", profileId: 3, status: "错误", message: "炸了: c@x.com" },
      ],
    });
    // 进度
    const prog = s.events.filter(([c]) => c === IPC.event.taskProgress).map(([, p]) => [p.current, p.total]);
    assert.deepEqual(prog, [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  } finally {
    s.cleanup();
  }
});

test("停止：第二个账号前停止，只处理 1 个；结束状态 stopped", async () => {
  let ctxRef = null;
  const s = setup({
    hooks: {
      onCall: () => ctxRef.tasks.stop(), // 处理第一个账号时请求停止（当前账号无法中断）
    },
  });
  ctxRef = s.ctx;
  try {
    await s.call(
      START,
      "modify_2sv",
      [
        { email: "a@x.com", profileId: 1 },
        { email: "b@x.com", profileId: 2 },
        { email: "c@x.com", profileId: 3 },
      ],
      { newPhone: "1" },
    );
    const fin = await s.finished();
    assert.equal(fin.outcome, "stopped");
    assert.equal(s.calls.length, 1);
    assert.equal(fin.result.total, 3);
    assert.equal(fin.result.results.length, 1);
    assert.equal(fin.result.results[0].status, "成功");
    assert.ok(!s.items().some((e) => e.key === "b@x.com"));
  } finally {
    s.cleanup();
  }
});

test("执行前先只读检查：窗口已登录该账号 → 不进登录流程、不写库不广播，直接执行", async () => {
  const s = setup({ check: { "a@x.com": "in" } });
  seed(s.ctx, [{ email: "a@x.com", password: "pa", secret_key: "SK" }]);
  s.ctx.accountRepo().updateLoginStatus("a@x.com", "logged_in");
  try {
    await s.call(START, "replace_phone", [{ email: "a@x.com", profileId: 7 }], { newPhone: "13800" });
    const fin = await s.finished();
    assert.deepEqual(s.seq, ["check:a@x.com", "phone:a@x.com"], "已登录：检查完直接执行，不调用登录");
    assert.equal(s.loginCalls.length, 0);
    assert.equal(fin.result.results[0].status, "成功");
    assert.equal(s.events.filter(([c]) => c === IPC.event.accountsLoginStatusChanged).length, 0, "库里本来就是已登录，不广播");
  } finally {
    s.cleanup();
  }
});

test("执行前先只读检查：窗口已登录但库里是旧的「登录失败」→ 纠正为已登录并广播，仍不进登录流程", async () => {
  const s = setup({ check: { "a@x.com": "in" } });
  seed(s.ctx, [{ email: "a@x.com", password: "pa" }]);
  s.ctx.accountRepo().updateLoginStatus("a@x.com", "login_failed", "旧原因");
  try {
    await s.call(START, "kick_devices", [{ email: "a@x.com", profileId: 1 }], {});
    await s.finished();
    assert.deepEqual(s.seq, ["check:a@x.com", "kick:a@x.com"]);
    assert.equal(s.ctx.accountRepo().getAccountByEmail("a@x.com")?.login_status, "logged_in");
    const ev = s.events.filter(([c]) => c === IPC.event.accountsLoginStatusChanged).map(([, p]) => p);
    assert.deepEqual(ev, [{ emails: ["a@x.com"], status: "logged_in", lastError: null }]);
  } finally {
    s.cleanup();
  }
});

test("执行前先只读检查：检查本身出错 → 退回走登录流程（登录第一步还会再检查一次）", async () => {
  const s = setup({ check: { "a@x.com": "throw" } });
  seed(s.ctx, [{ email: "a@x.com", password: "pa" }]);
  try {
    await s.call(START, "kick_devices", [{ email: "a@x.com", profileId: 1 }], {});
    const fin = await s.finished();
    assert.deepEqual(s.seq, ["check:a@x.com", "login:a@x.com", "kick:a@x.com"]);
    assert.equal(fin.result.results[0].status, "成功");
  } finally {
    s.cleanup();
  }
});

test("停止：登录阶段请求停止 → 登录完也不执行操作，该账号记失败「已停止」，后面的账号不处理", async () => {
  let ctxRef = null;
  const s = setup({ hooks: { onLogin: () => ctxRef.tasks.stop() } });
  ctxRef = s.ctx;
  try {
    await s.call(
      START,
      "kick_devices",
      [
        { email: "a@x.com", profileId: 1 },
        { email: "b@x.com", profileId: 2 },
      ],
      {},
    );
    const fin = await s.finished();
    assert.equal(fin.outcome, "stopped");
    assert.deepEqual(s.seq, ["check:a@x.com", "login:a@x.com"], "登录后发现已停止：不踢设备，也不处理 b");
    assert.deepEqual(fin.result.results.map((r) => [r.email, r.status, r.message]), [["a@x.com", "失败", "已停止，未执行踢出设备"]]);
  } finally {
    s.cleanup();
  }
});

test("数据安全：窗口当前名称与 email 不一致 / 窗口不存在 → 跳过（失败），不调用 automation", async () => {
  const s = setup({ windowNames: { 2: "other@x.com", 3: null } });
  seed(s.ctx, [{ email: "a@x.com", password: "pa" }, { email: "b@x.com", password: "pb" }, { email: "c@x.com" }]);
  try {
    await s.call(
      START,
      "kick_devices",
      [
        { email: "a@x.com", profileId: 1 },
        { email: "b@x.com", profileId: 2 },
        { email: "c@x.com", profileId: 3 },
      ],
      {},
    );
    const fin = await s.finished();
    // 只有 a 真正执行；b、c 没有把账号信息交给 automation
    assert.deepEqual(s.calls.map((c) => [c.args[0], c.args[1].email]), [["1", "a@x.com"]]);
    assert.deepEqual(s.loginCalls.map((c) => c.account.email), ["a@x.com"], "窗口名不一致时也不登录");
    assert.deepEqual(
      fin.result.results.map((r) => [r.email, r.status]),
      [
        ["a@x.com", "成功"],
        ["b@x.com", "失败"],
        ["c@x.com", "失败"],
      ],
    );
    assert.match(fin.result.results[1].message, /当前名称为「other@x\.com」，与账号不一致，已跳过/);
    assert.match(fin.result.results[2].message, /不存在或无法读取，已跳过/);
    assert.equal(fin.result.success_count, 1);
    assert.equal(fin.result.failed_count, 2);
  } finally {
    s.cleanup();
  }
});

test("执行前确认登录：先登录（用数据库账号信息、带写库仓储与任务日志）再执行；已登录与否由登录函数自己判断", async () => {
  const s = setup();
  seed(s.ctx, [{ email: "a@x.com", password: "pa", secret_key: "SK" }]);
  try {
    await s.call(START, "replace_phone", [{ email: "a@x.com", profileId: 7 }], { newPhone: "13800" });
    const fin = await s.finished();
    assert.deepEqual(s.seq, ["check:a@x.com", "login:a@x.com", "phone:a@x.com"], "先检查、没登录才登录，再执行操作");
    const { browserId, account, opts } = s.loginCalls[0];
    assert.equal(browserId, "7");
    assert.deepEqual([account.email, account.password, account.secret_key], ["a@x.com", "pa", "SK"]);
    assert.equal(typeof opts.accountRepo?.updateLoginStatus, "function", "登录结果要写库");
    assert.equal(typeof opts.callback, "function", "登录步骤要进任务日志");
    assert.equal(fin.result.results[0].status, "成功");
    assert.equal(s.ctx.accountRepo().getAccountByEmail("a@x.com")?.login_status, "logged_in");
    const ev = s.events.filter(([c]) => c === IPC.event.accountsLoginStatusChanged).map(([, p]) => p);
    assert.deepEqual(ev, [{ emails: ["a@x.com"], status: "logged_in", lastError: null }], "广播给账号页 / AI 任务页");
  } finally {
    s.cleanup();
  }
});

test("执行前确认登录：登录失败 → 不执行操作，行失败并写明原因；写库并广播登录失败；下一个账号照常", async () => {
  const s = setup({ login: { "a@x.com": "fail" } });
  seed(s.ctx, [{ email: "a@x.com", password: "pa" }, { email: "b@x.com", password: "pb" }]);
  try {
    await s.call(
      START,
      "kick_devices",
      [
        { email: "a@x.com", profileId: 1 },
        { email: "b@x.com", profileId: 2 },
      ],
      {},
    );
    const fin = await s.finished();
    assert.deepEqual(s.seq, ["check:a@x.com", "login:a@x.com", "check:b@x.com", "login:b@x.com", "kick:b@x.com"], "a 登录失败就不踢设备");
    assert.deepEqual(fin.result.results.map((r) => [r.email, r.status]), [
      ["a@x.com", "失败"],
      ["b@x.com", "成功"],
    ]);
    assert.equal(fin.result.results[0].message, "登录失败，未执行踢出设备：需要验证码: 人机验证");
    const a = s.ctx.accountRepo().getAccountByEmail("a@x.com");
    assert.ok(a, "种子账号应存在");
    assert.deepEqual([a.login_status, a.last_error], ["login_failed", "需要验证码: 人机验证"]);
    const ev = s.events.filter(([c]) => c === IPC.event.accountsLoginStatusChanged).map(([, p]) => p);
    assert.deepEqual(ev, [
      { emails: ["a@x.com"], status: "login_failed", lastError: "需要验证码: 人机验证" },
      { emails: ["b@x.com"], status: "logged_in", lastError: null },
    ]);
  } finally {
    s.cleanup();
  }
});

test("执行前确认登录：登录函数抛异常 → 行失败并带需求文案，不执行操作", async () => {
  const s = setup({ login: { "a@x.com": "throw" } });
  seed(s.ctx, [{ email: "a@x.com", password: "pa" }]);
  try {
    await s.call(START, "kick_devices", [{ email: "a@x.com", profileId: 1 }], {});
    const fin = await s.finished();
    assert.deepEqual(s.seq, ["check:a@x.com", "login:a@x.com"]);
    assert.deepEqual(
      [fin.result.results[0].status, fin.result.results[0].message],
      ["失败", "登录失败，未执行踢出设备：登录炸了"],
    );
  } finally {
    s.cleanup();
  }
});

test("执行前确认登录：库里停在「登录中」（中间态）时不广播，界面不会被改成中间态", async () => {
  const s = setup({ login: { "a@x.com": "stuck" } });
  seed(s.ctx, [{ email: "a@x.com", password: "pa" }]);
  try {
    await s.call(START, "kick_devices", [{ email: "a@x.com", profileId: 1 }], {});
    await s.finished();
    assert.equal(s.events.filter(([c]) => c === IPC.event.accountsLoginStatusChanged).length, 0);
  } finally {
    s.cleanup();
  }
});

test("执行前确认登录：数据库没有该账号时照样检查登录（已登录可继续），但不广播", async () => {
  const s = setup();
  try {
    await s.call(START, "kick_devices", [{ email: "ghost@x.com", profileId: 3 }], {});
    const fin = await s.finished();
    assert.deepEqual(s.seq, ["check:ghost@x.com", "login:ghost@x.com", "kick:ghost@x.com"]);
    assert.equal(fin.result.results[0].status, "成功");
    assert.equal(s.events.filter(([c]) => c === IPC.event.accountsLoginStatusChanged).length, 0);
  } finally {
    s.cleanup();
  }
});

test("数据安全（生产路径）：未注入 getWindowName 时按 profileId 查 ixBrowser 窗口名校验", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "abb-ai-tasks-"));
  const waiters = [];
  const queries = [];
  /** @type {any} */
  const ix = {
    async getProfileList(q) {
      queries.push(q);
      const all = [
        { profile_id: 7, name: "real@x.com" },
        { profile_id: 8, name: "someone-else@x.com" },
      ];
      return q.profileId ? all.filter((w) => w.profile_id === q.profileId) : all;
    },
  };
  const ctx = createHostContext({
    dataRoot,
    emit: (channel, payload) => {
      if (channel === IPC.event.taskFinished) waiters.shift()?.(payload);
    },
    log: () => {},
    openDatabase: () => new DatabaseSync(":memory:"),
    ixClient: ix,
  });
  const fake = fakeAutomation();
  const dispatch = createDispatcher(createAiTasksHandlers(ctx, { automation: fake.automation }));
  try {
    const finished = new Promise((r) => waiters.push(r));
    const env = await dispatch(START, [
      "kick_devices",
      [
        { email: "real@x.com", profileId: 7 },
        { email: "real@x.com", profileId: 8 },
      ],
      {},
    ]);
    assert.equal(env.ok, true);
    const fin = await finished;
    assert.deepEqual(queries, [{ profileId: 7 }, { profileId: 8 }]);
    assert.deepEqual(fake.calls.map((c) => c.args[0]), ["7"]);
    assert.deepEqual(fin.result.results.map((r) => r.status), ["成功", "失败"]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("modify_auth：成功时只显示密钥前 8 位；无密钥 / 失败的文案", async () => {
  const s = setup({ behavior: { "b@x.com": "nosecret", "c@x.com": "fail" } });
  try {
    await s.call(
      START,
      "modify_auth",
      [
        { email: "a@x.com", profileId: 1 },
        { email: "b@x.com", profileId: 2 },
        { email: "c@x.com", profileId: 3 },
      ],
      {},
    );
    const fin = await s.finished();
    assert.deepEqual(
      fin.result.results.map((r) => [r.status, r.message]),
      [
        ["成功", "验证器已修改 (新密钥: ABCDEFGH...)"],
        ["成功", "验证器已修改"],
        ["失败", ""],
      ],
    );
    assert.ok(!JSON.stringify(s.events).includes("ABCDEFGHI"));
  } finally {
    s.cleanup();
  }
});

test("describeOutcome：与 Python 一致，直接使用 message（adapter 总带 message 键，缺省文案永不生效）", () => {
  assert.deepEqual(describeOutcome("replace_phone", { ok: false, message: "x" }), { status: "失败", message: "x" });
  assert.deepEqual(describeOutcome("modify_2sv", { ok: true, message: "" }), { status: "成功", message: "" });
  assert.deepEqual(describeOutcome("kick_devices", { ok: false, message: "" }), { status: "失败", message: "" });
  assert.deepEqual(describeOutcome("kick_devices", { ok: true, message: "成功踢出 2 个设备" }), {
    status: "成功",
    message: "成功踢出 2 个设备",
  });
});

test("全局单任务：已有任务时再启动 → TASK_BUSY", async () => {
  /** @type {any} */
  let release;
  const gate = new Promise((r) => (release = r));
  const s = setup();
  // 用一个挂起的任务占住运行器
  s.ctx.tasks.start("other", "占位", () => gate);
  try {
    await assert.rejects(
      s.call(START, "kick_devices", [{ email: "a@x.com", profileId: 1 }], {}),
      (e) => /** @type {any} */ (e).code === ERROR_CODES.TASK_BUSY,
    );
  } finally {
    release();
    await s.finished();
    s.cleanup();
  }
});

// ==================== 加载 ====================

test("load：平铺账号列表 + 分组统计；按 email 合并账号，只下发布尔值 / 登录状态，不含密码 / 密钥 / 辅助邮箱原文", async () => {
  const s = setup({
    groups: [
      { id: 2, title: "组A" },
      { id: 3, title: "\u0007" }, // 没有窗口，不显示
      { id: 5, title: "" },
    ],
    windows: [
      { profile_id: 11, name: "a@x.com", group_id: 2 },
      { profile_id: 12, name: "b@x.com" }, // 无 group_id → 未分组
      { profile_id: 13, name: "c@x.com", group_id: 9, group_name: "窗口里的组名" }, // group-list 里没有 → 用窗口自带组名
      { profile_id: 14, name: "d@x.com", group_id: 5 },
    ],
  });
  try {
    s.ctx
      .db()
      .prepare(
        "INSERT INTO accounts (email, password, secret_key, recovery_email, login_status, last_login_at) VALUES (?,?,?,?,?,?)",
      )
      .run("a@x.com", "PW-SECRET", "TOTPSECRETXYZ", "rec@y.com", "logged_in", "2026-09-23 16:14:36");
    seed(s.ctx, [{ email: "d@x.com" }]);
    /** @type {any} */
    const res = await s.call(LOAD);
    assert.equal(res.error, null);
    assert.equal(res.totalBrowsers, 4);
    assert.deepEqual(res.groups, [
      { groupId: 0, groupName: "未分组", count: 1 },
      { groupId: 2, groupName: "组A", count: 1 },
      { groupId: 5, groupName: "分组 5", count: 1 },
      { groupId: 9, groupName: "窗口里的组名", count: 1 },
    ]);
    assert.deepEqual(res.rows[0], {
      key: "b:11",
      profileId: 11,
      email: "a@x.com",
      groupId: 2,
      groupName: "组A",
      inDb: true,
      hasRecoveryEmail: true,
      hasSecret: true,
      loginStatus: "logged_in",
      lastLoginAt: "2026-09-23 16:14:36",
    });
    const b = res.rows[1];
    assert.deepEqual([b.inDb, b.hasRecoveryEmail, b.hasSecret, b.loginStatus, b.lastLoginAt], [false, false, false, "", null]);
    const d = res.rows[3];
    assert.deepEqual([d.inDb, d.hasSecret, d.loginStatus], [true, false, "not_logged"], "schema 默认 not_logged");
    const json = JSON.stringify(res);
    for (const secret of ["PW-SECRET", "TOTPSECRETXYZ", "rec@y.com"]) assert.ok(!json.includes(secret), `不应下发 ${secret}`);
  } finally {
    s.cleanup();
  }
});

test("load：分组与窗口列表并发请求，窗口列表按大页（≥1000）一次取完", async () => {
  /** @type {any[]} */
  const queries = [];
  let profileCalledWhileGroupPending = false;
  const s = setup({
    ctxOverrides: {
      ix: () => ({
        async getGroupList() {
          await new Promise((r) => setTimeout(r, 10));
          profileCalledWhileGroupPending = queries.length > 0;
          return [];
        },
        async getProfileList(q) {
          queries.push(q);
          return [{ profile_id: 1, name: "a@x.com" }];
        },
      }),
    },
  });
  try {
    /** @type {any} */
    const res = await s.call(LOAD);
    assert.equal(res.totalBrowsers, 1);
    assert.ok(profileCalledWhileGroupPending, "窗口列表应与分组列表并发发出");
    assert.equal(queries.length, 1);
    assert.ok(queries[0].limit >= 1000, `limit 应 ≥ 1000，实际 ${queries[0].limit}`);
  } finally {
    s.cleanup();
  }
});

test("load：读取失败时返回 error 字段而不抛异常", async () => {
  const s = setup({
    ctxOverrides: {
      ix: () => {
        throw new Error("ixBrowser 客户端创建失败");
      },
    },
  });
  try {
    const res = await s.call(LOAD);
    assert.deepEqual(res, { rows: [], groups: [], totalBrowsers: 0, error: "ixBrowser 客户端创建失败" });
  } finally {
    s.cleanup();
  }
});

test("load：带参数 → INVALID_ARGUMENT", async () => {
  const s = setup();
  try {
    await assert.rejects(s.call(LOAD, 1), (e) => /** @type {any} */ (e).code === ERROR_CODES.INVALID_ARGUMENT);
  } finally {
    s.cleanup();
  }
});

test("load：非法窗口 ID 为 null，重复 ID 退回序号 key（规则同首页）", () => {
  const t = buildAiTaskRows([], [], [
    { profile_id: "x", name: "a" },
    { profile_id: 1, name: "b" },
    { profile_id: 1, name: "c" },
    null,
  ]);
  assert.deepEqual(
    t.rows.map((r) => [r.key, r.profileId, r.email]),
    [
      ["b:0:0", null, "a"],
      ["b:1", 1, "b"],
      ["b:0:2", 1, "c"],
    ],
  );
});

test("load：email 取窗口名原文（不清洗），与数据库按原文匹配", () => {
  const t = buildAiTaskRows([{ email: "a@x.com\u200b" }], [], [{ profile_id: 1, name: "a@x.com\u200b" }]);
  assert.equal(t.rows[0]?.email, "a@x.com\u200b");
  assert.equal(t.rows[0]?.inDb, true);
});

// ==================== 参数校验 ====================

test("参数校验：各类非法输入 → INVALID_ARGUMENT", async () => {
  const ok = [{ email: "a@x.com", profileId: 1 }];
  const bad = [
    [],
    ["replace_phone", ok], // 缺参数对象
    ["replace_phone", ok, {}, 1], // 旧的 4 参数调用（带并发数）→ 拒绝
    ["nope", ok, {}],
    ["replace_phone", [], {}],
    ["replace_phone", "x", {}],
    ["replace_phone", [null], {}],
    ["replace_phone", [{ email: "", profileId: 1 }], {}],
    ["replace_phone", [{ email: "a@x.com", profileId: 0 }], {}],
    ["replace_phone", [{ email: "a@x.com", profileId: 1.5 }], {}],
    ["replace_phone", [{ email: "a@x.com", profileId: "1" }], {}],
    ["replace_phone", ok, null],
    ["replace_phone", ok, []],
    ["replace_phone", ok, { newEmail: "x" }], // 不属于该 kind 的键
    ["modify_auth", ok, { newPhone: "1" }], // 无额外输入的 kind
    ["replace_phone", ok, { newPhone: 123 }],
    ["replace_phone", ok, { newPhone: "1".repeat(201) }],
  ];
  const s = setup();
  try {
    for (const args of bad) {
      await assert.rejects(
        s.call(START, ...args),
        (e) => /** @type {any} */ (e).code === ERROR_CODES.INVALID_ARGUMENT,
        `应拒绝: ${JSON.stringify(args)}`,
      );
    }
    assert.equal(s.calls.length, 0);
  } finally {
    s.cleanup();
  }
});

test("parseStartArgs：去重保序，参数长度 200 可接受", () => {
  const r = parseStartArgs([
    "replace_phone",
    [
      { email: "a@x.com", profileId: 2 },
      { email: "b@x.com", profileId: 1 },
      { email: "a@x.com", profileId: 2 },
    ],
    { newPhone: "1".repeat(200) },
  ]);
  assert.deepEqual(r.items, [
    { email: "a@x.com", profileId: 2 },
    { email: "b@x.com", profileId: 1 },
  ]);
  const newPhone = r.params.newPhone;
  assert.ok(newPhone);
  assert.equal(newPhone.length, 200);
  assert.equal("concurrency" in r, false, "没有并发数");
});
