/**
 * 停止任务时，窗口已经关掉的登录要立刻掐断（真机 2026-09-26 需求）
 *
 * 背景：CDP 连接一断（窗口被关 / 崩掉），引擎里 page.evaluate 这类 await 永远不会 settle，
 * 只能等封顶超时；而「停止不打断进行中的账号」是既有语义 —— 于是点了停止之后，
 * 界面一直停在进行中的那个账号上（真机现象：批量登录卡在 19/20，点停止也没反应）。
 * 窗口确实没了的时候那个账号不可能再有进展，立即掐断才对。
 *
 * 覆盖三件事：
 *   1. 判活探针：窗口在 / 不在 / 不知道（没有调试地址）
 *   2. 登记表：窗口关了的被掐断、窗口还活着的不动
 *   3. 装配：编排层的停止钩子确实会触发这次探活
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  abortLoginsWithClosedWindow,
  liveEngineIds,
  registerLiveEngine,
} from "../src/automation/live-engines.ts";
import { StagehandGoogleEngine } from "../src/engine/stagehand-engine.ts";
import { BatchAccountProcessor } from "../src/automation/batch-account-processor.ts";
import { executeAccountWorkerTask } from "../src/application/account-task-orchestrator.ts";

// 批处理器直接往 stdout 打 [BatchProcessor] 日志，测试里过滤掉
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === "string" && chunk.startsWith("[BatchProcessor] ")) return true;
  return realWrite(chunk, ...rest);
};

const acct = (email) => ({ email, password: "pw", secret_key: "", recovery_email: "" });
const ok = () => ({ success: true, message: "成功" });

async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

/** 假引擎：只记录有没有被掐断 */
function fakeEngine(alive) {
  const calls = { probed: 0, stopped: 0 };
  return {
    calls,
    async isWindowAlive() {
      calls.probed += 1;
      return alive;
    },
    async stop() {
      calls.stopped += 1;
    },
  };
}

// ==================== 1. 判活探针 ====================

/** 造一个只有调试地址的引擎（私有字段用例直接塞，与 engine-visibility.test.mjs 同一手法） */
function engineAt(address) {
  const engine = /** @type {any} */ (new StagehandGoogleEngine(/** @type {any} */ ({ ixClient: {} })));
  engine.debuggingAddress = address;
  return engine;
}

