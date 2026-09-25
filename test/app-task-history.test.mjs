/**
 * 任务历史（批量任务结果落库 + 导出）
 *
 * 本地新增能力：Python 侧没有对应实现（批量任务结果只打在界面日志里，关掉就没了）。
 * 覆盖：仓储落库与计数、CSV 转义、TaskRunner 收尾回调、host 装配端到端、handler 通道与校验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { ERROR_CODES } from "../app/shared/envelope.ts";
import { IPC } from "../app/shared/ipc.ts";
import { TASK_HISTORY_INVOKE } from "../app/shared/channels/task-history.ts";
import { HOME_INVOKE, HOME_TASK_TYPES } from "../app/shared/channels/home.ts";
import { createHostContext } from "../app/host/context.ts";
import { createDispatcher } from "../app/host/dispatch.ts";
import { createTaskHistoryHandlers } from "../app/host/handlers/task-history.ts";
import { createHomeHandlers } from "../app/host/handlers/home.ts";
import { TaskRunner } from "../app/host/task-runner.ts";
import { TaskHistoryRepository } from "../src/db/task-history-repository.ts";
import { initDb } from "../src/db/schema.ts";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  return db;
}

/** 轮询等待条件成立（任务在后台跑，用微任务队列） */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * 取数组第 index 项并断言存在（noUncheckedIndexedAccess 下把下标访问收窄成非空）
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @returns {T}
 */
function at(list, index) {
  const value = list[index];
  assert.ok(value !== undefined, `下标越界: ${index}`);
  return value;
}

function recordOf(overrides = {}) {
  return {
    taskType: "ai_kick_devices",
    label: "踢出设备（2 个账号）",
    outcome: "succeeded",
    startedAt: Date.parse("2026-09-24T10:00:00"),
    finishedAt: Date.parse("2026-09-24T10:00:12"),
    items: [
      { key: "a@x.com", status: "成功", message: "" },
      { key: "b@x.com", status: "失败", message: "需要先登录账号" },
      { key: "c@x.com", status: "错误", message: "窗口打不开" },
    ],
    error: null,
    ...overrides,
  };
}

// ==================== 仓储 ====================

test("TaskHistoryRepository：落库任务与逐条目，计数按状态归类", () => {
  const repo = new TaskHistoryRepository(makeDb());
  const runId = repo.record(recordOf());

  assert.equal(runId, 1);
  const runs = repo.listRuns();
  assert.equal(runs.length, 1);
  const run = at(runs, 0);
  assert.equal(run.task_type, "ai_kick_devices");
  assert.equal(run.outcome, "succeeded");
  assert.equal(run.total, 3);
  assert.equal(run.success_count, 1);
  assert.equal(run.failed_count, 2); // 「失败」与「错误」都算失败
  assert.equal(run.started_at, "2026-09-24 10:00:00");
  assert.equal(run.finished_at, "2026-09-24 10:00:12");

  assert.deepEqual(
    repo.listItems(runId).map((i) => [i.item_key, i.status, i.message]),
    [
      ["a@x.com", "成功", ""],
      ["b@x.com", "失败", "需要先登录账号"],
      ["c@x.com", "错误", "窗口打不开"],
    ],
  );
});

test("TaskHistoryRepository：多次运行按倒序返回，limit 生效，条目按所属运行隔离", () => {
  const repo = new TaskHistoryRepository(makeDb());
  repo.record(recordOf({ label: "第一次", items: [{ key: "first@x.com", status: "成功", message: "" }] }));
  repo.record(recordOf({ label: "第二次", items: [{ key: "second@x.com", status: "成功", message: "" }] }));

  const runs = repo.listRuns();
  assert.deepEqual(
    runs.map((r) => r.label),
    ["第二次", "第一次"],
  );
  assert.equal(repo.listRuns({ limit: 1 }).length, 1);
  const firstRun = at(runs, 1); // 倒序：第一次在数组末尾
  const secondRun = at(runs, 0);
  assert.equal(at(repo.listItems(firstRun.id), 0).item_key, "first@x.com");
  assert.equal(at(repo.listItems(secondRun.id), 0).item_key, "second@x.com");
});

