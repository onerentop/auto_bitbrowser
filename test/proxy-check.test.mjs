/**
 * 代理连通性检测单测 —— 用假 socket 钉住协议字节与失败路径
 *
 * 为什么不用真网络：出站探测在 CI 上不可靠；这里测的是「我们发的协议对不对、判定对不对」。
 * 真机行为另有探针验证（scratch 的 probe-proxy*.mjs）：HTTP CONNECT 与 SOCKS5 都能回读出站 IP，
 * 不可达代理 3ms 内 ECONNREFUSED；而 fetch(url,{proxy}) 对不可达代理会静默直连返回 200（假绿灯），
 * 所以实现必须走手写隧道，不能用 fetch。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkProxy, parseOutboundIp, PROXY_CHECK_DEFAULT_TIMEOUT_MS } from "../src/application/proxy-check.ts";

/** 假 socket：记录写入、可被脚本驱动回包 */
class FakeSocket extends EventEmitter {
  constructor(script) {
    super();
    this.writes = [];
    this.destroyed = false;
    this.script = script;
  }
  write(data) {
    this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "latin1"));
    this.script?.(this, this.writes.length);
  }
  destroy() {
    this.destroyed = true;
  }
  setTimeout() {}
  text() {
    return Buffer.concat(this.writes).toString("latin1");
  }
}

/** 连接成功后按脚本回包的假 connect */
function fakeConnect(script) {
  const sockets = [];
  const connect = (port, host) => {
    /** @type {any} */ const s = new FakeSocket(script);
    s.port = port;
    s.host = host;
    sockets.push(s);
    queueMicrotask(() => s.emit("connect"));
    return s;
  };
  connect.sockets = sockets;
  return connect;
}

const target = { host: "api.ipify.org", port: 80 };

test("HTTP 代理：发 CONNECT 请求行 + Host，收到 200 后发 GET，解析出站 IP", async () => {
  const connect = fakeConnect((s, n) => {
    // 第 1 次写入是 CONNECT（回 200 建立隧道），第 2 次是 GET（回出站 IP）
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n")));
    else if (n === 2) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n1.2.3.4")));
  });
  const r = await checkProxy({ proxy_type: "http", host: "127.0.0.1", port: "7897", username: "", password: "" }, { connect, target });
  assert.equal(r.ok, true, `应成功: ${JSON.stringify(r)}`);
  assert.equal(r.outbound_ip, "1.2.3.4");
  assert.equal(r.error, null);
  const text = connect.sockets[0].text();
  assert.match(text, /^CONNECT api\.ipify\.org:80 HTTP\/1\.1\r\n/);
  assert.match(text, /Host: api\.ipify\.org:80\r\n/);
  assert.match(text, /GET \/ HTTP\/1\.1\r\n/);
  assert.ok(!/Proxy-Authorization/.test(text), "无凭据时不发 Proxy-Authorization");
});

test("HTTP 代理带凭据：发 Proxy-Authorization: Basic", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n")));
    else if (n === 2) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n9.9.9.9")));
  });
  const r = await checkProxy({ proxy_type: "http", host: "h", port: "8080", username: "u", password: "p" }, { connect, target });
  assert.equal(r.ok, true);
  assert.equal(r.outbound_ip, "9.9.9.9");
  // Basic dTpw
  assert.match(connect.sockets[0].text(), /Proxy-Authorization: Basic dTpw\r\n/);
});

test("HTTP 代理：CONNECT 被拒（407/403）判失败并带原因", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")));
  });
  const r = await checkProxy({ proxy_type: "https", host: "h", port: "1", username: "", password: "" }, { connect, target });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /407/);
  assert.equal(r.outbound_ip, null);
});

test("不可达代理：连接错误直接判失败（不能出现假绿灯）", async () => {
  const connect = () => {
    const s = new FakeSocket();
    queueMicrotask(() => {
      /** @type {any} */ const err = new Error("connect ECONNREFUSED 127.0.0.1:9");
      err.code = "ECONNREFUSED";
      s.emit("error", err);
    });
    return s;
  };
  const r = await checkProxy({ proxy_type: "http", host: "127.0.0.1", port: "9", username: "", password: "" }, { connect, target });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /ECONNREFUSED/);
  assert.equal(r.outbound_ip, null);
});

test("SOCKS5 无认证：握手 [5,1,0] → CONNECT 域名请求 → 解析出站 IP", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from([5, 0])));
    else if (n === 2) queueMicrotask(() => s.emit("data", Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])));
    else if (n === 3) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n5.6.7.8")));
  });
  const r = await checkProxy({ proxy_type: "socks5", host: "h", port: "1080", username: "", password: "" }, { connect, target });
  assert.equal(r.ok, true, `应成功: ${JSON.stringify(r)}`);
  assert.equal(r.outbound_ip, "5.6.7.8");
  const first = connect.sockets[0].writes[0];
  assert.deepEqual([...first], [5, 1, 0], "无凭据时应只提供「无认证」一种方法");
  const second = connect.sockets[0].writes[1];
  assert.deepEqual([...second.subarray(0, 5)], [5, 1, 0, 3, 13], "CONNECT 用域名类型，长度 13（api.ipify.org）");
  assert.equal(second.subarray(5, 18).toString(), "api.ipify.org");
  assert.equal(second.readUInt16BE(18), 80);
});

