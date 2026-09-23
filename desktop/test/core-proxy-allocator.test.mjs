/**
 * services/proxy-smart-allocator.ts 单测（全离线）
 *
 * 所有外部依赖都是替身：假 Sub2ApiClient（不发 HTTP）、假 IxBrowserClient（不碰 :53200）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PROXY_CACHE_TTL_SECONDS,
  ProxySmartAllocator,
  createProxyInfo,
  proxyInfoFromDict,
} from "../src/services/proxy-smart-allocator.ts";

// ==================== 替身 ====================

/** 假 Sub2ApiClient：只实现分配器用到的两个方法 */
function fakeSub2Api(opts = {}) {
  const calls = { proxies: 0, updateAccount: [] };
  return {
    calls,
    async getAllProxiesWithCount() {
      calls.proxies += 1;
      if (opts.proxiesResponse) return opts.proxiesResponse;
      return { success: true, data: opts.proxies ?? [] };
    },
    async updateAccount(accountId, payload) {
      calls.updateAccount.push({ accountId, payload });
      return opts.updateResponse ?? { success: true, data: {} };
    },
  };
}

/** 假 IxBrowserClient：只实现分配器用到的两个方法 */
function fakeIx(opts = {}) {
  const calls = { proxy: [], note: [] };
  return {
    calls,
    async updateProfileProxy(profileId, config) {
      calls.proxy.push({ profileId, config });
      if (opts.proxyThrows) throw new Error("ix proxy boom");
      return opts.proxyResult ?? true;
    },
    async updateProfile(profileId, payload) {
      calls.note.push({ profileId, payload });
      if (opts.noteThrows) throw new Error("ix note boom");
      return opts.noteResult ?? true;
    },
  };
}

function makeAllocator(sub2api, ix, options = {}) {
  return new ProxySmartAllocator(sub2api, {
    ixClient: ix,
    log: () => {},
    sleepImpl: async () => {},
    ...options,
  });
}

// ==================== ProxyInfo ====================

test("createProxyInfo: 默认值与 Python dataclass 一致", () => {
  assert.deepEqual(createProxyInfo(), {
    id: 0,
    name: "",
    protocol: "http",
    host: "",
    port: 0,
    username: "",
    password: "",
    account_count: 0,
    status: "active",
  });
  assert.equal(createProxyInfo({ name: "p1", port: 8080 }).name, "p1");
});

test("proxyInfoFromDict: 缺字段/假值一律回落默认值，port 走 int(x or 0)", () => {
  assert.deepEqual(proxyInfoFromDict({}), createProxyInfo());

  const p = proxyInfoFromDict({
    id: 7,
    name: "东京",
    protocol: "",
    host: "1.2.3.4",
    port: "8080",
    account_count: null,
    status: "",
  });
  assert.equal(p.id, 7);
  assert.equal(p.name, "东京");
  assert.equal(p.protocol, "http", "空串回落默认协议");
  assert.equal(p.port, 8080, "字符串端口被转成整数");
  assert.equal(p.account_count, 0);
  assert.equal(p.status, "active", "空串回落 active");

  // 非数字端口不抛错，返回 0（与 Python 的 ValueError 是刻意差异）
  assert.equal(proxyInfoFromDict({ port: "abc" }).port, 0);
});

test("DEFAULT_PROXY_CACHE_TTL_SECONDS = 5.0", () => {
  assert.equal(DEFAULT_PROXY_CACHE_TTL_SECONDS, 5.0);
});

// ==================== 缓存与选取 ====================

test("getLeastUsedProxy: 选择 account_count 最小的代理", async () => {
  const api = fakeSub2Api({
    proxies: [
      { id: 1, name: "a", account_count: 5, host: "h1", port: 1 },
      { id: 2, name: "b", account_count: 1, host: "h2", port: 2 },
      { id: 3, name: "c", account_count: 3, host: "h3", port: 3 },
    ],
  });
  const alloc = makeAllocator(api, fakeIx());
  const proxy = await alloc.getLeastUsedProxy();
  assert.equal(proxy.id, 2);
  assert.equal(proxy.account_count, 1);
});

test("refreshProxyCache: 过滤掉 status 非 active 的代理（含 status=null）", async () => {
  const api = fakeSub2Api({
    proxies: [
      { id: 1, name: "active", account_count: 9, status: "active" },
      { id: 2, name: "disabled", account_count: 0, status: "disabled" },
      { id: 3, name: "nullstatus", account_count: 0, status: null },
      { id: 4, name: "nokey", account_count: 8 }, // 无 status 键 → 视为 active
    ],
  });
  const alloc = makeAllocator(api, fakeIx());
  const stats = await alloc.getProxyStats();
  assert.deepEqual(
    stats.map((s) => s.id),
    [4, 1],
  );
});

test("refreshProxyCache: 支持 {items:[...]} 与 {proxies:[...]} 两种响应外壳", async () => {
  const wrapped = fakeSub2Api({ proxiesResponse: { success: true, data: { items: [{ id: 11, name: "i" }] } } });
  assert.equal((await makeAllocator(wrapped, fakeIx()).getLeastUsedProxy()).id, 11);

  const alt = fakeSub2Api({ proxiesResponse: { success: true, data: { proxies: [{ id: 22, name: "p" }] } } });
  assert.equal((await makeAllocator(alt, fakeIx()).getLeastUsedProxy()).id, 22);
});

test("getLeastUsedProxy: 拉取失败或列表为空时返回 null", async () => {
  const failing = fakeSub2Api({ proxiesResponse: { success: false, error: "网络异常" } });
  assert.equal(await makeAllocator(failing, fakeIx()).getLeastUsedProxy(), null);

  const empty = fakeSub2Api({ proxies: [] });
  assert.equal(await makeAllocator(empty, fakeIx()).getLeastUsedProxy(), null);
});