test("TaskHistoryRepository.exportText：表头 + 逐条目一行；逗号/引号/换行被正确转义", () => {
  const repo = new TaskHistoryRepository(makeDb());
  repo.record(
    recordOf({
      label: "标签,带逗号",
      error: "err,or",
      items: [{ key: 'a"b@x.com', status: "失败", message: "第一行\n第二行" }],
    }),
  );

  const csv = repo.exportText();
  const lines = csv.split("\n");
  assert.equal(
    lines[0],
    "run_id,任务类型,标签,结果,开始时间,结束时间,总数,成功,失败,账号,条目状态,条目消息,错误",
  );
  assert.ok(csv.includes('"标签,带逗号"'), csv);
  assert.ok(csv.includes('"a""b@x.com"'), csv);
  assert.ok(csv.includes('"第一行\n第二行"'), csv);
  assert.ok(csv.includes('"err,or"'), csv);
  // 表头 1 行 + 1 个条目 1 行 = 2 行（但消息里的换行会让 split("\n") 多出一段）
  assert.equal(lines.filter((l) => l.startsWith("1,ai_kick_devices")).length, 1);
});

test("TaskHistoryRepository：没有条目的任务也能落库（total=0）", () => {
  const repo = new TaskHistoryRepository(makeDb());
  const runId = repo.record(recordOf({ items: [] }));
  const runs = repo.listRuns();
  const run = at(runs, 0);
  assert.equal(run.total, 0);
  assert.equal(run.success_count, 0);
  assert.deepEqual(repo.listItems(runId), []);
  assert.equal(repo.exportText().split("\n").length, 2); // 表头 + 一行（LEFT JOIN 出一行空条目）
});

// ==================== TaskRunner 收尾回调 ====================

test("TaskRunner：任务收尾时把任务级 + 逐条目结果交给 onRecord", async () => {
  const records = [];
  const runner = new TaskRunner({
    emit: () => {},
    onRecord: (r) => records.push(r),
  });

  runner.start("ai_kick_devices", "踢出设备（1 个）", async (api) => {
    api.item("a@x.com", "成功", "");
    api.item("b@x.com", "失败", "需要先登录账号");
    return { total: 2 };
  });
  await waitFor(() => records.length === 1);

  assert.equal(records[0].taskType, "ai_kick_devices");
  assert.equal(records[0].label, "踢出设备（1 个）");
  assert.equal(records[0].outcome, "succeeded");
  assert.deepEqual(
    records[0].items.map((i) => [i.key, i.status]),
    [
      ["a@x.com", "成功"],
      ["b@x.com", "失败"],
    ],
  );
  assert.equal(records[0].error, null);
  assert.ok(records[0].finishedAt >= records[0].startedAt);
});

test("TaskRunner：任务抛错时落库 outcome=failed 且带错误消息", async () => {
  const records = [];
  const runner = new TaskRunner({ emit: () => {}, onRecord: (r) => records.push(r) });

  runner.start("demo", "会失败的任务", async () => {
    throw new Error("boom");
  });
  await waitFor(() => records.length === 1);

  assert.equal(records[0].outcome, "failed");
  assert.equal(records[0].error, "boom");
  assert.deepEqual(records[0].items, []);
});

test("TaskRunner：请求停止后收尾 outcome=stopped", async () => {
  const records = [];
  const runner = new TaskRunner({ emit: () => {}, onRecord: (r) => records.push(r) });

  runner.start("demo", "可停止的任务", async (api) => {
    api.item("a@x.com", "处理中", "");
    runner.stop();
    await new Promise((r) => setTimeout(r, 5));
    return { stopped: true };
  });
  await waitFor(() => records.length === 1);

  assert.equal(records[0].outcome, "stopped");
  assert.equal(records[0].items.length, 1);
});

test("TaskRunner：onRecord 抛错不影响任务本身的结果与结束事件", async () => {
  const finished = [];
  const runner = new TaskRunner({
    emit: () => {},
    onFinished: (e) => finished.push(e),
    onRecord: () => {
      throw new Error("写库炸了");
    },
  });

  runner.start("demo", "任务", async () => ({ ok: true }));
  await waitFor(() => finished.length === 1);
  assert.equal(finished[0].outcome, "succeeded");
});

