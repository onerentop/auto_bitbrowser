/**
 * automation/batch-account-processor.ts 单测（全离线）
 *
 * 所有外部依赖都注入替身：
 *   - loginFn      → 假登录流程（不开浏览器、不调 AI）
 *   - accountRepo  → 内存假仓储（不碰 accounts.db）
 *   - config       → 假配置（不读仓库根 config.json）
 *   - sleepImpl    → 只记录毫秒数的假 sleep
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// 批量处理器用 process.stdout.write 打 `[BatchProcessor] ...` 日志。
// 这里只过滤掉它自己的日志行，其它输出（含 node:test 的 TAP）一律放行。
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === "string" && chunk.startsWith("[BatchProcessor] ")) return true;
  return realWrite(chunk, ...rest);
};

import {
  BatchAccountProcessor,
  quickBatchLogin,
} from "../src/automation/batch-account-processor.ts";

// ==================== 替身 ====================

/** 假 ConfigManager（只实现 ConfigManagerLike 的 3 个方法） */
function fakeConfig(overrides = {}) {
  return {
    getLoginConcurrency: () => overrides.concurrency ?? 3,
    getLoginMaxRetries: () => overrides.maxRetries ?? 2,
    getLoginRetryDelay: () => overrides.retryDelay ?? 3,
  };
}

/** 内存假账号仓储（批处理器只把它透传给登录适配器写 login_status） */
function fakeAccountRepo() {
  const calls = [];
  return {
    calls,
    updateLoginStatus(email, status, error) {
      calls.push([email, status, error]);
      return true;
    },
  };
}

/** 假 sleep（毫秒） */
function fakeSleep() {
  const calls = [];
  return { calls, fn: async (ms) => void calls.push(ms) };
}

/** 默认 deps：一切都是替身，绝不触碰真实实现 */
function makeDeps(extra = {}) {
  return {
    config: fakeConfig(),
    sleepImpl: async () => {},
    ...extra,
  };
}


const acct = (email) => ({ email, password: "pw", secret_key: "", recovery_email: "" });
const ok = (extra = {}) => ({ success: true, message: "成功", ...extra });
const fail = (message, errorType = null) => ({ success: false, message, errorType });

/** 让出事件循环若干轮 */
async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

// ==================== 构造与入参校验 ====================

test("构造: concurrency 未传（或为 0）时回落到配置值", () => {
  const p1 = new BatchAccountProcessor({}, makeDeps({ config: fakeConfig({ concurrency: 7 }) }));
  assert.equal(p1.concurrency, 7);

  const p2 = new BatchAccountProcessor({ concurrency: 0 }, makeDeps({ config: fakeConfig({ concurrency: 7 }) }));
  assert.equal(p2.concurrency, 7, "Python 用 `or`，0 也回落配置");

  const p3 = new BatchAccountProcessor({ concurrency: 2 }, makeDeps());
  assert.equal(p3.concurrency, 2);
});

test("构造: retryTimes 传入 RetryHelper（默认 2，baseDelay 2.0）", () => {
  assert.equal(new BatchAccountProcessor({}, makeDeps()).retryHelper.maxRetries, 2);
  assert.equal(new BatchAccountProcessor({ retryTimes: 5 }, makeDeps()).retryHelper.maxRetries, 5);
  assert.equal(new BatchAccountProcessor({}, makeDeps()).retryHelper.baseDelay, 2.0);
});

test("batchLogin: 账号数与窗口数不匹配时抛错", async () => {
  const p = new BatchAccountProcessor({}, makeDeps());
  await assert.rejects(
    () => p.batchLogin([acct("a@x.com"), acct("b@x.com")], ["1"]),
    /账号数量与浏览器窗口数量不匹配/,
  );
});

// ==================== batchLogin ====================

