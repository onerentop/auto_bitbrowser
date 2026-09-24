/**
 * Electron 骨架的纯逻辑测试：通道表、信封、后端分发、路由与注册器
 * 全部离线，不依赖 electron。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CodedError,
  ERROR_CODES,
  errEnvelope,
  isEnvelope,
  okEnvelope,
  toEnvelopeError,
  wrap,
} from "../app/shared/envelope.ts";
import {
  HOST_ROUTED_CHANNELS,
  LOCAL_CHANNELS,
  IPC,
  IPC_WHITELIST,
  isAllowedChannel,
  isHostOutboundMessage,
  isHostRequestMessage,
  isEventChannel,
  isInvokeChannel,
} from "../app/shared/ipc.ts";
import { createDispatcher, listChannels } from "../app/host/dispatch.ts";
import { createHealthHandlers } from "../app/host/handlers/health.ts";
import { createHostHandlers } from "../app/host/handlers/index.ts";
import { createHostContext } from "../app/host/context.ts";
import { ROUTE_LOCAL, createBackendRouter } from "../app/main/host/router.ts";
import { createIpcRegistrar, senderFrameUrl } from "../app/main/ipc/registrar.ts";
import { registerAppHandlers } from "../app/main/ipc/app-handlers.ts";
import { isAppUrl } from "../app/main/navigation.ts";

/** @type {string[]} */
const invokeNames = Object.values(IPC.invoke);
/** @type {string[]} */
const eventNames = Object.values(IPC.event);

// ==================== 通道表 ====================

test("通道表：invoke 与 event 名字各自唯一", () => {
  assert.equal(new Set(invokeNames).size, invokeNames.length);
  assert.equal(new Set(eventNames).size, eventNames.length);
});

