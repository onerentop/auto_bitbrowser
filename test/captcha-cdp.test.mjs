/**
 * src/engine/captcha/cdp.ts 的离线测试。
 *
 * 注入假 WebSocket（不建真实连接）：id 路由、sessionId 路由、事件分发、
 * 请求超时 → {__error:"timeout"}、close() 幂等、端点解析、页面目标选择三条规则。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CdpConnection, fetchPageTarget, parseHostPort, pickPageTarget } from "../src/engine/captcha/cdp.ts";

const WS_URL = "ws://127.0.0.1:49693/devtools/browser/6c0f0cbd-1111";

/** 假 WebSocket：记录发出的消息 / 关闭次数；默认自动回包（关掉即模拟超时） */
class FakeSocket {
  /** @param {string} url */
  constructor(url) {
    /** @type {string} */
    this.url = url;
    /** @type {any[]} */
    this.sent = [];
    /** @type {number} */
    this.closed = 0;
    /** @type {boolean} */
    this.autoRespond = true;
    /** @type {((msg: any) => any) | null} */
    this.responder = null;
    /** @type {((ev?: unknown) => void) | null} */
    this.onopen = null;
    /** @type {((ev: { data: unknown }) => void) | null} */
    this.onmessage = null;
    /** @type {((ev: unknown) => void) | null} */
    this.onerror = null;
  }
  /** @param {string} data */
  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (!this.autoRespond) return;
    const extra = this.responder ? this.responder(msg) : {};
    queueMicrotask(() => this.emit(Object.assign({ id: msg.id }, extra)));
  }
  close() {
    this.closed += 1;
  }
  open() {
    const fn = this.onopen;
    if (fn) fn();
  }
  /** @param {Record<string, unknown>} msg */
  emit(msg) {
    const fn = this.onmessage;
    if (fn) fn({ data: JSON.stringify(msg) });
  }
}

/**
 * 建连接：createSocket 注入假 socket，onopen 后 connect() 完成
 * @param {{ timeoutMs?: number }} [options]
 */
async function connectFake(options = {}) {
  /** @type {FakeSocket[]} */
  const created = [];
  /** @type {(url: string) => import("../src/engine/captcha/cdp.ts").WebSocketLike} */
  const createSocket = (url) => {
    const s = new FakeSocket(url);
    created.push(s);
    return s;
  };
  const conn = new CdpConnection(WS_URL, Object.assign({ createSocket }, options));
  const pending = conn.connect();
  const sock = created[0];
  if (!sock) throw new Error("未创建 socket");
  sock.open();
  await pending;
  return { conn, sock };
}

test("connect：方法顺序与 setAutoAttach 参数（Page.enable → Runtime.enable → setAutoAttach → bringToFront）", { timeout: 5000 }, async () => {
  const { sock } = await connectFake();
  assert.equal(sock.url, WS_URL);
  assert.deepEqual(
    sock.sent.map((m) => m.method),
    ["Page.enable", "Runtime.enable", "Target.setAutoAttach", "Page.bringToFront"],
  );
  assert.deepEqual(sock.sent[2]?.params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
});

test("connect：握手阶段 CDP 报错 → 抛异常并且**关掉 socket**（不泄漏连接）", { timeout: 5000 }, async () => {
  /** @type {FakeSocket[]} */
  const created = [];
  /** @type {(url: string) => import("../src/engine/captcha/cdp.ts").WebSocketLike} */
  const createSocket = (url) => {
    const s = new FakeSocket(url);
    created.push(s);
    return s;
  };
  const conn = new CdpConnection(WS_URL, { createSocket });
  const pending = conn.connect();
  const sock = created[0];
  if (!sock) throw new Error("未创建 socket");
  // 窗口正在关闭 / 浏览器无响应时，握手命令会返回 CDP error
  sock.responder = (msg) => (msg.method === "Page.enable" ? { error: { code: -32000, message: "Not attached to an active page" } } : {});
  sock.open();

  await assert.rejects(pending, /Page.enable 失败/);
  assert.equal(sock.closed, 1, "握手失败必须关掉 socket：宿主后端常驻，漏一条就是漏一个 FD");
  // 关掉的连接不再被复用
  assert.deepEqual(await conn.send("Page.enable"), { __error: "closed" });
});

test("send/evaluate：按 id 路由响应；页面级请求不带 sessionId，带 sessionId 时放进消息体", { timeout: 5000 }, async () => {
  const { conn, sock } = await connectFake();
  sock.responder = (msg) => ({
    result: { result: { value: msg.sessionId ? `session:${msg.sessionId}` : "page" } },
  });
  assert.equal(await conn.evaluate("location.pathname"), "page");
  assert.equal(await conn.evaluate("location.pathname", "S1"), "session:S1");
  const evals = sock.sent.filter((m) => m.method === "Runtime.evaluate");
  assert.equal(evals.length, 2);
  const [first, second] = evals;
  if (!first || !second) throw new Error("缺少 evaluate 请求");
  assert.equal("sessionId" in first, false, "页面级请求不得带 sessionId");
  assert.equal(second.sessionId, "S1", "OOPIF 请求必须带 sessionId");
  assert.equal(second.id, first.id + 1, "id 递增");
  assert.equal(first.params.expression, "location.pathname");
  assert.equal(first.params.returnByValue, true);
});

test("on()：Target.attachedToTarget 收集 session（url 可能为空）、detached 移除、其它事件分发给订阅者", { timeout: 5000 }, async () => {
  const { conn, sock } = await connectFake();
  /** @type {Record<string, unknown>[]} */
  const events = [];
  conn.on((msg) => events.push(msg));
  sock.emit({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { url: "" } } });
  sock.emit({
    method: "Target.attachedToTarget",
    params: { sessionId: "S2", targetInfo: { url: "https://www.google.com/recaptcha/enterprise/bframe" } },
  });
  assert.deepEqual(conn.sessions, [
    { sessionId: "S1", url: "" },
    { sessionId: "S2", url: "https://www.google.com/recaptcha/enterprise/bframe" },
  ]);
  sock.emit({ method: "Runtime.executionContextCreated", params: { context: { id: 7 } } });
  assert.equal(events.length, 3);
  assert.equal(events[2]?.method, "Runtime.executionContextCreated");
  sock.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });
  assert.deepEqual(conn.sessions, [{ sessionId: "S2", url: "https://www.google.com/recaptcha/enterprise/bframe" }]);
  conn.close();
});