test("batchLogin: 全部成功，结果记录 browser_id / attempts", async () => {
  const seen = [];
  const p = new BatchAccountProcessor(
    { concurrency: 2 },
    makeDeps({
      loginFn: async ({ browserId, account }) => {
        seen.push({ browserId, email: account.email });
        return ok({ totalSteps: 9 });
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com"), acct("b@x.com")], ["11", "22"]);

  assert.equal(result.total, 2);
  assert.equal(result.success_count, 2);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(result.results[0].data, { browser_id: "11", total_steps: 9, attempts: 1 });
  assert.deepEqual(seen, [
    { browserId: "11", email: "a@x.com" },
    { browserId: "22", email: "b@x.com" },
  ]);
  assert.ok(result.start_time !== null && result.end_time !== null);
});

test("batchLogin: 首次失败、第二次成功，期间按 retryDelay 秒睡眠", async () => {
  const sleep = fakeSleep();
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 3 }),
      sleepImpl: sleep.fn,
      loginFn: async () => {
        calls += 1;
        return calls === 1 ? fail("验证码错误", "captcha") : ok();
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);

  assert.equal(result.success_count, 1);
  assert.equal(calls, 2);
  assert.equal(result.results[0].data.attempts, 2);
  assert.deepEqual(sleep.calls, [3000], "retryDelay(3 秒) → sleepImpl(3000 毫秒)");
});

test("batchLogin: 尝试次数用尽后记为失败，保留最后一次的 message / errorType", async () => {
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 3, retryDelay: 1 }),
      loginFn: async () => {
        calls += 1;
        return fail("密码错误", "bad_password");
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);

  assert.equal(calls, 3);
  assert.equal(result.failed_count, 1);
  assert.deepEqual(result.results[0], {
    email: "a@x.com",
    status: "failed",
    error: "密码错误",
    error_type: "bad_password",
  });
});

test("batchLogin: 不可重试的错误类型立即 break，不再尝试（含有意新增的人机验证 / 密码错误 / 两步验证等）", async () => {
  for (const errorType of [
    "stagehand_unavailable",
    "no_api_key",
    "browser_open_failed",
    "captcha_required",
    "wrong_password",
    "need_2fa",
    "security_challenge",
    "account_not_found",
    "account_disabled",
  ]) {
    let calls = 0;
    const logs = [];
    const p = new BatchAccountProcessor(
      { concurrency: 1, callback: (m) => logs.push(m) },
      makeDeps({
        config: fakeConfig({ maxRetries: 5, retryDelay: 1 }),
        loginFn: async () => {
          calls += 1;
          return fail("致命错误", errorType);
        },
      }),
    );

    const result = await p.batchLogin([acct("a@x.com")], ["11"]);
    assert.equal(calls, 1, `${errorType} 应该只尝试一次`);
    assert.equal(result.results[0].error_type, errorType);
    // 失败日志报告实际尝试次数，而不是配置的最大次数
    assert.ok(logs.some((m) => m.includes("❌ 登录失败（已尝试 1 次）")), `${errorType} 日志应为实际次数`);
  }
});

test("batchLogin: options.maxRetries 覆盖配置里的次数", async () => {
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 1 }),
      loginFn: async () => {
        calls += 1;
        return fail("失败");
      },
    }),
  );
  await p.batchLogin([acct("a@x.com")], ["11"], { maxRetries: 4 });
  assert.equal(calls, 4);
});

test("batchLogin: loginFn 抛异常时记为 exception 失败", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 1 }),
      loginFn: async () => {
        throw new Error("引擎崩了");
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error, "引擎崩了");
  assert.equal(result.results[0].error_type, "exception");
});

test("batchLogin: stop() 之后未开始的账号全部记为跳过", async () => {
  let started = 0;
  const processorRef = {};
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      loginFn: async () => {
        started += 1;
        if (started === 1) processorRef.p.stop();
        return ok();
      },
    }),
  );
  processorRef.p = p;

  const accounts = ["a", "b", "c", "d"].map((n) => acct(`${n}@x.com`));
  const result = await p.batchLogin(accounts, ["1", "2", "3", "4"]);

  assert.equal(started, 1, "停止后不再执行新的登录");
  assert.equal(result.success_count, 1);
  assert.equal(result.skipped_count, 3);
  assert.ok(result.results.slice(1).every((r) => r.status === "skipped" && r.reason === "用户停止"));
});

test("batchLogin: 并发数受 concurrency 限制（峰值恰为 2）", async () => {
  let active = 0;
  let peak = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 2 },
    makeDeps({
      loginFn: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(3);
        active -= 1;
        return ok();
      },
    }),
  );

  const accounts = ["a", "b", "c", "d", "e"].map((n) => acct(`${n}@x.com`));
  const result = await p.batchLogin(accounts, ["1", "2", "3", "4", "5"]);

  assert.equal(peak, 2);
  assert.equal(result.success_count, 5);
});

