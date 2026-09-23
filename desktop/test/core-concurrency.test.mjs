/**
 * core/semaphore.ts + core/retry-helper.ts 单测（全离线）
 *
 * 覆盖：
 *   - Semaphore：计数 / FIFO / run() 异常释放 / 并发上限 / gatherSettled
 *   - RetryHelper：退避序列、返回形状、不可重试提前返回、withRetry 高阶函数
 *   - FailedTaskQueue：去重语义（照搬 Python：context 被丢弃）、过滤、save/load 往返
 *
 * 所有 sleep 一律注入假实现（只记录参数，不真等）；
 * 落盘测试写 node:os.tmpdir()，绝不碰工作区与仓库根的 failed_tasks.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Semaphore, gatherSettled } from "../src/core/semaphore.ts";
import {
  DEFAULT_BACKOFF_FACTOR,
  DEFAULT_BASE_DELAY,
  DEFAULT_MAX_DELAY,
  DEFAULT_MAX_RETRIES,
  FailedTaskQueue,
  RetryHelper,
  createFailedTask,
  defaultIsRetryable,
  errorMessage,
  withRetry,
  withRetryAsync,
} from "../src/core/retry-helper.ts";

// ==================== 工具 ====================

/** 让出事件循环若干轮（不依赖真实计时器时长） */
async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/** 假 sleep：只记录毫秒数，立即返回 */
function fakeSleep() {
  const calls = [];
  return {
    calls,
    fn: async (ms) => {
      calls.push(ms);
    },
  };
}

/** 临时目录（node:os.tmpdir），用完即删 */
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retry-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ==================== Semaphore ====================

test("Semaphore: 非正整数许可数直接抛错", () => {
  assert.throws(() => new Semaphore(0), /许可数必须是正整数/);
  assert.throws(() => new Semaphore(-1), /许可数必须是正整数/);
  assert.throws(() => new Semaphore(1.5), /许可数必须是正整数/);
});

test("Semaphore: acquire 递减计数、release 递增计数", async () => {
  const sem = new Semaphore(2);
  assert.equal(sem.available, 2);
  assert.equal(sem.pending, 0);

  await sem.acquire();
  assert.equal(sem.available, 1);
  await sem.acquire();
  assert.equal(sem.available, 0);

  sem.release();
  assert.equal(sem.available, 1);
  sem.release();
  assert.equal(sem.available, 2);
});

test("Semaphore: 无许可时排队，release 按 FIFO 唤醒最早的等待者", async () => {
  const sem = new Semaphore(1);
  const order = [];

  await sem.acquire(); // 占满
  const p1 = sem.acquire().then(() => order.push(1));
  const p2 = sem.acquire().then(() => order.push(2));
  const p3 = sem.acquire().then(() => order.push(3));

  await tick(1);
  assert.equal(sem.pending, 3);
  assert.equal(sem.available, 0);

  sem.release();
  sem.release();
  sem.release();
  await Promise.all([p1, p2, p3]);

  assert.deepEqual(order, [1, 2, 3]);
  // 许可直接交给等待者，available 不回涨
  assert.equal(sem.available, 0);
  assert.equal(sem.pending, 0);
});

test("Semaphore: run() 正常返回值并释放许可", async () => {
  const sem = new Semaphore(1);
  const value = await sem.run(async () => "ok");
  assert.equal(value, "ok");
  assert.equal(sem.available, 1);
});

test("Semaphore: run() 回调抛错时同样释放许可", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(
    () => sem.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(sem.available, 1);
  // 释放过后还能继续用
  assert.equal(await sem.run(async () => 42), 42);
});

test("Semaphore: permits=2 时 5 个任务的同时在跑峰值恰为 2", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;

  const run = () =>
    sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(3);
      active -= 1;
    });

  await Promise.all([run(), run(), run(), run(), run()]);

  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(sem.available, 2);
});

test("gatherSettled: 混合成功/失败，顺序与入参一致且形状正确", async () => {
  const err = new Error("bad");
  const results = await gatherSettled([
    Promise.resolve(1),
    Promise.reject(err),
    Promise.resolve("three"),
  ]);

  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { ok: true, value: 1 });
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, err);
  assert.deepEqual(results[2], { ok: true, value: "three" });
});

test("gatherSettled: 空数组返回空数组", async () => {
  assert.deepEqual(await gatherSettled([]), []);
});

