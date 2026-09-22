/** 外部服务客户端单测 —— 全部用注入的 fetch，绝不触碰真实服务 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SmsBusClient, formattedNumber, SMS_CODE_WAITING } from "../src/services/sms-bus-client.ts";
import { Sub2ApiClient } from "../src/services/sub2api-client.ts";
import {
  extractCodeFromEmail,
  isFromGoogle,
  classifyConnectError,
  fetchVerificationCode,
} from "../src/services/email-code-reader.ts";

function mockFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    return { status: r.status ?? 200, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  impl.calls = calls;
  return impl;
}

const noSleep = async () => {};

// ---------------- SMS-Bus ----------------

test("SMS-Bus: token 走 query 参数，接口是 GET", async () => {
  const f = mockFetch({ body: { code: 200, data: { balance: 1.5, frozen: 0 } } });
  const c = new SmsBusClient({ token: "T0K3N", fetchImpl: f });
  const res = await c.getBalance();
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { balance: 1.5, frozen: 0 });
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get("token"), "T0K3N");
  assert.match(u.pathname, /\/api\/control\/get\/balance$/);
});

test("SMS-Bus: code !== 200 归为失败并保留 message", async () => {
  const f = mockFetch({ body: { code: 40001, message: "余额不足" } });
  const c = new SmsBusClient({ token: "t", fetchImpl: f });
  const res = await c.getBalance();
  assert.equal(res.success, false);
  assert.equal(res.error, "余额不足");
  assert.equal(res.code, 40001);
});

test("SMS-Bus: getSms 遇 50101 返回 waiting 而非错误", async () => {
  const f = mockFetch({ body: { code: SMS_CODE_WAITING, message: "no sms yet" } });
  const c = new SmsBusClient({ token: "t", fetchImpl: f });
  const [code, err] = await c.getSms(123);
  assert.equal(code, null);
  assert.equal(err, "waiting");
});

test("SMS-Bus: waitForSms 轮询到验证码", async () => {
  const f = mockFetch([
    { body: { code: SMS_CODE_WAITING } },
    { body: { code: SMS_CODE_WAITING } },
    { body: { code: 200, data: "654321" } },
  ]);
  const c = new SmsBusClient({ token: "t", fetchImpl: f, sleepImpl: noSleep });
  const [code, err] = await c.waitForSms(1, { intervalMs: 1 });
  assert.equal(code, "654321");
  assert.equal(err, null);
});

test("SMS-Bus: waitForSms 遇非 waiting 错误立即终止", async () => {
  const f = mockFetch({ body: { code: 40002, message: "请求无效" } });
  const c = new SmsBusClient({ token: "t", fetchImpl: f, sleepImpl: noSleep });
  const [code, err] = await c.waitForSms(1, { intervalMs: 1 });
  assert.equal(code, null);
  assert.equal(err, "请求无效");
  assert.equal(f.calls.length, 1, "不应重试");
});

test("SMS-Bus: waitForSms 超时", async () => {
  const f = mockFetch({ body: { code: SMS_CODE_WAITING } });
  const c = new SmsBusClient({ token: "t", fetchImpl: f, sleepImpl: noSleep });
  const [code, err] = await c.waitForSms(1, { timeoutMs: 5, intervalMs: 1 });
  assert.equal(code, null);
  assert.match(err, /超时/);
});

test("SMS-Bus: findGoogleProjectId 按 code 命中并缓存", async () => {
  const f = mockFetch({ body: { code: 200, data: { "7": { code: "wa", title: "WhatsApp" }, "12": { code: "go", title: "Google" } } } });
  const c = new SmsBusClient({ token: "t", fetchImpl: f });
  assert.equal(await c.findGoogleProjectId(), 12);
  assert.equal(await c.findGoogleProjectId(), 12);
  assert.equal(f.calls.length, 1, "第二次应走缓存");
});

test("SMS-Bus: findGoogleProjectId 可按 title 兜底", async () => {
  const f = mockFetch({ body: { code: 200, data: { "9": { code: "xx", title: "Google Voice" } } } });
  const c = new SmsBusClient({ token: "t", fetchImpl: f });
  assert.equal(await c.findGoogleProjectId(), 9);
});

test("SMS-Bus: formattedNumber 补 + 号且不重复补", () => {
  assert.equal(formattedNumber({ number: "8613800138000" }), "+8613800138000");
  assert.equal(formattedNumber({ number: "+8613800138000" }), "+8613800138000");
});

test("SMS-Bus: 网络异常转成 error 而非抛出", async () => {
  const c = new SmsBusClient({ token: "t", fetchImpl: async () => { throw new Error("ENOTFOUND"); } });
  const res = await c.getBalance();
  assert.equal(res.success, false);
  assert.match(res.error, /网络请求失败/);
});

// ---------------- Sub2API ----------------

test("Sub2API: admin 端点带 x-api-key，公共端点不带", async () => {
  const f = mockFetch({ body: { code: 0, data: { items: [] } } });
  const c = new Sub2ApiClient({ baseUrl: "http://x.io/", adminToken: "KEY", fetchImpl: f });
  await c.listAccounts();
  assert.equal(f.calls[0].init.headers["x-api-key"], "KEY");
  await c.testConnection();
  assert.equal(f.calls[1].init.headers["x-api-key"], undefined);
});

test("Sub2API: baseUrl 末尾斜杠被裁掉", async () => {
  const f = mockFetch({ body: { code: 0, data: {} } });
  const c = new Sub2ApiClient({ baseUrl: "http://x.io///", fetchImpl: f });
  await c.testConnection();
  assert.equal(new URL(f.calls[0].url).pathname, "/health");
});

test("Sub2API: HTTP 4xx 取 error 字段", async () => {
  const f = mockFetch({ status: 403, body: { error: "forbidden" } });
  const c = new Sub2ApiClient({ baseUrl: "http://x.io", fetchImpl: f });
  const res = await c.testConnection();
  assert.equal(res.success, false);
  assert.equal(res.error, "forbidden");
  assert.equal(res.statusCode, 403);
});

test("Sub2API: 业务 code !== 0 视为失败", async () => {
  const f = mockFetch({ body: { code: 1001, message: "token 无效" } });
  const c = new Sub2ApiClient({ baseUrl: "http://x.io", fetchImpl: f });
  const res = await c.testConnection();
  assert.equal(res.success, false);
  assert.equal(res.error, "token 无效");
});

test("Sub2API: code === 0 时解包内层 data，null 取空对象", async () => {
  const f = mockFetch([{ body: { code: 0, data: { a: 1 } } }, { body: { code: 0, data: null } }]);
  const c = new Sub2ApiClient({ baseUrl: "http://x.io", fetchImpl: f });
  assert.deepEqual((await c.testConnection()).data, { a: 1 });
  assert.deepEqual((await c.testConnection()).data, {});
});

test("Sub2API: checkAccountExists 匹配 name 与 credentials.email，大小写不敏感", async () => {
  const f = mockFetch({ body: { code: 0, data: { items: [
    { id: 1, name: "other@gmail.com" },
    { id: 2, name: "", credentials: { email: "TARGET@Gmail.com" } },
  ] } } });
  const c = new Sub2ApiClient({ baseUrl: "http://x.io", adminToken: "k", fetchImpl: f });
  assert.equal(await c.checkAccountExists("target@gmail.com"), 2);
});

test("Sub2API: checkAccountExists 未命中返回 null", async () => {
  const f = mockFetch({ body: { code: 0, data: { items: [{ id: 1, name: "a@b.com" }] } } });
  const c = new Sub2ApiClient({ baseUrl: "http://x.io", adminToken: "k", fetchImpl: f });
  assert.equal(await c.checkAccountExists("zzz@b.com"), null);
});

test("Sub2API: updateAccount 无字段时不发请求", async () => {
  const f = mockFetch({ body: { code: 0, data: {} } });
  const c = new Sub2ApiClient({ baseUrl: "http://x.io", adminToken: "k", fetchImpl: f });
  const res = await c.updateAccount(1);
  assert.equal(res.success, false);
  assert.equal(res.error, "没有要更新的字段");
  assert.equal(f.calls.length, 0);
});

test("Sub2API: 非 JSON 响应包装成 raw_response", async () => {
  const c = new Sub2ApiClient({ baseUrl: "http://x.io", fetchImpl: async () => ({
    status: 200, json: async () => { throw new Error("not json"); }, text: async () => "<html>",
  }) });
  const res = await c.testConnection();
  assert.equal(res.success, true);
  assert.equal(res.data.raw_response, "<html>");
});

// ---------------- 验证码提取 ----------------

test("验证码: 三种模式优先级", () => {
  assert.equal(extractCodeFromEmail("Your code: 123456 now"), "123456");
  assert.equal(extractCodeFromEmail("验证码：654321"), "654321");
  assert.equal(extractCodeFromEmail("998877 is your Google code"), "998877");
  assert.equal(extractCodeFromEmail("just 112233 here"), "112233");
  assert.equal(extractCodeFromEmail("no digits"), null);
  assert.equal(extractCodeFromEmail(""), null);
});

test("验证码: 去 HTML 标签后再匹配", () => {
  assert.equal(extractCodeFromEmail("<p>code: <b>246810</b></p>"), "246810");
});

test("验证码: 发件人判定", () => {
  assert.equal(isFromGoogle("No Reply <noreply@google.com>"), true);
  assert.equal(isFromGoogle("NOREPLY@ACCOUNTS.GOOGLE.COM"), true);
  assert.equal(isFromGoogle("someone@example.com"), false);
  assert.equal(isFromGoogle(null), false);
});

test("验证码: 连接错误归类", () => {
  assert.match(classifyConnectError("Invalid credentials"), /认证失败/);
  assert.match(classifyConnectError("AUTHENTICATIONFAILED x"), /认证失败/);
  assert.match(classifyConnectError("Connection refused"), /连接被拒绝/);
  assert.match(classifyConnectError("SOCKS error"), /代理连接失败/);
  assert.match(classifyConnectError("weird"), /连接失败/);
});

test("验证码: 轮询跳过非 Google 与过旧邮件", async () => {
  const now = Date.now();
  const source = {
    connect: async () => {},
    disconnect: async () => {},
    fetchRecent: async () => [
      { uid: "1", from: "spam@x.com", subject: "s", date: new Date(now), text: "code: 111111", html: null },
      { uid: "2", from: "noreply@google.com", subject: "old", date: new Date(now - 60 * 60_000), text: "code: 222222", html: null },
      { uid: "3", from: "noreply@google.com", subject: "ok", date: new Date(now), text: "code: 333333", html: null },
    ],
  };
  const [ok, code] = await fetchVerificationCode(source, { sleepImpl: noSleep, lookbackMinutes: 5 });
  assert.equal(ok, true);
  assert.equal(code, "333333");
});

test("验证码: 轮询超时", async () => {
  const source = { connect: async () => {}, disconnect: async () => {}, fetchRecent: async () => [] };
  const [ok, msg] = await fetchVerificationCode(source, { timeoutMs: 5, pollIntervalMs: 1, sleepImpl: noSleep });
  assert.equal(ok, false);
  assert.match(msg, /超时/);
});

test("验证码: 拉取出错时重连，重连失败即终止", async () => {
  let connects = 0;
  const source = {
    connect: async () => { connects += 1; throw new Error("Invalid credentials"); },
    disconnect: async () => {},
    fetchRecent: async () => { throw new Error("boom"); },
  };
  const [ok, msg] = await fetchVerificationCode(source, { timeoutMs: 1000, sleepImpl: noSleep });
  assert.equal(ok, false);
  assert.match(msg, /重连失败/);
  assert.match(msg, /认证失败/);
  assert.equal(connects, 1);
});