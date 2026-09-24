/** proxy-allocator / data-store 单测（内存 SQLite） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ProxyAllocator } from "../src/services/proxy-allocator.ts";
import { ProxyRepository } from "../src/db/proxy-repository.ts";
import { DataStore, makeProxyInfo, proxyToUrl } from "../src/services/data-store.ts";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, proxy_type TEXT, username TEXT,
    password TEXT, host TEXT, port TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`CREATE TABLE proxy_window_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, proxy_id INTEGER, browser_id TEXT UNIQUE,
    email TEXT, bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  return db;
}

// ---------------- ProxyAllocator ----------------

function seedProxies(db, n = 2) {
  const repo = new ProxyRepository(db);
  for (let i = 1; i <= n; i += 1) {
    repo.addProxy({ proxy_type: "socks5", host: `10.0.0.${i}`, port: "1080", username: "u", password: "p" });
  }
  return repo;
}

test("代理: 分配后写入绑定，满额后不再分配", () => {
  const db = freshDb();
  const repo = seedProxies(db, 1);
  const alloc = new ProxyAllocator(repo, 2);

  assert.ok(alloc.allocateProxy("win1", "a@b.com"));
  assert.ok(alloc.allocateProxy("win2", "c@d.com"));
  assert.equal(alloc.allocateProxy("win3"), null, "超过 maxPerIp 应无可用代理");
  assert.equal(repo.getProxyBindingCount(1), 2);
  db.close();
});

test("代理: 解绑后释放额度", () => {
  const db = freshDb();
  const repo = seedProxies(db, 1);
  const alloc = new ProxyAllocator(repo, 1);
  alloc.allocateProxy("win1");
  assert.equal(alloc.hasAvailableProxy(), false);
  alloc.unbindWindow("win1");
  assert.equal(alloc.hasAvailableProxy(), true);
  db.close();
});

test("代理: 同一 browser_id 重复绑定为改绑而非新增", () => {
  const db = freshDb();
  const repo = seedProxies(db, 2);
  const alloc = new ProxyAllocator(repo, 5);
  repo.bindProxyToWindow(1, "win1", "a@b.com");
  repo.bindProxyToWindow(2, "win1", "a@b.com");
  assert.equal(repo.getProxyBindingCount(1), 0);
  assert.equal(repo.getProxyBindingCount(2), 1);
  db.close();
});

test("代理: 剩余额度统计", () => {
  const db = freshDb();
  const repo = seedProxies(db, 2);
  const alloc = new ProxyAllocator(repo, 3);
  assert.equal(alloc.getAvailableCount(), 6);
  alloc.allocateProxy("w1");
  assert.equal(alloc.getAvailableCount(), 5);
  db.close();
});

test("代理: ixBrowser 配置字段名转换", () => {
  const cfg = ProxyAllocator.getProxyConfigForBrowser({
    id: 1, proxy_type: "http", host: "h", port: 8080, username: "u", password: "p",
  });
  assert.deepEqual(cfg, { type: "http", host: "h", port: 8080, username: "u", password: "p" });
  assert.equal(ProxyAllocator.getProxyConfigForBrowser(null), null);
});

// ---------------- DataStore ----------------

test("DataStore: 增删改即时落库", () => {
  const db = freshDb();
  const repo = new ProxyRepository(db);
  const store = new DataStore(repo, { silent: true });

  store.addProxy(makeProxyInfo({ host: "1.1.1.1", port: "80" }));
  store.addProxy(makeProxyInfo({ host: "2.2.2.2", port: "81" }));
  assert.equal(repo.count(), 2);

  store.removeProxy(0);
  assert.equal(repo.count(), 1);
  const first = repo.getAllProxies()[0];
  assert.ok(first);
  assert.equal(first.host, "2.2.2.2");

  store.clearProxies();
  assert.equal(repo.count(), 0);
  db.close();
});

test("DataStore: saveAllProxies 会清理冗余并连带删绑定", () => {
  const db = freshDb();
  const repo = new ProxyRepository(db);
  repo.addProxy({ host: "1.1.1.1", port: "80" });
  repo.bindProxyToWindow(1, "win1", null);
  assert.equal(repo.getProxyBindingCount(1), 1);

  repo.saveAllProxies([{ host: "9.9.9.9", port: "99" }]);
  assert.equal(repo.count(), 1);
  const first = repo.getAllProxies()[0];
  assert.ok(first);
  assert.equal(first.host, "9.9.9.9");
  db.close();
});

test("DataStore: reload 从库重新加载", () => {
  const db = freshDb();
  const repo = new ProxyRepository(db);
  const store = new DataStore(repo, { silent: true });
  repo.addProxy({ host: "5.5.5.5", port: "50" });
  assert.equal(store.getProxies().length, 0);
  store.reload();
  assert.equal(store.getProxies().length, 1);
  db.close();
});

test("DataStore: proxyToUrl 有无凭据两种形式", () => {
  assert.equal(proxyToUrl(makeProxyInfo({ host: "h", port: "1", username: "u", password: "p" })), "socks5://u:p@h:1");
  assert.equal(proxyToUrl(makeProxyInfo({ host: "h", port: "1" })), "socks5://h:1");
});