test("send 超时：返回 {__error:'timeout'}（不抛异常），evaluate 返回 null", { timeout: 5000 }, async () => {
  const { conn, sock } = await connectFake({ timeoutMs: 20 });
  sock.autoRespond = false;
  assert.deepEqual(await conn.send("Runtime.evaluate", { expression: "1" }), { __error: "timeout" });
  assert.equal(await conn.evaluate("1"), null);
  conn.close();
});

test("close()：幂等（socket.close 只调一次）；关闭后 send 返回 {__error:'closed'}", { timeout: 5000 }, async () => {
  const { conn, sock } = await connectFake();
  conn.close();
  conn.close();
  assert.equal(sock.closed, 1);
  assert.deepEqual(await conn.send("Page.enable"), { __error: "closed" });
});

test("parseHostPort：从 ws URL 解析 host:port；非法输入返回 null", () => {
  assert.equal(parseHostPort("ws://127.0.0.1:49693/devtools/browser/x"), "127.0.0.1:49693");
  assert.equal(parseHostPort("ws://localhost:9222/devtools/browser/abc"), "localhost:9222");
  assert.equal(parseHostPort("127.0.0.1:49693"), null);
  assert.equal(parseHostPort(""), null);
});

test("pickPageTarget：精确 URL > accounts.google.com > 第一个 page；没有 page → null", () => {
  const exact = {
    type: "page",
    url: "https://accounts.google.com/v3/signin/challenge/recaptcha?hl=en",
    webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/exact",
  };
  const google = {
    type: "page",
    url: "https://accounts.google.com/v3/signin/identifier?hl=en",
    webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/google",
  };
  const other = { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/other" };
  const worker = { type: "service_worker", url: "https://x.test/sw.js", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/sw" };

  assert.equal(pickPageTarget([google, other, exact], exact.url), exact, "规则 1：URL 全等优先（即使前面还有别的 page）");
  assert.equal(pickPageTarget([other, google], "https://example.com/other"), google, "规则 2：accounts.google.com");
  assert.equal(pickPageTarget([worker, other], ""), other, "规则 3：第一个 page（跳过非 page）");
  assert.equal(pickPageTarget([worker], ""), null, "没有 page → null");
  assert.equal(pickPageTarget([], "https://accounts.google.com"), null);
});

test("fetchPageTarget：GET /json/list → pickPageTarget；坏 JSON / 非 page → null", { timeout: 5000 }, async () => {
  /** @type {string[]} */
  const urls = [];
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fetchImpl = async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          { type: "page", url: "https://accounts.google.com/v3/signin/identifier", webSocketDebuggerUrl: "ws://127.0.0.1:49693/devtools/page/1" },
        ]),
    };
  };
  const target = await fetchPageTarget("127.0.0.1:49693", "https://accounts.google.com/v3/signin/identifier", fetchImpl);
  assert.equal(target?.url, "https://accounts.google.com/v3/signin/identifier");
  assert.equal(target?.webSocketDebuggerUrl, "ws://127.0.0.1:49693/devtools/page/1");
  assert.deepEqual(urls, ["http://127.0.0.1:49693/json/list"]);

  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const badJson = async () => ({ ok: true, status: 200, text: async () => "<html>no</html>" });
  assert.equal(await fetchPageTarget("127.0.0.1:49693", "", badJson), null);

  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const notOk = async () => ({ ok: false, status: 502, text: async () => "[]" });
  assert.equal(await fetchPageTarget("127.0.0.1:49693", "", notOk), null);
});
