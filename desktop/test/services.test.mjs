/** 外部服务客户端单测 —— 全部用注入的依赖，绝不触碰真实服务（SMS-Bus / Sub2API 客户端已随功能删除） */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodeFromEmail,
  isFromGoogle,
  classifyConnectError,
  fetchVerificationCode,
} from "../src/services/email-code-reader.ts";

const noSleep = async () => {};
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