test("通道表：全部以 abb/ 开头，事件通道带 /event/ 段", () => {
  for (const c of [...invokeNames, ...eventNames]) assert.match(c, /^abb\/[a-z]+\/[A-Za-z/]+$/);
  for (const c of eventNames) assert.match(c, /\/event\//);
  for (const c of invokeNames) assert.doesNotMatch(c, /\/event\//);
});

test("通道表：invoke 与 event 不重名", () => {
  for (const c of eventNames) assert.equal(invokeNames.includes(c), false);
});

test("白名单：恰好覆盖全部通道，且拒绝未登记与非字符串", () => {
  assert.equal(IPC_WHITELIST.size, invokeNames.length + eventNames.length);
  for (const c of [...invokeNames, ...eventNames]) assert.equal(isAllowedChannel(c), true);
  assert.equal(isAllowedChannel("abb/app/unknown"), false);
  assert.equal(isAllowedChannel("pi-desktop/app/getVersion"), false);
  assert.equal(isAllowedChannel(42), false);
  assert.equal(isAllowedChannel(undefined), false);
});

test("isInvokeChannel 区分 invoke 与 event", () => {
  assert.equal(isInvokeChannel(IPC.invoke.hostPing), true);
  assert.equal(isInvokeChannel(IPC.event.hostStatus), false);
});

test("路由表：后端通道都是合法 invoke 通道", () => {
  for (const c of HOST_ROUTED_CHANNELS) assert.equal(isInvokeChannel(c), true);
});

// ==================== 信封 ====================

test("wrap：成功值包成 ok 信封（含同步与异步）", async () => {
  assert.deepEqual(await wrap(() => 1), { ok: true, data: 1 });
  assert.deepEqual(await wrap(async () => ({ a: 1 })), { ok: true, data: { a: 1 } });
  assert.deepEqual(await wrap(() => undefined), { ok: true, data: undefined });
});

test("wrap：普通 Error 折算成 INTERNAL", async () => {
  const env = await wrap(() => {
    throw new Error("炸了");
  });
  assert.deepEqual(env, { ok: false, error: { code: ERROR_CODES.INTERNAL, message: "炸了" } });
});

test("wrap：CodedError 与带 code 的系统错误保留原 code", async () => {
  const coded = await wrap(() => {
    throw new CodedError("TIMEOUT", "超时");
  });
  assert.deepEqual(coded, { ok: false, error: { code: "TIMEOUT", message: "超时" } });

  const sys = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const env = await wrap(() => Promise.reject(sys));
  assert.equal(env.ok, false);
  assert.equal(!env.ok && env.error.code, "ECONNREFUSED");
});

test("wrap：抛出非 Error 值（字符串 / 数字 / 普通对象）", async () => {
  const s = await wrap(() => {
    throw "字符串错误";
  });
  assert.deepEqual(s, { ok: false, error: { code: ERROR_CODES.INTERNAL, message: "字符串错误" } });

  const n = await wrap(() => {
    throw 404;
  });
  assert.deepEqual(n, { ok: false, error: { code: ERROR_CODES.INTERNAL, message: "404" } });

  assert.deepEqual(toEnvelopeError({ code: "X", message: "m" }), { code: "X", message: "m" });
  assert.deepEqual(toEnvelopeError({ foo: 1 }), { code: ERROR_CODES.INTERNAL, message: '{"foo":1}' });
  assert.deepEqual(toEnvelopeError(null), { code: ERROR_CODES.INTERNAL, message: "null" });
});

test("wrap：空字符串 code 视为无 code", () => {
  const e = Object.assign(new Error("m"), { code: "" });
  assert.equal(toEnvelopeError(e).code, ERROR_CODES.INTERNAL);
});

test("isEnvelope 校验形状", () => {
  assert.equal(isEnvelope(okEnvelope(1)), true);
  assert.equal(isEnvelope(errEnvelope("X", "m")), true);
  assert.equal(isEnvelope({ ok: true }), false);
  assert.equal(isEnvelope({ ok: false, error: { code: 1, message: "m" } }), false);
  assert.equal(isEnvelope({ ok: "yes" }), false);
  assert.equal(isEnvelope(null), false);
});

// ==================== 主进程 ⇄ 后端 消息协议 ====================

test("消息协议：请求与响应的形状校验", () => {
  assert.equal(isHostRequestMessage({ type: "request", id: 1, channel: "c", args: [] }), true);
  assert.equal(isHostRequestMessage({ type: "request", id: "1", channel: "c", args: [] }), false);
  assert.equal(isHostRequestMessage({ type: "request", id: 1, channel: "c" }), false);

  assert.equal(isHostOutboundMessage({ type: "response", id: 1, envelope: okEnvelope(1) }), true);
  assert.equal(isHostOutboundMessage({ type: "response", id: 1, envelope: null }), false);
  assert.equal(isHostOutboundMessage({ type: "ready", pid: 7 }), true);
  assert.equal(isHostOutboundMessage({ type: "ready" }), false);
  assert.equal(isHostOutboundMessage({ type: "event", channel: "x", payload: 1 }), true);
  assert.equal(isHostOutboundMessage({ type: "boom" }), false);
  assert.equal(isHostOutboundMessage("ready"), false);
});

// ==================== 后端分发 ====================

test("分发：已知通道正确分发并透传参数", async () => {
  const dispatch = createDispatcher({ "abb/x/add": (a, b) => Number(a) + Number(b) });
  assert.deepEqual(await dispatch("abb/x/add", [2, 3]), { ok: true, data: 5 });
});

test("分发：未知通道返回 UNKNOWN_CHANNEL 而不是抛错", async () => {
  const dispatch = createDispatcher({});
  const env = await dispatch("abb/nope", []);
  assert.equal(env.ok, false);
  assert.equal(!env.ok && env.error.code, ERROR_CODES.UNKNOWN_CHANNEL);
});

test("分发：原型链上的名字不会被当成通道", async () => {
  const dispatch = createDispatcher({});
  for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    const env = await dispatch(name, []);
    assert.equal(!env.ok && env.error.code, ERROR_CODES.UNKNOWN_CHANNEL, name);
  }
});

test("分发：handler 同步抛错与异步拒绝都被包成信封", async () => {
  const dispatch = createDispatcher({
    sync: () => {
      throw new CodedError("BAD", "同步错");
    },
    async: async () => {
      throw new Error("异步错");
    },
  });
  assert.deepEqual(await dispatch("sync", []), { ok: false, error: { code: "BAD", message: "同步错" } });
  assert.deepEqual(await dispatch("async", []), {
    ok: false,
    error: { code: ERROR_CODES.INTERNAL, message: "异步错" },
  });
});

test("分发表与路由表一致：后端实现的通道 = 主进程转发的通道", () => {
  const ctx = createHostContext({
    dataRoot: "C:/nonexistent-abb-test",
    emit: () => {},
    log: () => {},
    openDatabase: () => {
      throw new Error("本测试不应打开数据库");
    },
  });
  const implemented = new Set(listChannels(createHostHandlers(ctx)));
  assert.deepEqual(implemented, new Set(HOST_ROUTED_CHANNELS));
});

test("路由表：本地通道与后端通道互斥，且合起来覆盖全部 invoke 通道", () => {
  for (const c of LOCAL_CHANNELS) assert.equal(HOST_ROUTED_CHANNELS.has(c), false);
  assert.equal(LOCAL_CHANNELS.size + HOST_ROUTED_CHANNELS.size, invokeNames.length);
});

// ==================== 健康检查 handler ====================

test("host/ping：返回注入的 pid / node / 运行时长", async () => {
  const dispatch = createDispatcher(
    createHealthHandlers({
      ixClient: { getProfileList: async () => [] },
      pid: 4321,
      nodeVersion: "24.0.0",
      uptimeSec: () => 12.345,
      now: () => 1000,
    }),
  );
  assert.deepEqual(await dispatch(IPC.invoke.hostPing, []), {
    ok: true,
    data: { pid: 4321, node: "24.0.0", uptimeSec: 12.3, at: 1000 },
  });
});

test("ixbrowser/ping：可达时 reachable=true，并以 limit=1 调用", async () => {
  const calls = [];
  let t = 100;
  const dispatch = createDispatcher(
    createHealthHandlers({
      ixClient: {
        getProfileList: async (q) => {
          calls.push(q);
          t += 42;
          return [{ profile_id: 1 }];
        },
      },
      ixEndpoint: "http://127.0.0.1:53200",
      now: () => t,
    }),
  );
  const env = await dispatch(IPC.invoke.ixbrowserPing, []);
  assert.deepEqual(calls, [{ limit: 1 }]);
  assert.deepEqual(env, {
    ok: true,
    data: { reachable: true, endpoint: "http://127.0.0.1:53200", sampleCount: 1, error: null, elapsedMs: 42 },
  });
});

test("ixbrowser/ping：服务不可达时不抛错，返回 reachable=false 与原因", async () => {
  const dispatch = createDispatcher(
    createHealthHandlers({
      ixClient: {
        getProfileList: async () => {
          throw new Error("exception desc:fetch failed");
        },
      },
      now: () => 0,
    }),
  );
  const env = await dispatch(IPC.invoke.ixbrowserPing, []);
  assert.equal(env.ok, true);
  assert.equal(env.ok && /** @type {any} */ (env.data).reachable, false);
  assert.equal(env.ok && /** @type {any} */ (env.data).error, "exception desc:fetch failed");
  assert.equal(env.ok && /** @type {any} */ (env.data).sampleCount, null);
});

// ==================== 路由 + 注册器 ====================

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`重复注册 ${channel}`);
      handlers.set(channel, fn);
    },
  };
}

