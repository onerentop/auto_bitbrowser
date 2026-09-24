/**
 * core/semaphore.ts + core/retry-helper.ts 单测（全离线）
 *
 * 覆盖：
 *   - Semaphore：计数 / FIFO / run() 异常释放 / 并发上限 / gatherSettled
 *   - RetryHelper：退避序列、返回形状、不可重试提前返回、withRetry 高阶函数
 *
 * 所有 sleep 一律注入假实现（只记录参数，不真等）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";


import { Semaphore, gatherSettled } from "../src/core/semaphore.ts";
import {
  DEFAULT_BACKOFF_FACTOR,
  DEFAULT_BASE_DELAY,
  DEFAULT_MAX_DELAY,
  DEFAULT_MAX_RETRIES,
  RetryHelper,
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
