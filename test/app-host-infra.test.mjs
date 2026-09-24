/**
 * 业务页面阶段 0 的后端基建：任务运行器、进度解析、数据根目录、建表、上下文、handler 合并
 * 全部离线，不依赖 electron。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { ERROR_CODES } from "../app/shared/envelope.ts";
import { IPC } from "../app/shared/ipc.ts";
import { TaskRunner, createLogProgressTracker, toCloneable } from "../app/host/task-runner.ts";
import { createHostContext } from "../app/host/context.ts";
import { mergeHandlers } from "../app/host/handlers/index.ts";
import { resolveDataRoot } from "../app/main/data-root.ts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_MIGRATIONS, initDb } from "../src/db/schema.ts";

function recorder() {
  const events = [];
  let resolveFinished;
  const finished = new Promise((r) => (resolveFinished = r));
  const runner = new TaskRunner({
    emit: (channel, payload) => events.push([channel, payload]),
    now: () => 1000,
    onFinished: (e) => resolveFinished(e),
  });
  return { runner, events, finished };
}

// ==================== TaskRunner ====================

test("TaskRunner：成功任务推送日志、进度与 succeeded 结束事件", async () => {
  const { runner, events, finished } = recorder();
  const info = runner.start("login", "批量登录", async (api) => {
    api.log("开始");
    api.progress(1, 2);
    return { success_count: 1 };
  });
  assert.equal(info.type, "login");
  assert.equal(runner.busy, true);
  const done = await finished;
  assert.equal(done.outcome, "succeeded");
  assert.deepEqual(done.result, { success_count: 1 });
  assert.equal(runner.busy, false);
  assert.deepEqual(
    events.map(([c]) => c),
    [IPC.event.taskLog, IPC.event.taskProgress, IPC.event.taskFinished],
  );
});

test("TaskRunner：运行中再启动抛 TASK_BUSY（全局单任务互斥）", async () => {
  const { runner, finished } = recorder();
  let release;
  runner.start("a", "任务A", () => new Promise((r) => (release = r)));
  assert.throws(
    () => runner.start("b", "任务B", async () => {}),
    (e) => e.code === ERROR_CODES.TASK_BUSY && /任务A/.test(e.message),
  );
  await Promise.resolve();
  release();
  await finished;
  // 结束后可以再启动
  const info = runner.start("b", "任务B", async () => {});
  assert.equal(info.id, 2);
});

test("TaskRunner：stop 触发钩子，结束状态为 stopped；无任务时返回 false", async () => {
  const { runner, finished } = recorder();
  assert.equal(runner.stop(), false);
  let hookCalls = 0;
  let release;
  runner.start("login", "批量登录", (api) => {
    api.onStop(() => {
      hookCalls++;
      release();
    });
    return new Promise((r) => (release = r));
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runner.current().stopRequested, false);
  assert.equal(runner.stop(), true);
  assert.equal(runner.stop(), true); // 重复停止不重复触发钩子
  assert.equal(hookCalls, 1);
  const done = await finished;
  assert.equal(done.outcome, "stopped");
});

test("TaskRunner：已请求停止后注册的钩子立即执行", async () => {
  const { runner, finished } = recorder();
  let called = false;
  let release;
  runner.start("x", "X", (api) => {
    return new Promise((r) => {
      release = () => {
        api.onStop(() => (called = true));
        r();
      };
    });
  });
  await Promise.resolve();
  await Promise.resolve();
  runner.stop();
  release();
  await finished;
  assert.equal(called, true);
});

test("TaskRunner：item() 推送条目状态事件；任务结束后的迟到调用被丢弃", async () => {
  const { runner, events, finished } = recorder();
  let late;
  runner.start("ai_task", "替换手机号", async (api) => {
    api.item("a@x.com", "处理中", "");
    api.item("a@x.com", "成功", "已替换");
    late = api;
  });
  await finished;
  late.item("a@x.com", "错误", "迟到");
  const items = events.filter(([c]) => c === IPC.event.taskItem).map(([, p]) => p);
  assert.deepEqual(items, [
    { taskId: 1, type: "ai_task", key: "a@x.com", status: "处理中", message: "" },
    { taskId: 1, type: "ai_task", key: "a@x.com", status: "成功", message: "已替换" },
  ]);
});

test("TaskRunner：任务抛错 → failed，带错误信息", async () => {
  const { runner, finished } = recorder();
  runner.start("x", "X", async () => {
    throw new Error("炸了");
  });
  const done = await finished;
  assert.equal(done.outcome, "failed");
  assert.equal(done.error, "炸了");
  assert.equal(done.result, null);
});

test("toCloneable：去掉函数与 undefined，保证可跨进程", () => {
  assert.equal(toCloneable(undefined), null);
  assert.deepEqual(toCloneable({ a: 1, f: () => 1, u: undefined, d: [1, 2] }), { a: 1, d: [1, 2] });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof toCloneable(cyclic), "string");
});

// ==================== 进度解析（对标 orchestrator.py:417-424） ====================

test("进度解析：带 [i/n] 取 i，total 用任务账号数而非日志里的 n", () => {
  const calls = [];
  const track = createLogProgressTracker(5, (c, t) => calls.push([c, t]));
  track("[3/9] ✓ a@x.com 登录成功");
  assert.deepEqual(calls, [[3, 5]]);
});

test("进度解析：无关键词不计数；有关键词无 [i/n] 时累加且不超过 total", () => {
  const calls = [];
  const track = createLogProgressTracker(2, (c, t) => calls.push([c, t]));
  track("正在打开浏览器");
  track("跳过 a");
  track("b 失败");
  track("完成: 全部");
  assert.deepEqual(calls, [
    [1, 2],
    [2, 2],
    [2, 2],
  ]);
});

// ==================== 数据根目录 ====================

test("resolveDataRoot：ABB_DATA_ROOT 优先；打包取 exe 目录；开发取 package.json 所在目录（即仓库根）", () => {
  const base = { isPackaged: false, exePath: "C:/app/abb.exe", appPath: "D:/repo" };
  assert.match(resolveDataRoot({ ...base, env: { ABB_DATA_ROOT: "E:/tmp/x" } }).replace(/\\/g, "/"), /E:\/tmp\/x$/);
  assert.match(resolveDataRoot({ ...base, env: { ABB_DATA_ROOT: "   " } }).replace(/\\/g, "/"), /D:\/repo$/);
  assert.match(resolveDataRoot({ ...base, env: {} }).replace(/\\/g, "/"), /D:\/repo$/);
  assert.equal(resolveDataRoot({ ...base, isPackaged: true, env: {} }).replace(/\\/g, "/"), "C:/app");
});

test("开发态数据根目录就是 package.json 所在目录（运行时数据位置的唯一来源）", () => {
  // config.json / accounts.db 都只从这里取位置；不得再有代码按源码位置自己推算（ARCHITECTURE.md §6）。
  const appRoot = fileURLToPath(new URL("..", import.meta.url));
  assert.ok(existsSync(join(appRoot, "package.json")), `测试前提：${appRoot} 下应有 package.json`);
  const norm = (p) => resolve(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const devRoot = resolveDataRoot({ env: {}, isPackaged: false, exePath: "C:/app/abb.exe", appPath: appRoot });
  assert.equal(norm(devRoot), norm(appRoot));
});

// ==================== 建表 ====================

test("initDb：建出 7 张表与 accounts 全部迁移列，可重复执行", () => {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  initDb(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    "account_refresh_task_items",
    "account_refresh_tasks",
    "accounts",
    "proxies",
    "proxy_window_bindings",
    "task_run_history",
    "task_run_items",
  ]);
  const cols = db.prepare("PRAGMA table_info(accounts)").all();
  assert.equal(cols.length, 8 + ACCOUNT_MIGRATIONS.length);
  const byName = Object.fromEntries(cols.map((c) => [c.name, c.dflt_value]));
  assert.equal(byName.login_status, "'not_logged'");
  assert.equal(byName.family_slots_left, "-1");
});

test("initDb：列已存在以外的错误照常抛出", () => {
  const db = new DatabaseSync(":memory:");
  const fake = {
    exec(sql) {
      if (sql.startsWith("ALTER")) throw new Error("attempt to write a readonly database");
      db.exec(sql);
    },
  };
  assert.throws(() => initDb(fake), /readonly/);
});

// ==================== 上下文 ====================

test("HostContext：惰性打开数据库，首次访问时建表，之后复用同一句柄", () => {
  let opened = 0;
  const ctx = createHostContext({
    dataRoot: "X:/data",
    emit: () => {},
    log: () => {},
    openDatabase: (p) => {
      opened++;
      assert.match(p.replace(/\\/g, "/"), /X:\/data\/accounts\.db$/);
      return new DatabaseSync(":memory:");
    },
  });
  assert.equal(opened, 0);
  assert.match(ctx.configFile.replace(/\\/g, "/"), /X:\/data\/config\.json$/);
  const a = ctx.db();
  const b = ctx.db();
  assert.equal(a, b);
  assert.equal(opened, 1);
  assert.deepEqual(ctx.accountRepo().getAllAccounts(), []);
});

// ==================== handler 合并 ====================

test("mergeHandlers：重名通道直接报错", () => {
  assert.throws(() => mergeHandlers({ a: () => 1 }, { a: () => 2 }), /重复登记: a/);
  assert.deepEqual(Object.keys(mergeHandlers({ a: () => 1 }, { b: () => 2 })), ["a", "b"]);
});