test("TaskRunner：同一个 key 多次上报只保留最终状态（AI 任务的「处理中 → 成功」不写成两行）", async () => {
  const records = [];
  const runner = new TaskRunner({ emit: () => {}, onRecord: (r) => records.push(r) });

  runner.start("ai_kick_devices", "踢出设备（2 个）", async (api) => {
    api.item("a@x.com", "处理中", "正在踢出设备");
    api.item("a@x.com", "成功", "");
    api.item("b@x.com", "处理中", "正在踢出设备");
    api.item("b@x.com", "失败", "需要先登录账号");
    return { total: 2 };
  });
  await waitFor(() => records.length === 1);

  assert.deepEqual(
    records[0].items.map((i) => [i.key, i.status, i.message]),
    [
      ["a@x.com", "成功", ""],
      ["b@x.com", "失败", "需要先登录账号"],
    ],
  );

  // 落库口径：总数 = 账号数，不是条目事件数
  const repo = new TaskHistoryRepository(makeDb());
  const runId = repo.record(records[0]);
  const run = at(repo.listRuns(), 0);
  assert.equal(run.total, 2);
  assert.equal(run.success_count, 1);
  assert.equal(run.failed_count, 1);
  assert.equal(repo.listItems(runId).length, 2);
});

test("TaskHistoryRepository：逐条目写入失败时整条运行回滚（不留「有统计、没条目」的半条）", () => {
  const repo = new TaskHistoryRepository(makeDb());
  // key 传对象：node:sqlite 绑定不了，写条目时抛错
  const bad = recordOf({ items: [{ key: {}, status: "成功", message: "" }] });
  assert.throws(() => repo.record(bad));
  assert.deepEqual(repo.listRuns(), []);
});

// ==================== host 装配（端到端） ====================

function makeContext(options = {}) {
  const events = [];
  const waiters = [];
  const ctx = createHostContext({
    dataRoot: "X:/abb-task-history-test",
    emit: (channel, payload) => {
      events.push([channel, payload]);
      if (channel === IPC.event.taskFinished) waiters.shift()?.(payload);
    },
    log: () => {},
    openDatabase: () => new DatabaseSync(":memory:"),
    ixClient: options.ixClient,
  });
  return { ctx, events, nextFinished: () => new Promise((r) => waiters.push(r)) };
}

test("host 装配：真实跑一个任务后，任务历史里能查到它（含逐条目）", async () => {
  const { ctx, nextFinished } = makeContext();
  const finished = nextFinished();

  ctx.tasks.start("demo_task", "演示任务（1 个）", async (api) => {
    api.item("a@x.com", "成功", "");
    api.item("b@x.com", "失败", "示例失败");
    return { total: 2 };
  });
  await finished;
  // 落库发生在 finish 的同一步（onFinished 之后），此时应已可读
  const rows = ctx.taskHistoryRepo().listRuns();
  assert.equal(rows.length, 1);
  const row = at(rows, 0);
  assert.equal(row.task_type, "demo_task");
  assert.equal(row.label, "演示任务（1 个）");
  assert.equal(row.total, 2);
  assert.equal(row.success_count, 1);
  assert.equal(row.failed_count, 1);
  assert.deepEqual(
    ctx.taskHistoryRepo().listItems(row.id).map((i) => i.item_key),
    ["a@x.com", "b@x.com"],
  );
});

/**
 * 真机缺陷回归：首页批量打开窗口的任务，历史里必须带逐条目。
 * 真机事实（2026-09-24，窗口 7）：任务成功但 total=0、逐条目 0 条 —— 任务体只打了日志，
 * 从没调过 api.item，于是落库时统计不到任何条目。
 */
