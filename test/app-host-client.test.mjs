/**
 * HostClient（主进程 ⇄ 后端进程客户端）测试
 * 用假进程句柄与手动推进的假定时器，全程离线、不等真实时间。
 *
 * 假进程的 exit 默认**异步**到达（queueMicrotask），与真实 utilityProcess 一致。
 * 早期版本的测试用同步 exit，恰好走在最有利的路径上，没测出「并发 stop / restart
 * 产生孤儿进程」的缺陷。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { HostClient } from "../app/main/host/host-client.ts";
import { ERROR_CODES, okEnvelope } from "../app/shared/envelope.ts";

/** 手动推进的假定时器 */
function fakeTimers() {
  let seq = 0;
  const active = new Map();
  return {
    active,
    set(fn, ms) {
      const id = ++seq;
      active.set(id, { fn, ms });
      return id;
    },
    clear(id) {
      active.delete(id);
    },
    /** 触发所有 ms 等于给定值的定时器 */
    fire(ms) {
      for (const [id, t] of [...active]) {
        if (t.ms === ms) {
          active.delete(id);
          t.fn();
        }
      }
    },
  };
}

/**
 * 假后端进程。exitMode：
 *   "async"  kill 后在微任务里触发 exit（默认，贴近真实 utilityProcess）
 *   "sync"   kill 时同步触发 exit
 *   "never"  kill 后不退出（模拟卡死进程）
 */
function fakeProcess(pid, exitMode = "async") {
  const sent = [];
  const messageListeners = [];
  const exitListeners = [];
  const proc = {
    pid,
    sent,
    killed: 0,
    exitMode,
    alive: true,
    postMessage(m) {
      sent.push(m);
    },
    onMessage(l) {
      messageListeners.push(l);
    },
    onExit(l) {
      exitListeners.push(l);
    },
    kill() {
      proc.killed += 1;
      if (proc.exitMode === "sync") proc.emitExit(0);
      else if (proc.exitMode === "async") queueMicrotask(() => proc.emitExit(0));
      return true;
    },
    emit(m) {
      for (const l of messageListeners) l(m);
    },
    emitExit(code) {
      if (!proc.alive) return;
      proc.alive = false;
      for (const l of exitListeners) l(code);
    },
  };
  return proc;
}

function setup(opts = {}) {
  const timers = fakeTimers();
  const procs = [];
  let pid = 100;
  const { exitMode, ...clientOpts } = opts;
  const client = new HostClient({
    spawn: () => {
      const p = fakeProcess(++pid, exitMode ?? "async");
      procs.push(p);
      return p;
    },
    timers,
    now: () => 0,
    requestTimeoutMs: 30_000,
    stopTimeoutMs: 5_000,
    ...clientOpts,
  });
  const states = [];
  client.onStatus((s) => states.push(s.state));
  return { client, timers, procs, states };
}

/** 启动并让最新的假进程回 ready */
async function startReady(ctx) {
  await ctx.client.start();
  const p = ctx.procs.at(-1);
  p.emit({ type: "ready", pid: p.pid });
  return p;
}

/** 让出若干轮微任务 / 宏任务，推进 Promise 链 */
const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** 活着且仍被 client 认作当前进程的数量 */
const aliveCount = (ctx) => ctx.procs.filter((p) => p.alive).length;

// ==================== 生命周期 ====================

test("初始状态为 stopped，seq 为 0", () => {
  const { client } = setup();
  const s = client.getStatus();
  assert.equal(s.state, "stopped");
  assert.equal(s.pid, null);
  assert.equal(s.seq, 0);
});

test("start → starting，收到 ready → ready，状态事件按顺序发出", async () => {
  const ctx = setup();
  await ctx.client.start();
  assert.equal(ctx.client.getStatus().state, "starting");
  ctx.procs[0].emit({ type: "ready", pid: 101 });
  assert.deepEqual(ctx.states, ["starting", "ready"]);
  assert.equal(ctx.client.getStatus().pid, 101);
});

test("每次状态变化 seq 单调递增（不依赖墙钟）", async () => {
  const seqs = [];
  const ctx = setup({ now: () => 999 }); // 时钟恒定也不影响 seq
  ctx.client.onStatus((s) => seqs.push(s.seq));
  await startReady(ctx);
  await ctx.client.stop();
  assert.deepEqual(seqs, [1, 2, 3]);
});

test("已在运行时重复 start 不会再拉起新进程", async () => {
  const ctx = setup();
  await startReady(ctx);
  await ctx.client.start();
  assert.equal(ctx.procs.length, 1);
});