function fakeHost(result = okEnvelope("from-host")) {
  const calls = [];
  return {
    calls,
    request: async (channel, args) => {
      calls.push([channel, args]);
      return result;
    },
  };
}

test("路由：后端通道转发，本地通道返回 ROUTE_LOCAL", async () => {
  const host = fakeHost();
  const router = createBackendRouter(host);
  assert.deepEqual(await router.route(IPC.invoke.hostPing, [1]), okEnvelope("from-host"));
  assert.equal(await router.route(IPC.invoke.appGetVersion, []), ROUTE_LOCAL);
  assert.deepEqual(host.calls, [[IPC.invoke.hostPing, [1]]]);
});

test("注册器：install 为每个 invoke 通道挂一次 handler，且不挂事件通道", () => {
  const ipcMain = fakeIpcMain();
  createIpcRegistrar(ipcMain, createBackendRouter(fakeHost())).install();
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [...invokeNames].sort());
});

test("注册器：本地通道执行本地 handler，后端通道走后端，均返回信封", async () => {
  const ipcMain = fakeIpcMain();
  const host = fakeHost();
  const registrar = createIpcRegistrar(ipcMain, createBackendRouter(host));
  registrar.handle(IPC.invoke.appGetVersion, () => ({ v: 1 }));
  registrar.install();

  const local = await ipcMain.handlers.get(IPC.invoke.appGetVersion)({ sender: {} });
  assert.deepEqual(local, { ok: true, data: { v: 1 } });

  const remote = await ipcMain.handlers.get(IPC.invoke.ixbrowserPing)({ sender: {} });
  assert.deepEqual(remote, okEnvelope("from-host"));
  assert.deepEqual(host.calls, [[IPC.invoke.ixbrowserPing, []]]);
});

test("注册器：白名单外的通道与未实现的本地通道都返回 UNKNOWN_CHANNEL", async () => {
  const registrar = createIpcRegistrar(fakeIpcMain(), createBackendRouter(fakeHost()));
  const outside = await registrar.invoke("abb/evil/exec", []);
  assert.equal(!outside.ok && outside.error.code, ERROR_CODES.UNKNOWN_CHANNEL);
  const missing = await registrar.invoke(IPC.invoke.hostGetStatus, []);
  assert.equal(!missing.ok && missing.error.code, ERROR_CODES.UNKNOWN_CHANNEL);
});

test("注册器：本地 handler 抛错被包成信封，不穿透 IPC", async () => {
  const registrar = createIpcRegistrar(fakeIpcMain(), createBackendRouter(fakeHost()));
  registrar.handle(IPC.invoke.appGetVersion, () => {
    throw new Error("读取版本失败");
  });
  assert.deepEqual(await registrar.invoke(IPC.invoke.appGetVersion, []), {
    ok: false,
    error: { code: ERROR_CODES.INTERNAL, message: "读取版本失败" },
  });
});

