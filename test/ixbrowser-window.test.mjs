/**
 * src/ixbrowser/window.ts（对标 services/ix_window.py）与 AccountRepository 新增方法
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  deleteBrowserById,
  getBrowserInfo,
  getBrowserList,
  getNextWindowName,
  isRetryableError,
  openBrowserById,
} from "../src/ixbrowser/window.ts";
import { initDb } from "../src/db/schema.ts";
import { AccountRepository } from "../src/db/account-repository.ts";

function deps(client) {
  const sleeps = [];
  const logs = [];
  return { deps: { client, sleep: async (ms) => sleeps.push(ms), log: (m) => logs.push(m) }, sleeps, logs };
}

function pagedClient(total, { failPage = 0, failTimes = 0, failMsg = "timeout" } = {}) {
  const calls = [];
  let failed = 0;
  return {
    calls,
    async getProfileList(q) {
      calls.push(q);
      if (q.page === failPage && failed < failTimes) {
        failed++;
        throw new Error(failMsg);
      }
      const start = (q.page - 1) * q.limit;
      const n = Math.max(0, Math.min(q.limit, total - start));
      return Array.from({ length: n }, (_, i) => ({ profile_id: start + i + 1, name: `w_${start + i + 1}` }));
    },
    async openProfile() {
      return { ws: "x" };
    },
    async deleteProfile() {
      return true;
    },
  };
}

test("isRetryableError：关键词不区分大小写；空值不重试", () => {
  assert.equal(isRetryableError("ECONNREFUSED 127.0.0.1"), true);
  assert.equal(isRetryableError("exception desc:fetch failed network"), true);
  assert.equal(isRetryableError("profile not exist"), false);
  assert.equal(isRetryableError(""), false);
  assert.equal(isRetryableError(null), false);
});

test("getBrowserList：自动翻页，最后一页不足 limit 时停止", async () => {
  const client = pagedClient(250);
  const { deps: d } = deps(client);
  const list = await getBrowserList(d, { limit: 100 });
  assert.equal(list.length, 250);
  assert.deepEqual(client.calls.map((c) => c.page), [1, 2, 3]);
  assert.equal(client.calls[0].groupId, 0);
});

test("getBrowserList：总数恰为 limit 整数倍时多取一页空页再停", async () => {
  const client = pagedClient(200);
  const { deps: d } = deps(client);
  assert.equal((await getBrowserList(d, { limit: 100 })).length, 200);
  assert.deepEqual(client.calls.map((c) => c.page), [1, 2, 3]);
});

test("getBrowserList：可重试错误按 1s/2s 退避后成功", async () => {
  const client = pagedClient(5, { failPage: 1, failTimes: 2 });
  const { deps: d, sleeps } = deps(client);
  assert.equal((await getBrowserList(d)).length, 5);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("getBrowserList：中途某页失败时返回已取到的部分，不抛错", async () => {
  const client = pagedClient(250, { failPage: 2, failTimes: 99, failMsg: "bad request" });
  const { deps: d, sleeps } = deps(client);
  const list = await getBrowserList(d, { limit: 100 });
  assert.equal(list.length, 100);
  assert.deepEqual(sleeps, []); // 不可重试错误不等待
});

test("getBrowserList：可重试错误耗尽 3 次重试后放弃", async () => {
  const client = pagedClient(5, { failPage: 1, failTimes: 99 });
  const { deps: d, sleeps } = deps(client);
  assert.deepEqual(await getBrowserList(d), []);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("getBrowserList：fetchAll=false 只取指定页", async () => {
  const client = pagedClient(250);
  const { deps: d } = deps(client);
  const list = await getBrowserList(d, { fetchAll: false, page: 2, limit: 100 });
  assert.equal(list[0].profile_id, 101);
  assert.equal(client.calls.length, 1);
});

test("getBrowserInfo：按 profileId 查，查不到返回 null", async () => {
  const client = {
    async getProfileList(q) {
      return q.profileId === 7 ? [{ profile_id: 7 }] : [];
    },
  };
  const { deps: d } = deps(client);
  assert.deepEqual(await getBrowserInfo(d, 7), { profile_id: 7 });
  assert.equal(await getBrowserInfo(d, 8), null);
});

test("openBrowserById / deleteBrowserById：无效 id 返回 false；失败返回 false 不抛", async () => {
  const opened = [];
  const client = {
    async openProfile(id, opts) {
      opened.push([id, opts]);
      return { ws: "x" };
    },
    async deleteProfile() {
      throw new Error("profile not exist");
    },
  };
  const { deps: d } = deps(client);
  assert.equal(await openBrowserById(d, ""), false);
  assert.equal(await openBrowserById(d, 0), false);
  assert.equal(await openBrowserById(d, "12"), true);
  assert.deepEqual(opened, [[12, { cookiesBackup: false, loadProfileInfoPage: false }]]);
  assert.equal(await deleteBrowserById(d, 12), false);
});

test("getNextWindowName：取前缀后最大整数序号 + 1，忽略非整数后缀", async () => {
  const client = {
    async getProfileList() {
      return [{ name: "美国_3" }, { name: "美国_10" }, { name: "美国_x" }, { name: "美国_2.5" }, { name: "英国_99" }];
    },
  };
  const { deps: d } = deps(client);
  assert.equal(await getNextWindowName(d, "美国"), "美国_11");
  assert.equal(await getNextWindowName(d, "日本"), "日本_1");
});

// ==================== AccountRepository 新增方法 ====================

function repoWith(rows) {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  const repo = new AccountRepository(db);
  for (const r of rows) {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO accounts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
      ...cols.map((c) => r[c]),
    );
  }
  return { db, repo };
}

test("deleteAccount：删到返回 true，不存在返回 false", () => {
  const { repo } = repoWith([{ email: "a@x.com" }]);
  assert.equal(repo.deleteAccount("a@x.com"), true);
  assert.equal(repo.deleteAccount("a@x.com"), false);
});

test("bindAccountToBrowser：绑定、空串解绑、不存在的邮箱返回 false", () => {
  const { repo } = repoWith([{ email: "a@x.com" }]);
  assert.equal(repo.bindAccountToBrowser("a@x.com", "123"), true);
  assert.equal(repo.getAccountByEmail("a@x.com").browser_profile_id, "123");
  assert.equal(repo.bindAccountToBrowser("a@x.com", ""), true);
  assert.equal(repo.getAccountByEmail("a@x.com").browser_profile_id, "");
  assert.equal(repo.bindAccountToBrowser("no@x.com", "1"), false);
});