test("spawn 抛错 → crashed，并带上原因", async () => {
  const client = new HostClient({
    spawn: () => {
      throw new Error("找不到 host.js");
    },
    timers: fakeTimers(),
  });
  await client.start();
  const s = client.getStatus();
  assert.equal(s.state, "crashed");
  assert.match(s.detail ?? "", /找不到 host\.js/);
});

test("进程意外退出 → crashed，detail 含退出码", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  p.emitExit(3);
  assert.equal(ctx.client.getStatus().state, "crashed");
  assert.equal(ctx.client.getStatus().detail, "退出码 3");
});

test("stop 主动结束 → stopped（不是 crashed），异步 exit 也能等到", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  await ctx.client.stop();
  assert.equal(p.killed, 1);
  assert.equal(p.alive, false);
  assert.equal(ctx.client.getStatus().state, "stopped");
  assert.deepEqual(ctx.states, ["starting", "ready", "stopped"]);
  assert.equal(ctx.timers.active.size, 0, "超时定时器应被清除");
});

test("stop 在进程不退出时超时：强制视为 stopped，并调用 forceKill 补刀", async () => {
  const killed = [];
  const ctx = setup({ exitMode: "never", forceKill: (pid) => killed.push(pid) });
  const p = await startReady(ctx);
  const stopping = ctx.client.stop();
  await flush();
  ctx.timers.fire(5_000);
  await stopping;
  assert.equal(ctx.client.getStatus().state, "stopped");
  assert.deepEqual(killed, [p.pid]);

  // 旧进程迟到的 exit / ready 不应影响状态
  p.exitMode = "sync";
  p.emitExit(1);
  p.emit({ type: "ready", pid: p.pid });
  assert.equal(ctx.client.getStatus().state, "stopped");
});

test("stop 超时时，待回复请求同样以 HOST_UNAVAILABLE 失败", async () => {
  const ctx = setup({ exitMode: "never" });
  await startReady(ctx);
  const req = ctx.client.request("abb/a", []);
  const stopping = ctx.client.stop();
  await flush();
  ctx.timers.fire(5_000);
  await stopping;
  const env = await req;
  assert.equal(!env.ok && env.error.code, ERROR_CODES.HOST_UNAVAILABLE);
});

test("forceKill 抛错只记日志，不影响状态收敛", async () => {
  const logs = [];
  const ctx = setup({
    exitMode: "never",
    forceKill: () => {
      throw new Error("ESRCH");
    },
    log: (m) => logs.push(m),
  });
  await startReady(ctx);
  const stopping = ctx.client.stop();
  await flush();
  ctx.timers.fire(5_000);
  await stopping;
  assert.equal(ctx.client.getStatus().state, "stopped");
  assert.ok(logs.some((l) => l.includes("ESRCH")));
});

test("restart：状态依次 stopped → starting →（ready 后）ready，并拉起新进程", async () => {
  const ctx = setup();
  await startReady(ctx);
  ctx.states.length = 0;

  const s = await ctx.client.restart();
  assert.equal(s.state, "starting");
  assert.equal(ctx.procs.length, 2);
  ctx.procs[1].emit({ type: "ready", pid: ctx.procs[1].pid });

  assert.deepEqual(ctx.states, ["stopped", "starting", "ready"]);
  assert.equal(ctx.client.getStatus().pid, ctx.procs[1].pid);
});

test("重启后旧进程迟到的退出事件不会把新进程标成 crashed", async () => {
  const ctx = setup({ exitMode: "never" });
  const old = await startReady(ctx);
  const restarting = ctx.client.restart();
  await flush();
  ctx.timers.fire(5_000); // 旧进程卡死，靠超时作废
  await restarting;
  ctx.procs[1].emit({ type: "ready", pid: ctx.procs[1].pid });

  old.exitMode = "sync";
  old.emitExit(137);
  assert.equal(ctx.client.getStatus().state, "ready");
});

test("没有进程时 stop 直接置 stopped", async () => {
  const ctx = setup();
  await ctx.client.stop();
  assert.equal(ctx.client.getStatus().state, "stopped");
});

// ==================== 并发（代码审查发现的缺陷） ====================

test("并发两次 stop：两者都 resolve，只 kill 一次，不会走到超时", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  await Promise.all([ctx.client.stop(), ctx.client.stop()]);
  assert.equal(p.killed, 1);
  assert.equal(ctx.client.getStatus().state, "stopped");
  assert.equal(ctx.timers.active.size, 0);
});