// ==================== RetryHelper ====================

test("RetryHelper: 默认参数与 Python 一致", () => {
  const helper = new RetryHelper();
  assert.equal(helper.maxRetries, DEFAULT_MAX_RETRIES);
  assert.equal(helper.baseDelay, DEFAULT_BASE_DELAY);
  assert.equal(helper.backoffFactor, DEFAULT_BACKOFF_FACTOR);
  assert.equal(helper.maxDelay, DEFAULT_MAX_DELAY);
  assert.equal(DEFAULT_MAX_RETRIES, 3);
  assert.equal(DEFAULT_BASE_DELAY, 2.0);
  assert.equal(DEFAULT_MAX_DELAY, 60.0);
});

test("RetryHelper: calculateDelay 默认参数下退避序列为 2/4/8/16/32/60 秒（含上限截断）", () => {
  const helper = new RetryHelper();
  const delays = [0, 1, 2, 3, 4, 5].map((n) => helper.calculateDelay(n));
  assert.deepEqual(delays, [2, 4, 8, 16, 32, 60]);
  // 再往后一直被 maxDelay 压住
  assert.equal(helper.calculateDelay(10), 60);
});

test("RetryHelper: executeAsync 实际 sleep 的毫秒序列 = 2000/4000/8000/16000/32000", async () => {
  const sleep = fakeSleep();
  const helper = new RetryHelper({ maxRetries: 5, sleepImpl: sleep.fn });

  let calls = 0;
  const [success, err] = await helper.executeAsync(async () => {
    calls += 1;
    throw new Error("connection reset"); // 命中 NETWORK_KEYWORDS，可重试
  });

  assert.equal(success, false);
  assert.equal(err, "connection reset");
  assert.equal(calls, 6); // maxRetries + 1 次总执行
  assert.deepEqual(sleep.calls, [2000, 4000, 8000, 16000, 32000]);
});

test("RetryHelper: executeAsync 成功返回 [true, result] 且不 sleep", async () => {
  const sleep = fakeSleep();
  const helper = new RetryHelper({ sleepImpl: sleep.fn });
  const outcome = await helper.executeAsync(async (a, b) => a + b, 1, 2);
  assert.deepEqual(outcome, [true, 3]);
  assert.deepEqual(sleep.calls, []);
});

test("RetryHelper: 中途成功则停止重试", async () => {
  const sleep = fakeSleep();
  const helper = new RetryHelper({ maxRetries: 3, sleepImpl: sleep.fn });

  let calls = 0;
  const [success, value] = await helper.executeAsync(async () => {
    calls += 1;
    if (calls < 3) throw new Error("network timeout");
    return "done";
  });

  assert.equal(success, true);
  assert.equal(value, "done");
  assert.equal(calls, 3);
  assert.deepEqual(sleep.calls, [2000, 4000]);
});

test("RetryHelper: 达到 maxRetries 后返回 [false, 错误消息字符串]（不是错误对象）", async () => {
  const sleep = fakeSleep();
  const helper = new RetryHelper({ maxRetries: 2, sleepImpl: sleep.fn });
  const outcome = await helper.executeAsync(async () => {
    throw new Error("socket closed");
  });
  assert.equal(outcome[0], false);
  assert.equal(typeof outcome[1], "string");
  assert.equal(outcome[1], "socket closed");
  assert.equal(sleep.calls.length, 2);
});

test("RetryHelper: 不可重试错误立即返回，不再重试也不 sleep", async () => {
  const sleep = fakeSleep();
  const helper = new RetryHelper({ maxRetries: 5, sleepImpl: sleep.fn });

  let calls = 0;
  const [success, err] = await helper.executeAsync(async () => {
    calls += 1;
    throw new Error("业务校验失败"); // 无 code / 无关键词 → 不可重试
  });

  assert.equal(success, false);
  assert.equal(err, "业务校验失败");
  assert.equal(calls, 1);
  assert.deepEqual(sleep.calls, []);
});

test("RetryHelper: 注入的 isRetryable 完全覆盖默认判定", async () => {
  const sleep = fakeSleep();
  const helper = new RetryHelper({
    maxRetries: 2,
    sleepImpl: sleep.fn,
    isRetryable: () => true, // 连业务错误也重试
  });

  let calls = 0;
  await helper.executeAsync(async () => {
    calls += 1;
    throw new Error("业务校验失败");
  });

  assert.equal(calls, 3);
  assert.equal(helper.isRetryable(new Error("随便什么")), true);
});