test("isWindowAlive: DevTools 端点还答话 → 窗口还活着", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  try {
    assert.equal(await engineAt(`127.0.0.1:${port}`).isWindowAlive(2000), true);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test("isWindowAlive: 端点连不上（窗口已关）→ false", async () => {
  // 关掉的 HTTP 服务器留下的端口：连不上（这是「窗口没了」的真实形态）
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  await new Promise((r) => server.close(() => r(undefined)));

  assert.equal(await engineAt(`127.0.0.1:${port}`).isWindowAlive(2000), false);
});

test("isWindowAlive: 端点无响应时按超时判死，不会一直等", async () => {
  // 只接受连接、从不回响应：模拟半死状态
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  try {
    const started = Date.now();
    assert.equal(await engineAt(`127.0.0.1:${port}`).isWindowAlive(150), false);
    assert.ok(Date.now() - started < 2000, "应当按探针超时结束，而不是一直挂着");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test("isWindowAlive: 没有调试地址（没连过窗口）→ 当作还活着，绝不误掐", async () => {
  assert.equal(await engineAt(null).isWindowAlive(50), true);
});

// ==================== 2. 登记表与掐断 ====================

test("登记表：注销后不再在册", () => {
  const before = liveEngineIds();
  const unregister = registerLiveEngine("t-reg", fakeEngine(true));
  assert.ok(liveEngineIds().includes("t-reg"));
  unregister();
  assert.ok(!liveEngineIds().includes("t-reg"));
  assert.deepEqual(liveEngineIds(), before);
});

test("窗口已关闭的登录被立刻掐断，窗口还活着的不动", async () => {
  const dead = fakeEngine(false);
  const alive = fakeEngine(true);
  const offDead = registerLiveEngine("t-dead", dead);
  const offAlive = registerLiveEngine("t-alive", alive);
  const logs = [];
  try {
    const aborted = await abortLoginsWithClosedWindow((m) => logs.push(m));

    assert.deepEqual(aborted, ["t-dead"], "只掐断窗口已关闭的那个");
    assert.equal(dead.calls.stopped, 1, "已关闭的窗口要断开连接，好让进行中的调用立刻失败");
    assert.equal(alive.calls.stopped, 0, "窗口还活着的保持既有语义：不打断进行中的账号");
    assert.equal(alive.calls.probed, 1, "活着的也要探一次才能判定");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /窗口 t-dead 已关闭/);
  } finally {
    offDead();
    offAlive();
  }
});

test("没有在跑的登录时，探活不产生任何副作用", async () => {
  const logs = [];
  const aborted = await abortLoginsWithClosedWindow((m) => logs.push(m));
  assert.deepEqual(aborted, []);
  assert.deepEqual(logs, []);
});

// ==================== 3. 装配：停止钩子确实会触发探活 ====================

test("装配：编排层停止钩子会掐断窗口已关闭的登录", async () => {
  const dead = fakeEngine(false);
  const offDead = registerLiveEngine("t-wired", dead);
  let stopRequested = false;
  /** @type {(() => void) | null} */
  let stopHook = null;
  const logs = [];
  try {
    const run = executeAccountWorkerTask({
      taskType: "login",
      accounts: [acct("a@x.com"), acct("b@x.com")],
      browserIds: ["1", "2"],
      concurrency: 1,
      llm: /** @type {any} */ ({}),
      shouldStop: () => stopRequested,
      onStop: (fn) => {
        stopHook = fn;
      },
      log: (m) => logs.push(m),
      createProcessor: (o) =>
        new BatchAccountProcessor(
          { concurrency: o.concurrency, callback: o.callback, onAccountDone: o.onAccountDone ?? null },
          {
            config: {
              getLoginConcurrency: () => 3,
              getLoginMaxRetries: () => 1,
              getLoginRetryDelay: () => 0,
            },
            sleepImpl: async () => {},
            accountRepo: { updateLoginStatus: () => true },
            loginFn: async () => ok(),
          },
        ),
    });
    await tick();
    stopRequested = true;
    /** @type {() => void} */ (/** @type {unknown} */ (stopHook))();
    // 停止钩子里的探活是异步的（不阻塞停止本身）：让出几轮事件循环
    await tick(10);
    await run;

    assert.equal(dead.calls.probed, 1, "停止钩子要探一次窗口");
    assert.equal(dead.calls.stopped, 1, "窗口已关闭 → 立刻断开，账号随即收尾");
  } finally {
    offDead();
  }
});

// ==================== 4. 掐断要让在飞的调用「立刻」失败 ====================

test("引擎被掐断时，在飞的调用立刻失败——不等封顶超时", async () => {
  const engine = /** @type {any} */ (new StagehandGoogleEngine(/** @type {any} */ ({ ixClient: {} })));
  engine.sh = {};
  engine.page = { url: () => "", evaluate: () => new Promise(() => {}) }; // CDP 断开后的形态：永不 settle
  engine.callTimeoutOverrideMs = 5000; // 封顶故意留长：只有掐断信号能让它立刻结束
  engine.armAbort();

  const started = Date.now();
  const inflight = engine.evaluateScript("1");
  await new Promise((r) => setTimeout(r, 20)); // 让调用真的进到 await
  await engine.close(false); // 停止时掐断（live-engines 走的就是这条）
  const result = await inflight;

  assert.equal(result, null, "掐断后 evaluateScript 按既有口径返回 null");
  assert.ok(Date.now() - started < 2000, "应当立刻失败，而不是等 5s 封顶");
});

test("只是装上掐断信号（窗口还活着）不会影响正常调用", async () => {
  const engine = /** @type {any} */ (new StagehandGoogleEngine(/** @type {any} */ ({ ixClient: {} })));
  engine.sh = {};
  engine.page = { url: () => "", evaluate: async () => "ok" };
  engine.callTimeoutOverrideMs = 5000;
  engine.armAbort();

  assert.equal(await engine.evaluateScript("1"), "ok");
});