test("并发两次 restart：最终只有 1 个活着的进程，且它就是当前进程", async () => {
  const ctx = setup();
  await startReady(ctx);

  const a = ctx.client.restart();
  const b = ctx.client.restart();
  await flush();
  // 每拉起一个新进程就让它 ready，模拟真实启动
  for (const p of ctx.procs) if (p.alive) p.emit({ type: "ready", pid: p.pid });
  await Promise.all([a, b]);
  for (const p of ctx.procs) if (p.alive) p.emit({ type: "ready", pid: p.pid });

  assert.equal(aliveCount(ctx), 1, "不应留下孤儿进程");
  const current = ctx.procs.find((p) => p.alive);
  assert.equal(ctx.client.getStatus().pid, current.pid);
  assert.equal(ctx.client.getStatus().state, "ready");
  assert.equal(ctx.timers.active.size, 0, "不应有悬挂的 stop 超时定时器");
});

test("连点三次重启：没有孤儿，也没有任何 stop 走到 5 秒超时", async () => {
  const logs = [];
  const ctx = setup({ log: (m) => logs.push(m) });
  await startReady(ctx);
  await Promise.all([ctx.client.restart(), ctx.client.restart(), ctx.client.restart()]);
  assert.equal(aliveCount(ctx), 1);
  assert.equal(logs.filter((l) => l.includes("未在")).length, 0);
});

test("shutdown 后 restart 不再拉起新进程（退出过程中点重启不产生孤儿）", async () => {
  const ctx = setup();
  await startReady(ctx);
  const quitting = ctx.client.shutdown();
  const restarting = ctx.client.restart();
  await Promise.all([quitting, restarting]);
  assert.equal(aliveCount(ctx), 0);
  assert.equal(ctx.procs.length, 1, "shutdown 之后不应再 spawn");
  assert.equal(ctx.client.getStatus().state, "stopped");
});

test("shutdown 后 start 被拒绝", async () => {
  const ctx = setup();
  await ctx.client.shutdown();
  await ctx.client.start();
  assert.equal(ctx.procs.length, 0);
});

test("停止过程中迟到的 ready 不会把状态改回 ready，也不放行请求", async () => {
  const ctx = setup({ exitMode: "never" });
  await ctx.client.start(); // 仅 starting
  const p = ctx.procs[0];
  const stopping = ctx.client.stop();
  await flush();
  p.emit({ type: "ready", pid: p.pid }); // kill 生效前 ready 先到
  assert.notEqual(ctx.client.getStatus().state, "ready");
  const env = await ctx.client.request("abb/a", []);
  assert.equal(!env.ok && env.error.code, ERROR_CODES.HOST_UNAVAILABLE);
  assert.equal(p.sent.length, 0);
  ctx.timers.fire(5_000);
  await stopping;
});

test("生命周期操作失败不会卡死后续操作", async () => {
  let n = 0;
  const client = new HostClient({
    spawn: () => {
      n += 1;
      if (n === 1) throw new Error("第一次拉起失败");
      return fakeProcess(200 + n);
    },
    timers: fakeTimers(),
  });
  await client.start();
  assert.equal(client.getStatus().state, "crashed");
  await client.start();
  assert.equal(client.getStatus().state, "starting");
});

// ==================== 请求 ====================

test("未就绪时请求立即返回 HOST_UNAVAILABLE，不发消息", async () => {
  const ctx = setup();
  await ctx.client.start(); // 仅 starting
  const env = await ctx.client.request("abb/host/ping", []);
  assert.equal(!env.ok && env.error.code, ERROR_CODES.HOST_UNAVAILABLE);
  assert.equal(ctx.procs[0].sent.length, 0);
});

test("请求消息格式正确，响应按 id 回到对应调用方", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  const pending = ctx.client.request("abb/host/ping", [1, "x"]);
  assert.deepEqual(p.sent[0], { type: "request", id: 1, channel: "abb/host/ping", args: [1, "x"] });
  p.emit({ type: "response", id: 1, envelope: okEnvelope("pong") });
  assert.deepEqual(await pending, okEnvelope("pong"));
  assert.equal(ctx.client.pendingCount, 0);
});