test("SOCKS5 带认证：握手 [5,1,2] → 用户名密码包 → CONNECT", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from([5, 2])));
    else if (n === 2) queueMicrotask(() => s.emit("data", Buffer.from([1, 0])));
    else if (n === 3) queueMicrotask(() => s.emit("data", Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])));
    else if (n === 4) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n7.7.7.7")));
  });
  const r = await checkProxy({ proxy_type: "socks5", host: "h", port: "1080", username: "u1", password: "p1" }, { connect, target });
  assert.equal(r.ok, true, `应成功: ${JSON.stringify(r)}`);
  const w = connect.sockets[0].writes;
  assert.deepEqual([...w[0]], [5, 1, 2], "有凭据时应提供用户名密码方法");
  assert.deepEqual([...w[1]], [1, 2, 117, 49, 2, 112, 49], "用户名密码包：ver=1 uLen=2 u1 pLen=2 p1");
});

test("SOCKS5 认证失败 / 代理拒绝全部方法 → 判失败", async () => {
  const refused = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from([5, 0xff])));
  });
  const r1 = await checkProxy({ proxy_type: "socks5", host: "h", port: "1", username: "", password: "" }, { connect: refused, target });
  assert.equal(r1.ok, false);
  assert.match(String(r1.error), /认证/);

  const badPass = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from([5, 2])));
    else if (n === 2) queueMicrotask(() => s.emit("data", Buffer.from([1, 1])));
  });
  const r2 = await checkProxy({ proxy_type: "socks5", host: "h", port: "1", username: "u", password: "x" }, { connect: badPass, target });
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /用户名|密码/);
});

test("超时判失败（默认 8 秒）", async () => {
  assert.equal(PROXY_CHECK_DEFAULT_TIMEOUT_MS, 8000);
  const connect = fakeConnect(() => {});
  const r = await checkProxy(
    { proxy_type: "http", host: "h", port: "1", username: "", password: "" },
    { connect, target, timeoutMs: 30, // 假 socket 的 setTimeout 是空实现，这里直接给一个立刻触发的实现
      setTimeoutImpl: (cb) => setTimeout(cb, 10) },
  );
  assert.equal(r.ok, false);
  assert.match(String(r.error), /超时/);
});

test("响应体里的 IP 形态：带换行 / 前后空白都能解析", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n")));
    else if (n === 2) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n\n  8.8.8.8\r\n")));
  });
  const r = await checkProxy({ proxy_type: "http", host: "h", port: "1", username: "", password: "" }, { connect, target });
  assert.equal(r.outbound_ip, "8.8.8.8");
});

test("响应里没有 IP → 判失败（不能把非 IP 文本当成功）", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n")));
    else if (n === 2) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n<html>blocked</html>")));
  });
  const r = await checkProxy({ proxy_type: "http", host: "h", port: "1", username: "", password: "" }, { connect, target });
  assert.equal(r.ok, false);
  assert.equal(r.outbound_ip, null);
});

test("非法 IPv4（段 > 255）不算出站 IP，避免把版本号之类当 IP", () => {
  assert.equal(parseOutboundIp("999.1.2.3"), null);
  assert.equal(parseOutboundIp("1.2.3.4"), "1.2.3.4");
});

test("真机回归（审查修正）：GET 阶段的响应分片到达时不能误判失败——头部先到、正文后到仍要判成功", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n")));
    else if (n === 2) {
      // 第一次只到头部（不含出站 IP），第二次才到正文 —— 真实网络里很常见
      queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n")));
      queueMicrotask(() => queueMicrotask(() => s.emit("data", Buffer.from("1.2.3.4"))));
    }
  });
  const r = await checkProxy({ proxy_type: "http", host: "h", port: "1", username: "", password: "" }, { connect, target });
  assert.equal(r.ok, true, `分片到达应判成功: ${JSON.stringify(r)}`);
  assert.equal(r.outbound_ip, "1.2.3.4");
});

test("响应收完仍没有 IP → 等连接关闭后再如实判失败（不提前下结论）", async () => {
  const connect = fakeConnect((s, n) => {
    if (n === 1) queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n")));
    else if (n === 2) {
      queueMicrotask(() => s.emit("data", Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 18\r\n\r\n<html>blocked</html>")));
      queueMicrotask(() => queueMicrotask(() => s.emit("close")));
    }
  });
  const r = await checkProxy({ proxy_type: "http", host: "h", port: "1", username: "", password: "" }, { connect, target });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /没有出站 IP/);
});