test("host 装配：首页批量打开窗口在任务历史里带逐条目（total/成功/失败 不再全为 0）", async () => {
  const ix = {
    async openProfile(id) {
      if (id === 22) throw new Error("profile not exist");
      return { ws: "", debugging_address: "", webdriver: "", pid: 1, profile_id: id };
    },
  };
  const { ctx, nextFinished } = makeContext({ ixClient: ix });
  const dispatch = createDispatcher(createHomeHandlers(ctx));
  const finished = nextFinished();

  const env = await dispatch(HOME_INVOKE.homeOpenBrowsers, [[21, 22, 23]]);
  assert.equal(env.ok, true);
  const openedTask = /** @type {{ type: string }} */ (env.data);
  assert.equal(openedTask.type, HOME_TASK_TYPES.open);
  await finished;

  const runs = ctx.taskHistoryRepo().listRuns();
  assert.equal(runs.length, 1);
  const run = at(runs, 0);
  assert.equal(run.task_type, HOME_TASK_TYPES.open);
  assert.equal(run.outcome, "succeeded");
  assert.equal(run.total, 3);
  assert.equal(run.success_count, 2);
  assert.equal(run.failed_count, 1);
  assert.deepEqual(
    ctx.taskHistoryRepo().listItems(run.id).map((i) => [i.item_key, i.status, i.message]),
    [
      ["21", "成功", ""],
      ["22", "失败", "窗口打开失败: profile not exist"],
      ["23", "成功", ""],
    ],
  );
});

// ==================== handler ====================

test("handler：list / items / export 走通；非法参数 → INVALID_ARGUMENT", async () => {
  const { ctx } = makeContext();
  ctx.taskHistoryRepo().record(
    recordOf({ items: [{ key: "a@x.com", status: "成功", message: "" }] }),
  );
  const dispatch = createDispatcher(createTaskHistoryHandlers(ctx));
  /** @returns {Promise<any>} 信封里的 data（已确保 ok） */
  const call = async (channel, ...args) => {
    const env = await dispatch(channel, args);
    if (!env.ok) {
      /** @type {Error & { code?: string }} */
      const e = new Error(env.error.message);
      e.code = env.error.code;
      throw e;
    }
    return env.data;
  };

  const runs = await call(TASK_HISTORY_INVOKE.taskHistoryList);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].task_type, "ai_kick_devices");

  const items = await call(TASK_HISTORY_INVOKE.taskHistoryItems, runs[0].id);
  assert.equal(items[0].item_key, "a@x.com");

  const csv = await call(TASK_HISTORY_INVOKE.taskHistoryExport);
  assert.ok(csv.includes("a@x.com"));

  await assert.rejects(
    call(TASK_HISTORY_INVOKE.taskHistoryItems, 0),
    (e) => /** @type {any} */ (e).code === ERROR_CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    call(TASK_HISTORY_INVOKE.taskHistoryItems, "1"),
    (e) => /** @type {any} */ (e).code === ERROR_CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    call(TASK_HISTORY_INVOKE.taskHistoryList, -5),
    (e) => /** @type {any} */ (e).code === ERROR_CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    call(TASK_HISTORY_INVOKE.taskHistoryExport, 0),
    (e) => /** @type {any} */ (e).code === ERROR_CODES.INVALID_ARGUMENT,
  );
});

// ==================== 参数快照 / 筛选 / 重跑（2026-09-26 新增） ====================

test("TaskRunner：启动时传的参数快照会随运行一起落库（重跑的依据）", async () => {
  const { ctx, nextFinished } = makeContext();
  const finished = nextFinished();
  /** @type {unknown} */
  const snapshot = { action: "login", rows: [{ email: "a@x.com", browserId: "5" }], options: { concurrency: 1 } };

  ctx.tasks.start("login", "登录（1 个账号）", async () => "done", snapshot);
  await finished;

  const run = at(ctx.taskHistoryRepo().listRuns(), 0);
  assert.ok(run.params, "快照必须落库");
  assert.deepEqual(JSON.parse(String(run.params)), snapshot);
  assert.equal(ctx.taskHistoryRepo().listItems(run.id).length, 0, "本用例没上报条目");
});

test("TaskRunner：不传参数时 params 为 null（旧记录/无参数任务 → 界面重跑按钮禁用）", async () => {
  const { ctx, nextFinished } = makeContext();
  const finished = nextFinished();
  ctx.tasks.start("demo_task", "无参数任务", async () => null);
  await finished;
  assert.equal(at(ctx.taskHistoryRepo().listRuns(), 0).params, null);
});