test("RetryHelper: logCallback 收到重试提示文案", async () => {
  const logs = [];
  const sleep = fakeSleep();
  const helper = new RetryHelper({
    maxRetries: 1,
    sleepImpl: sleep.fn,
    logCallback: (m) => logs.push(m),
  });

  await helper.executeAsync(async () => {
    throw new Error("connection refused");
  });

  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[重试\] 第1次失败: connection refused\.\.\. 将在2\.0秒后重试 \(1\/1\)$/);
});

test("defaultIsRetryable: code / name / 关键词三段判定与不命中", () => {
  const withCode = Object.assign(new Error("x"), { code: "ECONNRESET" });
  assert.equal(defaultIsRetryable(withCode), true);

  const named = new Error("x");
  named.name = "TimeoutError";
  assert.equal(defaultIsRetryable(named), true);

  assert.equal(defaultIsRetryable(new Error("Network unreachable")), true);
  assert.equal(defaultIsRetryable(new Error("SOCKET hang up")), true);
  assert.equal(defaultIsRetryable(new Error("参数错误")), false);
  assert.equal(defaultIsRetryable("connection lost"), true);
  assert.equal(defaultIsRetryable(null), false);
});

test("errorMessage: Error / 字符串 / null 的取值", () => {
  assert.equal(errorMessage(new Error("msg")), "msg");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");
});

test("withRetry: 包装后成功返回结果值", async () => {
  const sleep = fakeSleep();
  const wrapped = withRetry(async (n) => n * 2, { sleepImpl: sleep.fn });
  assert.equal(await wrapped(21), 42);
  assert.deepEqual(sleep.calls, []);
});

test("withRetry: 重试用尽后抛出 Error(错误消息)", async () => {
  const sleep = fakeSleep();
  let calls = 0;
  const wrapped = withRetry(
    async () => {
      calls += 1;
      throw new Error("connection dropped");
    },
    { maxRetries: 2, baseDelay: 1, sleepImpl: sleep.fn },
  );

  await assert.rejects(() => wrapped(), /connection dropped/);
  assert.equal(calls, 3);
  assert.deepEqual(sleep.calls, [1000, 2000]);
});

test("withRetryAsync 是 withRetry 的同义导出", () => {
  assert.equal(withRetryAsync, withRetry);
});

// ==================== FailedTaskQueue ====================

