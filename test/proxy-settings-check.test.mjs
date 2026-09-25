/**
 * 代理连通性检测的应用层 + handler 单测
 *
 * 探测函数一律注入（真机行为另有探针：proxy-check.test.mjs 钉协议字节，真实出网在真机验证）。
 * 这里管的是：结果写库、列表带出状态、单条失败不拖累整批、并发有上限、下标漂移拒绝、handler 校验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { initDb } from "../src/db/schema.ts";
import { ProxyRepository } from "../src/db/proxy-repository.ts";
import { createProxySettings, PROXY_CHECK_CONCURRENCY } from "../src/application/proxy-settings.ts";
import { SETTINGS_INVOKE } from "../app/shared/channels/settings.ts";
import { createProxiesHandlers } from "../app/host/handlers/settings/proxies.ts";

/** 内存库 + 代理仓储（不碰仓库根的真实数据） */
function makeRepo() {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  return new ProxyRepository(db);
}

const config = { get: (_key, fallback) => fallback };

function settings(repo, checkProxy) {
  return createProxySettings({ repo, config, checkProxy });
}

/** 探测替身：按 host 返回预设结果，并记录调用 */
function fakeProbe(table, { delayMs = 0 } = {}) {
  const calls = [];
  let running = 0;
  let peak = 0;
  const probe = async (input) => {
    calls.push(input);
    running += 1;
    peak = Math.max(peak, running);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    running -= 1;
    const preset = table[String(input.host)] ?? { ok: false, outbound_ip: null, error: "无预设" };
    return preset;
  };
  probe.calls = calls;
  probe.peak = () => peak;
  return probe;
}

test("检测成功后结果写库，列表能带出状态灯所需的字段", async () => {
  const repo = makeRepo();
  repo.addProxy({ proxy_type: "http", host: "1.2.3.4", port: "8080", username: "", password: "" });
  const probe = fakeProbe({ "1.2.3.4": { ok: true, outbound_ip: "9.9.9.9", error: null } });
  const svc = settings(repo, probe);

  /** @type {any[]} */ const rows = svc.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_check_ok, null, "检测前是 null（未检测）");
  assert.equal(rows[0].outbound_ip, null);

  const results = await svc.check([{ index: 0, key: "1.2.3.4:8080" }]);
  assert.deepEqual(
    results.map((r) => ({ ok: r.ok, ip: r.outbound_ip, error: r.error })),
    [{ ok: true, ip: "9.9.9.9", error: null }],
  );

  /** @type {any[]} */ const after = svc.list();
  assert.equal(after[0].last_check_ok, true);
  assert.equal(after[0].outbound_ip, "9.9.9.9");
  assert.equal(after[0].last_check_error, null);
  assert.match(String(after[0].last_check_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "本地时间串");
});

test("不可达写 ok=false + 原因，重新检测成功后原因被清掉", async () => {
  const repo = makeRepo();
  repo.addProxy({ proxy_type: "http", host: "5.6.7.8", port: "1080", username: "", password: "" });
  /** @type {any} */ let outcome = { ok: false, outbound_ip: null, error: "ECONNREFUSED: 连接被拒" };
  const svc = settings(repo, async () => outcome);

  await svc.check([{ index: 0, key: "5.6.7.8:1080" }]);
  /** @type {any} */ let row = svc.list()[0];
  assert.equal(row.last_check_ok, false);
  assert.match(row.last_check_error, /ECONNREFUSED/);
  assert.equal(row.outbound_ip, null);

  outcome = { ok: true, outbound_ip: "1.1.1.1", error: null };
  await svc.check([{ index: 0, key: "5.6.7.8:1080" }]);
  row = svc.list()[0];
  assert.equal(row.last_check_ok, true);
  assert.equal(row.last_check_error, null, "成功后旧的失败原因必须清掉");
  assert.equal(row.outbound_ip, "1.1.1.1");
});

test("一批里单条失败不影响其它条（逐条返回真实结果，不抛错）", async () => {
  const repo = makeRepo();
  repo.addProxy({ proxy_type: "http", host: "a", port: "1", username: "", password: "" });
  repo.addProxy({ proxy_type: "socks5", host: "b", port: "2", username: "", password: "" });
  repo.addProxy({ proxy_type: "http", host: "c", port: "3", username: "", password: "" });
  const probe = fakeProbe({
    a: { ok: true, outbound_ip: "10.0.0.1", error: null },
    b: { ok: false, outbound_ip: null, error: "超时（8000ms）" },
    c: { ok: true, outbound_ip: "10.0.0.3", error: null },
  });
  const svc = settings(repo, probe);

  const results = await svc.check([
    { index: 0, key: "a:1" },
    { index: 1, key: "b:2" },
    { index: 2, key: "c:3" },
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.equal(/** @type {any} */ (results[1]).error, "超时（8000ms）");
  /** @type {any[]} */ const rows = svc.list();
  assert.deepEqual(rows.map((r) => r.last_check_ok), [true, false, true]);
});

test("并发有上限（同时探测数不超过 PROXY_CHECK_CONCURRENCY）", async () => {
  const repo = makeRepo();
  const refs = [];
  for (let i = 0; i < 12; i++) {
    const host = `h${i}`;
    repo.addProxy({ proxy_type: "http", host, port: "1", username: "", password: "" });
    refs.push({ index: i, key: `${host}:1` });
  }
  const probe = fakeProbe({}, { delayMs: 5 });
  const svc = settings(repo, probe);

  await svc.check(refs);
  assert.equal(probe.calls.length, 12);
  assert.ok(probe.peak() <= PROXY_CHECK_CONCURRENCY, `并发峰值 ${probe.peak()} 应 ≤ ${PROXY_CHECK_CONCURRENCY}`);
  assert.equal(PROXY_CHECK_CONCURRENCY, 4);
});

test("下标漂移（key 对不上）直接拒绝，不误测别的代理", async () => {
  const repo = makeRepo();
  repo.addProxy({ proxy_type: "http", host: "a", port: "1", username: "", password: "" });
  const probe = fakeProbe({ a: { ok: true, outbound_ip: "1.1.1.1", error: null } });
  const svc = settings(repo, probe);

  await assert.rejects(() => svc.check([{ index: 0, key: "别的:9999" }]), /代理列表已变化/);
  assert.equal(probe.calls.length, 0, "拒绝时不应发起任何探测");
});

test("handler：空 refs 报错、超上限报错、正常路径返回逐条结果", async () => {
  const repo = makeRepo();
  repo.addProxy({ proxy_type: "http", host: "a", port: "1", username: "", password: "" });
  const probe = fakeProbe({ a: { ok: true, outbound_ip: "2.2.2.2", error: null } });
  /** @type {any} */ const ctx = {
    proxyRepo: () => repo,
    config: () => config,
  };
  /** @type {any} */ const handlers = createProxiesHandlers(ctx, { checkProxy: probe });
  /** @type {any} */ const check = handlers[SETTINGS_INVOKE.settingsProxiesCheck];

  await assert.rejects(() => check([]), /请先选择/);
  const tooMany = Array.from({ length: 501 }, () => ({ index: 0, key: "a:1" }));
  await assert.rejects(() => check(tooMany), /一次最多检测/);
  await assert.rejects(() => check([{ index: -1, key: "a:1" }]), /index/);

  const results = await check([{ index: 0, key: "a:1" }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].outbound_ip, "2.2.2.2");
});