test("注册器：不允许为已路由到后端的通道登记本地 handler", () => {
  const registrar = createIpcRegistrar(fakeIpcMain(), createBackendRouter(fakeHost()));
  assert.throws(() => registrar.handle(IPC.invoke.hostPing, () => 1), /已路由到后端进程/);
});

test("registerAppHandlers：三个本地通道全部接上", async () => {
  const registrar = createIpcRegistrar(fakeIpcMain(), createBackendRouter(fakeHost()));
  /** @type {any} */ const status = { state: "ready", pid: 9, since: 1, seq: 3, detail: null };
  registerAppHandlers(registrar, {
    getVersionInfo: () => /** @type {any} */ ({ appName: "a", appVersion: "1", electron: "e", chrome: "c", node: "n", platform: "win32", arch: "x64" }),
    host: { getStatus: () => status, restart: async () => ({ ...status, state: "starting" }) },
  });
  assert.equal((await registrar.invoke(IPC.invoke.appGetVersion, [])).ok, true);
  assert.deepEqual(await registrar.invoke(IPC.invoke.hostGetStatus, []), okEnvelope(status));
  const restarted = await registrar.invoke(IPC.invoke.hostRestart, []);
  assert.equal(restarted.ok && /** @type {any} */ (restarted.data).state, "starting");
});

// ==================== 审查修正：来源校验 / 事件通道 / 导航 ====================

test("isEventChannel 只认事件通道", () => {
  assert.equal(isEventChannel(IPC.event.hostStatus), true);
  assert.equal(isEventChannel(IPC.invoke.hostPing), false);
  assert.equal(isEventChannel("abb/x/event/y"), false);
  assert.equal(isEventChannel(1), false);
});

test("FORBIDDEN 已登记在错误码表", () => {
  assert.equal(ERROR_CODES.FORBIDDEN, "FORBIDDEN");
});

test("senderFrameUrl：从 event.senderFrame.url 取值，异常形状返回 null", () => {
  assert.equal(senderFrameUrl({ senderFrame: { url: "file:///a" } }), "file:///a");
  assert.equal(senderFrameUrl({ senderFrame: null }), null);
  assert.equal(senderFrameUrl({ senderFrame: { url: 1 } }), null);
  assert.equal(senderFrameUrl({}), null);
  assert.equal(senderFrameUrl(null), null);
});

test("注册器：来源不可信时返回 FORBIDDEN 且不触达后端", async () => {
  const ipcMain = fakeIpcMain();
  const host = fakeHost();
  const logs = [];
  createIpcRegistrar(ipcMain, createBackendRouter(host), {
    isTrustedSender: (e) => senderFrameUrl(e) === "app://ok",
    log: (m) => logs.push(m),
  }).install();

  const bad = await ipcMain.handlers.get(IPC.invoke.hostPing)({ senderFrame: { url: "file:///evil.html" } });
  assert.equal(!bad.ok && bad.error.code, ERROR_CODES.FORBIDDEN);
  assert.equal(host.calls.length, 0);
  assert.match(logs[0], /evil\.html/);

  const good = await ipcMain.handlers.get(IPC.invoke.hostPing)({ senderFrame: { url: "app://ok" } });
  assert.deepEqual(good, okEnvelope("from-host"));
});

test("isAppUrl：生产模式只放行渲染层入口（忽略 hash/query，盘符大小写不敏感）", () => {
  const origin = { entryFileUrl: "file:///C:/app/out/renderer/index.html" };
  assert.equal(isAppUrl("file:///C:/app/out/renderer/index.html", origin), true);
  assert.equal(isAppUrl("file:///c:/app/out/renderer/index.html#/x?y=1", origin), true);
  assert.equal(isAppUrl("file:///C:/app/out/renderer/other.html", origin), false);
  assert.equal(isAppUrl("file:///C:/APP/out/renderer/index.html", origin), false);
  assert.equal(isAppUrl("file:///C:/Users/x/Desktop/evil.html", origin), false);
  assert.equal(isAppUrl("https://example.com/", origin), false);
  assert.equal(isAppUrl("not a url", origin), false);
  assert.equal(isAppUrl(null, origin), false);
  assert.equal(isAppUrl("", origin), false);
});

test("isAppUrl：开发模式按 dev server 同源判断", () => {
  const origin = { devServerUrl: "http://localhost:5173", entryFileUrl: "file:///C:/x/index.html" };
  assert.equal(isAppUrl("http://localhost:5173/", origin), true);
  assert.equal(isAppUrl("http://localhost:5173/@vite/client", origin), true);
  assert.equal(isAppUrl("http://localhost:5174/", origin), false);
  assert.equal(isAppUrl("file:///C:/x/index.html", origin), false);
  assert.equal(isAppUrl("http://localhost:5173/", { devServerUrl: "::bad", entryFileUrl: "" }), false);
});