test("batchLogin: concurrency=1 时严格串行（峰值 1）", async () => {
  let active = 0;
  let peak = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      loginFn: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(2);
        active -= 1;
        return ok();
      },
    }),
  );
  await p.batchLogin([acct("a@x.com"), acct("b@x.com"), acct("c@x.com")], ["1", "2", "3"]);
  assert.equal(peak, 1);
});

test("batchLogin: 进度回调同时收到 _log 的每条消息", async () => {
  const msgs = [];
  const p = new BatchAccountProcessor(
    { concurrency: 1, callback: (m) => msgs.push(m) },
    makeDeps({ loginFn: async () => ok() }),
  );
  await p.batchLogin([acct("a@x.com")], ["11"]);
  assert.ok(msgs.some((m) => m.includes("开始批量登录")));
  assert.ok(msgs.some((m) => m.includes("✅ 登录成功")));
  assert.ok(msgs.some((m) => m.includes("批量登录完成")));
});

// ==================== 便捷函数 ====================

test("quickBatchLogin: 默认并发 3，透传 maxRetries 与 deps", async () => {
  let calls = 0;
  const result = await quickBatchLogin(
    [acct("a@x.com"), acct("b@x.com")],
    ["1", "2"],
    { concurrency: 2, maxRetries: 1 },
    makeDeps({
      loginFn: async () => {
        calls += 1;
        return ok();
      },
    }),
  );
  assert.equal(result.success_count, 2);
  assert.equal(calls, 2);
});


// ==================== batchLogin: 失败结果 + 后续异常（Python 行为基线） ====================

test("batchLogin: 先失败再抛异常时报告的是较早那次的 message —— 与 Python L410-425 一致，是照搬而非 bug", async () => {
  // Python 里 login_result 只在「拿到返回值」时被赋值，异常分支只写 last_error；
  // 循环跑完后 `if login_result:` 为真 → 用的是第 1 次的 message / error_type，
  // 第 2 次的异常文本被丢弃（只进日志）。TS 侧逐行照搬了这个控制流。
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 1 }),
      loginFn: async () => {
        calls += 1;
        if (calls === 1) return fail("第一次：验证码错误", "captcha");
        throw new Error("第二次：引擎崩了");
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);

  assert.equal(calls, 2);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error, "第一次：验证码错误");
  assert.equal(result.results[0].error_type, "captcha");
  assert.ok(
    !String(result.results[0].error).includes("引擎崩了"),
    "后发生的异常文本不会出现在结果里",
  );
});


// ==================== deps.db 注入路径 / 未注入告警 ====================

/** 内存 accounts 表（最小列集），绝不碰仓库根的 accounts.db */
function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE accounts (
    email TEXT PRIMARY KEY,
    login_status TEXT,
    is_pro TEXT,
    updated_at TIMESTAMP
  )`);
  return db;
}

test("构造: 既无 db 也无仓储时输出 ⚠️ 未注入 accountRepo 告警", () => {
  const msgs = [];
  const deps = makeDeps();
  delete deps.accountRepo;
  new BatchAccountProcessor({ callback: (m) => msgs.push(m) }, deps);

  const warn = msgs.find((m) => m.startsWith("⚠️ 未注入"));
  assert.ok(warn, `应有告警，实际: ${JSON.stringify(msgs)}`);
  assert.match(warn, /未注入 accountRepo（/);
  assert.match(warn, /请注入 deps\.db 或对应仓储/);
});

test("构造: 显式注入 accountRepo 时不告警", () => {
  const msgs = [];
  new BatchAccountProcessor(
    { callback: (m) => msgs.push(m) },
    makeDeps({ accountRepo: fakeAccountRepo() }),
  );
  assert.equal(msgs.filter((m) => m.startsWith("⚠️ 未注入")).length, 0);
});

test("构造: 给了 db 之后不再告警", () => {
  const msgs = [];
  const deps = makeDeps({ db: memoryDb() });
  delete deps.accountRepo;
  new BatchAccountProcessor({ callback: (m) => msgs.push(m) }, deps);
  assert.equal(
    msgs.filter((m) => m.startsWith("⚠️ 未注入")).length,
    0,
  );
});