test("listRuns：itemEmail 里的 _ 与 % 按字面匹配，不当 LIKE 通配符（审查修正）", () => {
  const repo = new TaskHistoryRepository(makeDb());
  const item = (key) => [{ key, status: "成功", message: "" }];
  repo.record(recordOf({ taskType: "a_task", items: item("john_doe@x.com") }));
  repo.record(recordOf({ taskType: "b_task", items: item("johnXdoe@x.com") }));
  repo.record(recordOf({ taskType: "c_task", items: item("50%@x.com") }));
  repo.record(recordOf({ taskType: "d_task", items: item("plain@x.com") }));

  // _ 是「任意单字符」：不转义时会连带命中 johnXdoe
  assert.deepEqual(
    repo.listRuns({ itemEmail: "john_doe@x.com" }).map((r) => r.task_type),
    ["a_task"],
    "下划线必须按字面匹配",
  );
  // % 是「任意长度」：不转义时会命中全部
  assert.deepEqual(
    repo.listRuns({ itemEmail: "50%@x.com" }).map((r) => r.task_type),
    ["c_task"],
    "百分号必须按字面匹配",
  );
  // 反斜杠本身也要能按字面查（转义字符不能把查询搞乱）
  assert.deepEqual(repo.listRuns({ itemEmail: "x\\y@x.com" }), []);
});
test("TaskHistoryRepository：listRuns 可按类型 / 结果 / 账号 / 时间段筛选（都在 SQL 里做）", () => {
  const repo = new TaskHistoryRepository(makeDb());
  repo.record(
    recordOf({
      taskType: "ai_kick_devices",
      outcome: "succeeded",
      startedAt: Date.parse("2026-09-24T10:00:00"),
      finishedAt: Date.parse("2026-09-24T10:00:10"),
      items: [{ key: "a@x.com", status: "成功", message: "" }],
    }),
  );
  repo.record(
    recordOf({
      taskType: "login",
      outcome: "failed",
      label: "登录（2 个账号）",
      startedAt: Date.parse("2026-09-25T11:00:00"),
      finishedAt: Date.parse("2026-09-25T11:00:20"),
      items: [{ key: "b@x.com", status: "失败", message: "需要先登录账号" }],
    }),
  );

  assert.equal(repo.listRuns().length, 2);
  assert.deepEqual(repo.listRuns({ taskType: "login" }).map((r) => r.task_type), ["login"]);
  assert.deepEqual(repo.listRuns({ outcome: "succeeded" }).map((r) => r.task_type), ["ai_kick_devices"]);
  assert.deepEqual(repo.listRuns({ itemEmail: "b@x.com" }).map((r) => r.task_type), ["login"]);
  assert.deepEqual(repo.listRuns({ itemEmail: "@x.com" }).length, 2, "模糊匹配命中两条");
  assert.deepEqual(repo.listRuns({ itemEmail: "不存在@x.com" }), []);
  assert.deepEqual(
    repo.listRuns({ from: "2026-09-25 00:00:00" }).map((r) => r.task_type),
    ["login"],
    "起始时间下限生效",
  );
  assert.deepEqual(
    repo.listRuns({ to: "2026-09-24 23:59:59" }).map((r) => r.task_type),
    ["ai_kick_devices"],
    "结束时间上限生效",
  );
  assert.equal(repo.listRuns({ taskType: "login", outcome: "succeeded" }).length, 0, "条件之间是 AND");
  assert.equal(repo.listRuns({ limit: 1 }).length, 1);
});

test("TaskHistoryRepository：getRun 取单条；不存在的返回 null", () => {
  const repo = new TaskHistoryRepository(makeDb());
  const id = repo.record(recordOf({ params: { kind: "replace_phone" } }));
  assert.equal(at([repo.getRun(id)], 0)?.task_type, "ai_kick_devices");
  assert.equal(repo.getRun(999), null);
});

