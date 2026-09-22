/**
 * ixBrowser 客户端单测 —— 用注入的 fetch 验证信封解包逻辑
 * 跑法：cd desktop && node --test test/ixbrowser.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IxBrowserClient,
  IxHttpError,
  IxResponseError,
  IxUnexpectedError,
} from "../src/ixbrowser/client.ts";

/** 构造一个假的 fetch，返回给定 JSON */
function fakeFetch(body, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      status,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

test("成功响应返回 data", async () => {
  const f = fakeFetch({ error: { code: 0, message: "success" }, data: { total: 2, data: [{ profile_id: 1 }, { profile_id: 2 }] } });
  const c = new IxBrowserClient({ fetchImpl: f });
  const list = await c.getProfileList({ page: 1, limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(c.total, 2);
});

test("成功但无 data 时返回 true（对齐 Python）", async () => {
  const f = fakeFetch({ error: { code: 0, message: "success" } });
  const c = new IxBrowserClient({ fetchImpl: f });
  const r = await c.call("profile-close", { profile_id: 1 });
  assert.equal(r, true);
});

test("error.code !== 0 抛 IxResponseError 并带上 code", async () => {
  const f = fakeFetch({ error: { code: 2007, message: "窗口不存在" }, data: null });
  const c = new IxBrowserClient({ fetchImpl: f });
  await assert.rejects(() => c.closeProfile(999999999), (err) => {
    assert.ok(err instanceof IxResponseError);
    assert.equal(err.code, 2007);
    assert.equal(err.message, "窗口不存在");
    return true;
  });
});

test("HTTP 非 200 抛 IxHttpError", async () => {
  const f = fakeFetch({}, 500);
  const c = new IxBrowserClient({ fetchImpl: f });
  await assert.rejects(() => c.call("profile-list"), (err) => err instanceof IxHttpError && err.status === 500);
});

test("缺少 error 键抛 IxUnexpectedError", async () => {
  const f = fakeFetch({ data: {} });
  const c = new IxBrowserClient({ fetchImpl: f });
  await assert.rejects(() => c.call("profile-list"), (err) =>
    err instanceof IxUnexpectedError && err.message.includes("'error' key"));
});

test("缺少 error.code 抛 IxUnexpectedError", async () => {
  const f = fakeFetch({ error: { message: "x" } });
  const c = new IxBrowserClient({ fetchImpl: f });
  await assert.rejects(() => c.call("profile-list"), (err) =>
    err instanceof IxUnexpectedError && err.message.includes("'error.code' key"));
});

test("全部请求都是 POST + JSON", async () => {
  const f = fakeFetch({ error: { code: 0 }, data: { total: 0, data: [] } });
  const c = new IxBrowserClient({ fetchImpl: f });
  await c.getProfileList();
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["Content-Type"], "application/json");
  assert.match(f.calls[0].url, /\/api\/v2\/profile-list$/);
});

test("传 profileId 时只发 profile_id，丢弃 page/limit", async () => {
  const f = fakeFetch({ error: { code: 0 }, data: { total: 1, data: [{ profile_id: 833 }] } });
  const c = new IxBrowserClient({ fetchImpl: f });
  await c.getProfileList({ profileId: 833, page: 5, limit: 99 });
  assert.deepEqual(f.calls[0].body, { profile_id: 833 });
});

test("keyword 发出去的键名是 name 而非 keyword", async () => {
  const f = fakeFetch({ error: { code: 0 }, data: { total: 0, data: [] } });
  const c = new IxBrowserClient({ fetchImpl: f });
  await c.getProfileList({ keyword: "gmail" });
  assert.equal(f.calls[0].body.name, "gmail");
  assert.equal(f.calls[0].body.keyword, undefined);
});

test("group_id/tag_id 仅在 >0 时携带", async () => {
  const f = fakeFetch({ error: { code: 0 }, data: { total: 0, data: [] } });
  const c = new IxBrowserClient({ fetchImpl: f });
  await c.getProfileList({ groupId: 0, tagId: 5 });
  assert.equal(f.calls[0].body.group_id, undefined);
  assert.equal(f.calls[0].body.tag_id, 5);
});

test("openProfile 不传 cookie 时不发送该键", async () => {
  const f = fakeFetch({ error: { code: 0 }, data: { ws: "ws://x", debugging_address: "127.0.0.1:1", webdriver: "d", pid: 1, profile_id: 1 } });
  const c = new IxBrowserClient({ fetchImpl: f });
  await c.openProfile(1);
  assert.ok(!("cookie" in f.calls[0].body));
  assert.deepEqual(f.calls[0].body.args, ["--disable-extension-welcome-page"]);
});

test("openProfile 不重复追加 welcome-page 参数", async () => {
  const f = fakeFetch({ error: { code: 0 }, data: { ws: "ws://x", debugging_address: "", webdriver: "", pid: 1, profile_id: 1 } });
  const c = new IxBrowserClient({ fetchImpl: f });
  await c.openProfile(1, { startupArgs: ["--disable-extension-welcome-page", "--foo"] });
  assert.deepEqual(f.calls[0].body.args, ["--disable-extension-welcome-page", "--foo"]);
});

test("网络异常包装成 IxUnexpectedError", async () => {
  const c = new IxBrowserClient({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  await assert.rejects(() => c.call("profile-list"), (err) =>
    err instanceof IxUnexpectedError && err.message.includes("exception desc:"));
});