test("并发请求乱序响应仍按 id 正确配对", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  const a = ctx.client.request("abb/a", []);
  const b = ctx.client.request("abb/b", []);
  const c = ctx.client.request("abb/c", []);
  const ids = p.sent.map((m) => m.id);
  assert.equal(new Set(ids).size, 3);

  p.emit({ type: "response", id: ids[2], envelope: okEnvelope("C") });
  p.emit({ type: "response", id: ids[0], envelope: okEnvelope("A") });
  p.emit({ type: "response", id: ids[1], envelope: okEnvelope("B") });

  assert.deepEqual(await Promise.all([a, b, c]), [okEnvelope("A"), okEnvelope("B"), okEnvelope("C")]);
});

test("请求超时返回 TIMEOUT，迟到的响应被丢弃", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  const pending = ctx.client.request("abb/slow", []);
  ctx.timers.fire(30_000);
  const env = await pending;
  assert.equal(!env.ok && env.error.code, ERROR_CODES.TIMEOUT);
  assert.equal(ctx.client.pendingCount, 0);

  p.emit({ type: "response", id: p.sent[0].id, envelope: okEnvelope("late") });
  assert.equal(ctx.client.getStatus().state, "ready");
});

test("响应到达后超时定时器被清除", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  const pending = ctx.client.request("abb/x", []);
  assert.equal(ctx.timers.active.size, 1);
  p.emit({ type: "response", id: 1, envelope: okEnvelope(1) });
  await pending;
  assert.equal(ctx.timers.active.size, 0);
});

test("进程崩溃时所有待回复请求立即以 HOST_UNAVAILABLE 失败", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  const reqs = [ctx.client.request("abb/a", []), ctx.client.request("abb/b", [])];
  p.emitExit(1);
  const results = await Promise.all(reqs);
  for (const env of results) assert.equal(!env.ok && env.error.code, ERROR_CODES.HOST_UNAVAILABLE);
  assert.equal(ctx.client.pendingCount, 0);
  assert.equal(ctx.timers.active.size, 0);
});

test("stop 时待回复请求同样失败", async () => {
  const ctx = setup();
  await startReady(ctx);
  const req = ctx.client.request("abb/a", []);
  await ctx.client.stop();
  const env = await req;
  assert.equal(!env.ok && env.error.code, ERROR_CODES.HOST_UNAVAILABLE);
});

test("postMessage 抛错时请求返回 HOST_UNAVAILABLE", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  p.postMessage = () => {
    throw new Error("channel closed");
  };
  const env = await ctx.client.request("abb/a", []);
  assert.equal(!env.ok && env.error.code, ERROR_CODES.HOST_UNAVAILABLE);
  assert.match((!env.ok && env.error.message) || "", /channel closed/);
  assert.equal(ctx.client.pendingCount, 0);
});

test("后端返回非法信封时折算成 INTERNAL", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  const pending = ctx.client.request("abb/a", []);
  p.emit({ type: "response", id: 1, envelope: { weird: true } });
  const env = await pending;
  assert.equal(!env.ok && env.error.code, ERROR_CODES.INTERNAL);
});

// ==================== 其它消息 ====================

test("无法识别的消息被忽略并记日志，不影响状态", async () => {
  const logs = [];
  const ctx = setup({ log: (m) => logs.push(m) });
  await startReady(ctx);
  ctx.procs[0].emit({ type: "garbage" });
  ctx.procs[0].emit("not an object");
  assert.equal(ctx.client.getStatus().state, "ready");
  assert.equal(logs.length, 2);
});

test("后端推送的事件转给订阅者，取消订阅后不再收到", async () => {
  const ctx = setup();
  const p = await startReady(ctx);
  const got = [];
  const off = ctx.client.onEvent((channel, payload) => got.push([channel, payload]));
  p.emit({ type: "event", channel: "abb/task/event/progress", payload: { done: 1 } });
  off();
  p.emit({ type: "event", channel: "abb/task/event/progress", payload: { done: 2 } });
  assert.deepEqual(got, [["abb/task/event/progress", { done: 1 }]]);
});

test("状态订阅者抛错不影响其它订阅者与状态机", async () => {
  const ctx = setup();
  ctx.client.onStatus(() => {
    throw new Error("订阅者坏了");
  });
  await startReady(ctx);
  assert.equal(ctx.client.getStatus().state, "ready");
  assert.deepEqual(ctx.states, ["starting", "ready"]);
});

test("getStatus 返回副本，外部修改不影响内部状态", async () => {
  const ctx = setup();
  await startReady(ctx);
  const s = ctx.client.getStatus();
  s.state = "crashed";
  assert.equal(ctx.client.getStatus().state, "ready");
});