test("createFailedTask: 默认 context={} / retry_count=0 并自动填时间戳", () => {
  const t = createFailedTask({ id: "a@x.com", type: "login" });
  assert.equal(t.id, "a@x.com");
  assert.equal(t.type, "login");
  assert.deepEqual(t.context, {});
  assert.equal(t.retry_count, 0);
  assert.match(t.failed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("FailedTaskQueue: add 新任务保留 context，retry_count 从 0 开始", () => {
  const q = new FailedTaskQueue({ filePath: path.join(os.tmpdir(), "never-written.json") });
  q.add("a@x.com", "login", { browser: "1" });

  const all = q.getAll();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].context, { browser: "1" });
  assert.equal(all[0].retry_count, 0);
});

test("FailedTaskQueue: add 去重时 retry_count 自增且新 context 被丢弃（照搬 Python）", () => {
  const q = new FailedTaskQueue({ filePath: path.join(os.tmpdir(), "never-written.json") });
  q.add("a@x.com", "login", { first: true });
  q.add("a@x.com", "login", { second: true });
  q.add("a@x.com", "login", { third: true });

  const all = q.getAll();
  assert.equal(all.length, 1, "同 id+type 不追加新记录");
  assert.equal(all[0].retry_count, 2);
  // Python 只更新 retry_count / failed_at，context 保持首次写入的值
  assert.deepEqual(all[0].context, { first: true });
});

test("FailedTaskQueue: id 相同但 type 不同视为两条任务", () => {
  const q = new FailedTaskQueue({ filePath: path.join(os.tmpdir(), "never-written.json") });
  q.add("a@x.com", "login");
  q.add("a@x.com", "oauth");
  assert.equal(q.count(), 2);
  assert.equal(q.count("login"), 1);
});

test("FailedTaskQueue: remove 支持按 type 精确移除与按 id 全类型移除", () => {
  const q = new FailedTaskQueue({ filePath: path.join(os.tmpdir(), "never-written.json") });
  q.add("a@x.com", "login");
  q.add("a@x.com", "oauth");
  q.add("b@x.com", "login");

  q.remove("a@x.com", "login");
  assert.deepEqual(q.getIds().sort(), ["a@x.com", "b@x.com"]);
  assert.deepEqual(q.getIds("login"), ["b@x.com"]);

  q.remove("a@x.com");
  assert.deepEqual(q.getIds(), ["b@x.com"]);
});

test("FailedTaskQueue: getAll/getIds/count 的 taskType 过滤", () => {
  const q = new FailedTaskQueue({ filePath: path.join(os.tmpdir(), "never-written.json") });
  q.add("a@x.com", "login");
  q.add("b@x.com", "login");
  q.add("c@x.com", "oauth");

  assert.equal(q.count(), 3);
  assert.equal(q.count("login"), 2);
  assert.equal(q.count("oauth"), 1);
  assert.equal(q.count("nope"), 0);
  assert.deepEqual(q.getIds("login"), ["a@x.com", "b@x.com"]);
  assert.deepEqual(
    q.getAll("oauth").map((t) => t.id),
    ["c@x.com"],
  );
  // getAll 返回浅拷贝数组，改动不回写内部状态
  q.getAll().pop();
  assert.equal(q.count(), 3);
});

test("FailedTaskQueue: clear 按类型清理与全量清理", () => {
  const q = new FailedTaskQueue({ filePath: path.join(os.tmpdir(), "never-written.json") });
  q.add("a@x.com", "login");
  q.add("c@x.com", "oauth");

  q.clear("login");
  assert.equal(q.count(), 1);
  assert.deepEqual(q.getIds(), ["c@x.com"]);

  q.clear();
  assert.equal(q.count(), 0);
});

test("FailedTaskQueue: save/load 往返（临时目录，不碰仓库根）", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "failed_tasks.json");
    const q1 = new FailedTaskQueue({ filePath: file });
    q1.add("a@x.com", "login", { browser: "7" });
    q1.add("b@x.com", "oauth");
    q1.add("a@x.com", "login"); // retry_count → 1
    q1.save();

    assert.ok(fs.existsSync(file));
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(raw.length, 2);
    assert.equal(raw[0].retry_count, 1);
    assert.deepEqual(raw[0].context, { browser: "7" });

    const q2 = new FailedTaskQueue({ filePath: file });
    q2.load();
    assert.equal(q2.count(), 2);
    assert.deepEqual(q2.getIds().sort(), ["a@x.com", "b@x.com"]);
    assert.equal(q2.getAll("login")[0].retry_count, 1);
  });
});

test("FailedTaskQueue: load 时文件不存在则保持现有内存状态不变（照搬 Python）", () => {
  withTempDir((dir) => {
    const q = new FailedTaskQueue({ filePath: path.join(dir, "missing.json") });
    q.add("a@x.com", "login");
    q.load();
    assert.equal(q.count(), 1, "文件不存在时不清空");
  });
});

test("FailedTaskQueue: load 遇到非数组 JSON 则清空并记日志", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "failed_tasks.json");
    fs.writeFileSync(file, '{"not":"an array"}', "utf-8");

    const logs = [];
    const q = new FailedTaskQueue({ filePath: file, logCallback: (m) => logs.push(m) });
    q.add("a@x.com", "login");
    q.load();

    assert.equal(q.count(), 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[FailedTaskQueue\] 加载失败/);
  });
});

test("FailedTaskQueue: save 失败时只记日志不抛错", () => {
  withTempDir((dir) => {
    const logs = [];
    // 指向一个目录路径 → writeFileSync 必定失败
    const q = new FailedTaskQueue({ filePath: dir, logCallback: (m) => logs.push(m) });
    q.add("a@x.com", "login");
    assert.doesNotThrow(() => q.save());
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[FailedTaskQueue\] 保存失败/);
  });
});

test("FailedTaskQueue: 注入 now() 决定 failed_at 时间戳格式", () => {
  const q = new FailedTaskQueue({
    filePath: path.join(os.tmpdir(), "never-written.json"),
    now: () => new Date(2026, 0, 2, 3, 4, 5),
  });
  q.add("a@x.com", "login");
  assert.equal(q.getAll()[0].failed_at, "2026-01-02 03:04:05");
});