test("getProxyStats: 按 account_count 升序并只保留 5 个字段", async () => {
  const api = fakeSub2Api({
    proxies: [
      { id: 1, name: "a", account_count: 5, host: "h1", port: 1, password: "p" },
      { id: 2, name: "b", account_count: 2, host: "h2", port: 2, password: "p" },
    ],
  });
  const stats = await makeAllocator(api, fakeIx()).getProxyStats();
  assert.deepEqual(stats, [
    { id: 2, name: "b", account_count: 2, host: "h2", port: 2 },
    { id: 1, name: "a", account_count: 5, host: "h1", port: 1 },
  ]);
});

// ==================== allocateAndBind ====================

test("allocateAndBind: 成功路径同步更新 Sub2API + ixBrowser，并让本地缓存 +1", async () => {
  const api = fakeSub2Api({
    proxies: [
      { id: 1, name: "东京-1", protocol: "socks5", host: "1.1.1.1", port: 1080, username: "u", password: "pw", account_count: 0 },
      { id: 2, name: "东京-2", account_count: 4 },
    ],
  });
  const ix = fakeIx();
  const alloc = makeAllocator(api, ix);
  const msgs = [];

  const ok = await alloc.allocateAndBind(999, "123", (m) => msgs.push(m));
  assert.equal(ok, true);

  assert.deepEqual(api.calls.updateAccount, [
    { accountId: 999, payload: { proxyId: 1, notes: "东京-1" } },
  ]);
  assert.deepEqual(ix.calls.proxy, [
    {
      profileId: 123,
      config: {
        proxy_type: "socks5",
        proxy_ip: "1.1.1.1",
        proxy_port: "1080",
        proxy_user: "u",
        proxy_password: "pw",
      },
    },
  ]);
  assert.deepEqual(ix.calls.note, [{ profileId: 123, payload: { note: "东京-1" } }]);
  assert.ok(msgs.every((m) => m.startsWith("[ProxyBind] ")));

  // 缓存里该代理 account_count 从 0 → 1；下次选取时 id=2(4) 仍大于它
  const stats = await alloc.getProxyStats();
  assert.equal(api.calls.proxies, 2, "getProxyStats 会强制刷新");
  assert.equal(stats.length, 2);
});

test("allocateAndBind: 无可用代理时直接返回 false，不调用 ixBrowser", async () => {
  const api = fakeSub2Api({ proxies: [] });
  const ix = fakeIx();
  assert.equal(await makeAllocator(api, ix).allocateAndBind(1, "2"), false);
  assert.deepEqual(api.calls.updateAccount, []);
  assert.deepEqual(ix.calls.proxy, []);
});

test("allocateAndBind: Sub2API 更新失败时返回 false，不再动 ixBrowser", async () => {
  const api = fakeSub2Api({
    proxies: [{ id: 1, name: "p", account_count: 0 }],
    updateResponse: { success: false, error: "403" },
  });
  const ix = fakeIx();
  assert.equal(await makeAllocator(api, ix).allocateAndBind(1, "2"), false);
  assert.equal(api.calls.updateAccount.length, 1);
  assert.deepEqual(ix.calls.proxy, []);
});

test("allocateAndBind: ixBrowser 更新失败/抛异常不影响整体成功（Sub2API 绑定仍生效）", async () => {
  const api = fakeSub2Api({ proxies: [{ id: 1, name: "p", account_count: 0 }] });
  const ix = fakeIx({ proxyThrows: true, noteResult: false });
  assert.equal(await makeAllocator(api, ix).allocateAndBind(1, "2"), true);
  assert.equal(ix.calls.proxy.length, 1);
  assert.equal(ix.calls.note.length, 1);
});

test("allocateAndBind: 非数字的窗口 ID 只让 ixBrowser 步骤失败，整体仍返回 true", async () => {
  const api = fakeSub2Api({ proxies: [{ id: 1, name: "p", account_count: 0 }] });
  const ix = fakeIx();
  assert.equal(await makeAllocator(api, ix).allocateAndBind(1, "not-a-number"), true);
  assert.deepEqual(ix.calls.proxy, [], "int() 转换先抛错，压根没调到 ix");
  assert.deepEqual(ix.calls.note, []);
});

test("allocateAndBind: 并发调用被锁串行化，代理列表只拉取一次（缓存命中）", async () => {
  const api = fakeSub2Api({
    proxies: [
      { id: 1, name: "a", account_count: 0 },
      { id: 2, name: "b", account_count: 0 },
    ],
  });
  const ix = fakeIx();
  const alloc = makeAllocator(api, ix, { cacheTtl: 1000 });

  const results = await Promise.all([
    alloc.allocateAndBind(1, "10"),
    alloc.allocateAndBind(2, "11"),
    alloc.allocateAndBind(3, "12"),
  ]);

  assert.deepEqual(results, [true, true, true]);
  assert.equal(api.calls.proxies, 1, "缓存未过期时不重复拉取");
  // 平均分配：第 1、3 次落到 id=1，第 2 次落到 id=2
  assert.deepEqual(
    api.calls.updateAccount.map((c) => c.payload.proxyId),
    [1, 2, 1],
  );
});

test("allocateAndBind: Sub2API 抛异常被 catch，返回 false", async () => {
  const api = fakeSub2Api({ proxies: [{ id: 1, name: "p", account_count: 0 }] });
  api.updateAccount = async () => {
    throw new Error("连接被重置");
  };
  assert.equal(await makeAllocator(api, fakeIx()).allocateAndBind(1, "2"), false);
});