test("handler：list 的筛选参数透传；非法查询条件 → INVALID_ARGUMENT", async () => {
  const { ctx } = makeContext();
  ctx.taskHistoryRepo().record(recordOf({ taskType: "login", items: [{ key: "a@x.com", status: "成功", message: "" }] }));
  ctx.taskHistoryRepo().record(recordOf({ taskType: "ai_kick_devices", items: [{ key: "b@x.com", status: "成功", message: "" }] }));
  const dispatch = createDispatcher(createTaskHistoryHandlers(ctx));

  const filtered = await dispatch(TASK_HISTORY_INVOKE.taskHistoryList, [{ taskType: "login" }]);
  assert.equal(filtered.ok, true);
  assert.deepEqual(
    /** @type {any[]} */ (filtered.ok ? filtered.data : []).map((r) => r.task_type),
    ["login"],
  );

  const byEmail = await dispatch(TASK_HISTORY_INVOKE.taskHistoryList, [{ itemEmail: "b@x.com" }]);
  assert.deepEqual(
    /** @type {any[]} */ (byEmail.ok ? byEmail.data : []).map((r) => r.task_type),
    ["ai_kick_devices"],
  );

  for (const bad of [-5, "x", 42, { taskType: 7 }, { taskType: "a".repeat(201) }]) {
    const env = await dispatch(TASK_HISTORY_INVOKE.taskHistoryList, [bad]);
    assert.equal(env.ok, false, `应拒绝: ${JSON.stringify(bad)}`);
    assert.equal(env.ok === false && env.error.code, ERROR_CODES.INVALID_ARGUMENT);
  }
});

test("重跑：没有参数快照的旧记录直接拒绝（不猜参数）", async () => {
  const { ctx } = makeContext();
  const id = ctx.taskHistoryRepo().record(recordOf({ params: undefined }));
  const dispatch = createDispatcher(createTaskHistoryHandlers(ctx));

  const env = await dispatch(TASK_HISTORY_INVOKE.taskHistoryRerun, [id]);
  assert.equal(env.ok, false);
  assert.equal(env.ok === false && env.error.code, ERROR_CODES.INVALID_ARGUMENT);
  assert.match(env.ok === false ? env.error.message : "", /没有参数快照/);
});

test("重跑：类型不支持（导入 / 建窗等）直接拒绝", async () => {
  const { ctx } = makeContext();
  const id = ctx.taskHistoryRepo().record(
    recordOf({ taskType: "totp_import", params: { items: [] } }),
  );
  const dispatch = createDispatcher(createTaskHistoryHandlers(ctx));

  const env = await dispatch(TASK_HISTORY_INVOKE.taskHistoryRerun, [id]);
  assert.equal(env.ok, false);
  assert.match(env.ok === false ? env.error.message : "", /不支持重跑/);
});

test("重跑：不存在的 runId → INVALID_ARGUMENT", async () => {
  const { ctx } = makeContext();
  const dispatch = createDispatcher(createTaskHistoryHandlers(ctx));
  for (const bad of [999, 0, "1", null]) {
    const env = await dispatch(TASK_HISTORY_INVOKE.taskHistoryRerun, [bad]);
    assert.equal(env.ok, false, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

test("重跑：账号快照（action=login）会真的重新启动一个 login 任务并落一条新记录", async () => {
  // 假 ixBrowser：登录一碰就连不上，任务会失败，但「重跑确实启动了同类型任务」这件事可验证
  const ix = {
    async getProfileList() {
      throw new Error("ixBrowser 不可用（测试替身）");
    },
    async openProfile() {
      throw new Error("ixBrowser 不可用（测试替身）");
    },
  };
  const { ctx, nextFinished } = makeContext({ ixClient: ix });
  // 全假夹具：邮箱与窗口 ID 都用明显不存在的值，别写成真实账号的样子（曾借用真实窗口 id 配假邮箱，被误读成系统记错账号）
  ctx.accountRepo().upsertAccount({ email: "fixture-rerun@example.com", browser_profile_id: "9001", password: "p" });

  const id = ctx.taskHistoryRepo().record(
    recordOf({
      taskType: "login",
      outcome: "failed",
      params: { action: "login", rows: [{ email: "fixture-rerun@example.com", browserId: "9001" }], options: { concurrency: 1 } },
    }),
  );

  const dispatch = createDispatcher(createTaskHistoryHandlers(ctx));
  const finished = nextFinished();
  const env = await dispatch(TASK_HISTORY_INVOKE.taskHistoryRerun, [id]);
  assert.equal(env.ok, true, env.ok === false ? env.error.message : "");
  assert.equal(env.ok === true && /** @type {any} */ (env.data).type, "login", "重跑起的是同类型任务");

  await finished;
  const runs = ctx.taskHistoryRepo().listRuns({ taskType: "login" });
  assert.equal(runs.length, 2, "原记录 + 重跑产生的新记录");
  assert.ok(runs.some((r) => r.id !== id), "应新增一条运行记录");
});
