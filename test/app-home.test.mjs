/**
 * 首页（ixBrowser 窗口管理）：分组列表容错、构树 / 过滤纯函数、打开 / 删除任务、配置读写、参数校验
 * 全部离线：ixBrowser 客户端是假的，配置写在临时目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ERROR_CODES } from "../app/shared/envelope.ts";
import { HOME_INVOKE, HOME_TASK_TYPES } from "../app/shared/channels/home.ts";
import { TaskRunner } from "../app/host/task-runner.ts";
import { createHostContext } from "../app/host/context.ts";
import { createDispatcher } from "../app/host/dispatch.ts";
import { createHomeHandlers } from "../app/host/handlers/home.ts";
import { runBrowserBatch } from "../src/application/browser-batch.ts";
import { getGroupList } from "../src/ixbrowser/groups.ts";
import {
  buildBrowserTree,
  buildGroupOptions,
  cleanText,
  filterBrowserTree,
  groupLabel,
  refreshSummary,
  selectAllVisible,
  selectedProfileIds,
} from "../app/shared/logic/home-tree.ts";
import { ConfigManager } from "../src/core/config-manager.ts";

// ==================== 工具 ====================

function fakeClient(overrides = {}) {
  /** @type {{ open: any[]; del: any[]; groups: number; profiles: any[] }} */
  const calls = { open: [], del: [], groups: 0, profiles: [] };
  /** @type {any} */
  const client = {
    calls,
    async getGroupList() {
      calls.groups++;
      return [];
    },
    async getProfileList(q) {
      calls.profiles.push(q);
      return [];
    },
    async openProfile(id) {
      calls.open.push(id);
      return { ws: "", debugging_address: "", webdriver: "", pid: 1, profile_id: id };
    },
    async deleteProfile(id) {
      calls.del.push(id);
      return true;
    },
    ...overrides,
  };
  return client;
}

/** @param {Record<string, any> | null} [configJson] */
function setup(clientOverrides = {}, configJson = null) {
  const dir = mkdtempSync(join(tmpdir(), "abb-home-"));
  if (configJson !== null) writeFileSync(join(dir, "config.json"), JSON.stringify(configJson, null, 2), "utf-8");
  const client = fakeClient(clientOverrides);
  const logs = [];
  // 结束事件排队：先到的事件等后来的 nextFinished() 取走，反之亦然
  const done = [];
  const waiters = [];
  const events = [];
  const runner = new TaskRunner({
    emit: (channel, payload) => events.push([channel, payload]),
    onFinished: (e) => (waiters.length ? waiters.shift()(e) : done.push(e)),
  });
  const base = createHostContext({ dataRoot: dir, emit: () => {}, ixClient: client, log: (m) => logs.push(m) });
  const ctx = { ...base, tasks: runner };
  const handlers = createHomeHandlers(ctx);
  const dispatch = createDispatcher(handlers);
  return {
    dir,
    client,
    ctx,
    runner,
    events,
    dispatch,
    logs,
    nextFinished: () => (done.length ? Promise.resolve(done.shift()) : new Promise((r) => waiters.push(r))),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const taskLogs = (events) => events.filter(([c]) => c === "abb/task/event/log").map(([, p]) => p.message);

// ==================== 分组列表容错（src/ixbrowser/groups.ts） ====================

test("getGroupList：成功直接返回数组；data 非数组时返回 []", async () => {
  assert.deepEqual(await getGroupList({ client: { getGroupList: async () => [{ id: 2, title: "A" }] } }), [
    { id: 2, title: "A" },
  ]);
  assert.deepEqual(await getGroupList({ client: { getGroupList: async () => /** @type {any} */ ({ x: 1 }) } }), []);
});

test("getGroupList：可重试错误按 1s/2s 退避后成功", async () => {
  let n = 0;
  const sleeps = [];
  const logs = [];
  const res = await getGroupList({
    client: {
      getGroupList: async () => {
        if (n++ < 2) throw new Error("exception desc:connect ECONNREFUSED 127.0.0.1:53200");
        return [{ id: 3 }];
      },
    },
    sleep: async (ms) => void sleeps.push(ms),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(res, [{ id: 3 }]);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /获取分组列表异常.*1\.0秒后重试/);
});

test("getGroupList：不可重试错误立即返回 []；可重试错误耗尽后返回 []，永不抛错", async () => {
  let calls = 0;
  const r1 = await getGroupList({
    client: {
      getGroupList: async () => {
        calls++;
        throw new Error("boom");
      },
    },
  });
  assert.deepEqual(r1, []);
  assert.equal(calls, 1);

  calls = 0;
  const r2 = await getGroupList({
    client: {
      getGroupList: async () => {
        calls++;
        throw new Error("network down");
      },
    },
    sleep: async () => {},
  });
  assert.deepEqual(r2, []);
  assert.equal(calls, 4); // MAX_RETRIES=3 → 共 4 次
});

// ==================== 纯函数：分组下拉 ====================

test("buildGroupOptions：无 id=1 时补「默认分组」；标签格式与不可打印字符清洗", () => {
  const opts = buildGroupOptions([
    { id: 5, title: "工\u0000作\u200b组" },
    { id: 6, title: "" },
    { id: 7, title: "坏\ufffd名" },
  ]);
  assert.deepEqual(opts, [
    { id: 1, label: "默认分组" },
    { id: 5, label: "工作组 (ID: 5)" },
    { id: 6, label: "分组 6 (ID: 6)" },
    { id: 7, label: "分组 7 (ID: 7)" },
  ]);
  // 已有 id=1 时不补
  assert.deepEqual(buildGroupOptions([{ id: 1, title: "Default" }]), [{ id: 1, label: "Default (ID: 1)" }]);
  // 空结果（出错时 getGroupList 返回 []）只剩默认分组
  assert.deepEqual(buildGroupOptions([]), [{ id: 1, label: "默认分组" }]);
});

test("cleanText：去掉控制字符 / 格式字符 / 非 ASCII 空白，保留普通空格", () => {
  assert.equal(cleanText("a\tb\nc d\u00a0e\u2028f"), "abc def");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
});

// ==================== 纯函数：构树 ====================

test("buildBrowserTree：分组名优先 group-list，其次 profile.group_name；gid=0/缺失归「未分组」；计数与排序", () => {
  const groups = [
    { id: 2, title: "列表名" },
    { id: 9, title: "空分组" },
    { id: 0, title: "不会用到" },
  ];
  const browsers = [
    { profile_id: 11, name: "a@x.com", note: "N1", group_id: 2, group_name: "窗口里的名字" },
    { profile_id: 12, name: "b@x.com", note: "", group_id: 3, group_name: "来自窗口" },
    { profile_id: 13, name: "c@x.com", note: "", group_id: 0 },
    { profile_id: 14, name: "d@x.com", note: "" },
    { profile_id: 15, name: "e@x.com", note: "", group_id: 4, group_name: "\ufffd" },
  ];
  const { groups: tree, totalBrowsers } = buildBrowserTree(groups, browsers);
  assert.equal(totalBrowsers, 5);
  assert.deepEqual(
    tree.map((g) => [g.groupId, g.groupName, g.browsers.length]),
    [
      [0, "未分组", 2],
      [2, "列表名", 1],
      [3, "来自窗口", 1],
      [4, "分组 4", 1],
      [9, "空分组", 0],
    ],
  );
  const g1 = tree[1];
  assert.ok(g1);
  assert.equal(groupLabel(g1), "📁 列表名 (1)");
  const b = g1.browsers[0];
  assert.ok(b);
  assert.equal(b.profileId, 11);
  assert.equal(b.name, "a@x.com");
  assert.equal(b.note, "N1");
  assert.equal(b.tfaCode, "");
  assert.equal(refreshSummary(tree), "列表刷新完成，共 5 个分组，5 个窗口");
  // key 全局唯一
  const keys = tree.flatMap((g) => [g.key, ...g.browsers.map((x) => x.key)]);
  assert.equal(new Set(keys).size, keys.length);
});

test("buildBrowserTree：没有任何数据时仍有「未分组」", () => {
  const { groups, totalBrowsers } = buildBrowserTree([], []);
  assert.equal(totalBrowsers, 0);
  assert.deepEqual(groups.map((g) => g.groupName), ["未分组"]);
});

// ==================== 纯函数：过滤 / 全选 / 取选中 ====================

function sampleTree() {
  return buildBrowserTree(
    [{ id: 1, title: "默认" }, { id: 2, title: "二组" }, { id: 3, title: "空" }],
    [
      { profile_id: 1, name: "Alice@X.com", note: "", group_id: 1 },
      { profile_id: 2, name: "bob", note: "VIP 客户", group_id: 1 },
      { profile_id: 3, name: "carol", note: "", group_id: 2 },
      // group_name 含 alice，但只匹配名称和备注
      { profile_id: 4, name: "dave", note: "", group_id: 2, group_name: "alice" },
    ],
  ).groups;
}

test("filterBrowserTree：只匹配名称和备注（不区分大小写、strip）；全被过滤的分组隐藏；隐藏项取消勾选", () => {
  const tree = sampleTree();
  const all = tree.flatMap((g) => g.browsers.map((b) => b.key));

  const r = filterBrowserTree(tree, "  ALICE ", all);
  assert.deepEqual(r.groups.map((g) => g.groupName), ["默认"]);
  const g0 = r.groups[0];
  assert.ok(g0);
  assert.deepEqual(g0.browsers.map((b) => b.profileId), [1]);
  const g1 = tree.find((g) => g.groupId === 1);
  assert.ok(g1);
  const b0 = g1.browsers[0];
  assert.ok(b0);
  assert.deepEqual(r.checkedKeys, [b0.key]);

  const byNote = filterBrowserTree(tree, "vip", []);
  assert.deepEqual(byNote.groups.flatMap((g) => g.browsers.map((b) => b.profileId)), [2]);

  const none = filterBrowserTree(tree, "zzz", all);
  assert.deepEqual(none.groups, []);
  assert.deepEqual(none.checkedKeys, []);

  // 空搜索：全部可见（含空分组），勾选保持
  const empty = filterBrowserTree(tree, "   ", all);
  assert.equal(empty.groups.length, tree.length);
  assert.deepEqual(empty.checkedKeys, all);
});

test("selectAllVisible / selectedProfileIds：只作用于可见项", () => {
  const tree = sampleTree();
  const visible = filterBrowserTree(tree, "o", []).groups; // Alice@X.com（.com 含 o）、bob、carol
  const keys = selectAllVisible(visible, [], true);
  assert.deepEqual(selectedProfileIds(visible, keys), [1, 2, 3]);
  // 取消全选只去掉可见项
  const g2 = tree.find((g) => g.groupId === 2);
  assert.ok(g2);
  const b1 = g2.browsers[1];
  assert.ok(b1);
  const hiddenKey = b1.key; // dave，不含 o
  const kept = selectAllVisible(visible, [...keys, hiddenKey], false);
  assert.deepEqual(kept, [hiddenKey]);
  // 不可见的勾选不计入选中
  assert.deepEqual(selectedProfileIds(visible, [hiddenKey]), []);
});

// ==================== 批量任务体 ====================

test("runBrowserBatch：逐个执行、记录失败、抛错视为失败、进度到 total，并逐条上报条目", async () => {
  const logs = [];
  const progress = [];
  const items = [];
  const res = await runBrowserBatch(
    {
      log: (m) => logs.push(m),
      progress: (c, t) => progress.push([c, t]),
      item: (k, s, m) => items.push([k, s, m]),
      shouldStop: () => false,
    },
    [1, 2, 3],
    "打开",
    async (id, log) => {
      if (id === 3) throw new Error("炸了");
      if (id === 2) {
        log("底层原因: 窗口不存在");
        return false;
      }
      return id === 1;
    },
  );
  assert.deepEqual(res, { total: 3, success_count: 1, failed_count: 2, failed_ids: [2, 3] });
  assert.deepEqual(progress.at(-1), [3, 3]);
  assert.ok(logs.some((m) => m.includes("✓ 窗口 1 打开成功")));
  assert.ok(logs.some((m) => m.includes("窗口 3 打开异常: 炸了")));
  assert.ok(logs.some((m) => m.includes("底层原因: 窗口不存在")), "底层日志照旧转发到任务日志");
  // 逐条目结果：任务历史靠它统计 total / 成功 / 失败（真机上曾因不上报而全是 0）
  assert.deepEqual(items, [
    ["1", "成功", ""],
    ["2", "失败", "底层原因: 窗口不存在"],
    ["3", "失败", "炸了"],
  ]);
});

test("runBrowserBatch：停止后不再上报未处理窗口的条目", async () => {
  const items = [];
  let n = 0;
  const res = await runBrowserBatch(
    { log: () => {}, progress: () => {}, item: (k, s) => items.push([k, s]), shouldStop: () => n > 1 },
    [1, 2, 3],
    "删除",
    async () => {
      n += 1;
      return true;
    },
  );
  assert.deepEqual(res, { total: 3, success_count: 2, failed_count: 0, failed_ids: [] });
  assert.deepEqual(items, [
    ["1", "成功"],
    ["2", "成功"],
  ]);
});

// ==================== handler：打开 / 删除任务 ====================

test("openBrowsers：成功与失败混合，返回 {total, success_count, failed_count, failed_ids}；逐窗口上报条目", async (t) => {
  const s = setup({
    async openProfile(id) {
      if (id === 22) throw new Error("profile not exist");
      return { ws: "", debugging_address: "", webdriver: "", pid: 1, profile_id: id };
    },
  });
  t.after(s.cleanup);
  /** @type {any} */
  const env = await s.dispatch(HOME_INVOKE.homeOpenBrowsers, [[21, 22, 23, 21]]);
  assert.equal(env.ok, true);
  assert.equal(env.data.type, HOME_TASK_TYPES.open);
  const done = await s.nextFinished();
  assert.equal(done.outcome, "succeeded");
  assert.deepEqual(done.result, { total: 3, success_count: 2, failed_count: 1, failed_ids: [22] });
  const logs = taskLogs(s.events);
  assert.ok(logs.some((m) => m.includes("窗口打开失败: profile not exist")), "window.ts 的日志转到任务日志");
  assert.ok(s.events.some(([c, p]) => c === "abb/task/event/progress" && p.current === 3 && p.total === 3));
  assert.deepEqual(
    s.events.filter(([c]) => c === "abb/task/event/item").map(([, p]) => [p.key, p.status, p.message]),
    [
      ["21", "成功", ""],
      ["22", "失败", "窗口打开失败: profile not exist"],
      ["23", "成功", ""],
    ],
  );
});

test("deleteBrowsers：全部成功", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  /** @type {any} */
  const env = await s.dispatch(HOME_INVOKE.homeDeleteBrowsers, [[7, 8]]);
  assert.equal(env.ok, true);
  assert.equal(env.data.type, HOME_TASK_TYPES.delete);
  const done = await s.nextFinished();
  assert.equal(done.outcome, "succeeded");
  assert.deepEqual(done.result, { total: 2, success_count: 2, failed_count: 0, failed_ids: [] });
  assert.deepEqual(s.client.calls.del, [7, 8]);
});

test("deleteBrowsers：中途停止 → outcome=stopped，剩余窗口不再处理", async (t) => {
  let s;
  s = setup({
    async deleteProfile(id) {
      s.client.calls.del.push(id);
      if (id === 1) s.runner.stop();
      return true;
    },
  });
  t.after(s.cleanup);
  const env = await s.dispatch(HOME_INVOKE.homeDeleteBrowsers, [[1, 2, 3]]);
  assert.equal(env.ok, true);
  const done = await s.nextFinished();
  assert.equal(done.outcome, "stopped");
  assert.deepEqual(done.result, { total: 3, success_count: 1, failed_count: 0, failed_ids: [] });
  assert.deepEqual(s.client.calls.del, [1]);
  assert.ok(taskLogs(s.events).some((m) => m.includes("剩余 2 个窗口未处理")));
});

test("openBrowsers：已有任务运行时返回 TASK_BUSY", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  /** @type {any} */ let release;
  s.runner.start("other", "别的任务", () => new Promise((r) => (release = r)));
  const env = await s.dispatch(HOME_INVOKE.homeOpenBrowsers, [[1]]);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, ERROR_CODES.TASK_BUSY);
  await Promise.resolve();
  release();
  await s.nextFinished();
});

// ==================== handler：列表 ====================

test("listBrowsers：自动翻页取全量 + 分组树；listGroups 出错时只剩默认分组", async (t) => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ profile_id: i + 1, name: `w${i + 1}`, note: "", group_id: 2 }));
  const page2 = [{ profile_id: 101, name: "last", note: "", group_id: 0 }];
  const s = setup({
    async getGroupList() {
      return [{ id: 2, title: "业务" }];
    },
    async getProfileList(q) {
      return q.page === 1 ? page1 : q.page === 2 ? page2 : [];
    },
  });
  t.after(s.cleanup);
  /** @type {any} */
  const env = await s.dispatch(HOME_INVOKE.homeListBrowsers, []);
  assert.equal(env.ok, true);
  assert.equal(env.data.error, null);
  assert.equal(env.data.totalBrowsers, 101);
  assert.deepEqual(env.data.groups.map((g) => [g.groupName, g.browsers.length]), [
    ["未分组", 1],
    ["业务", 100],
  ]);

  const bad = setup({
    async getGroupList() {
      throw new Error("boom");
    },
  });
  t.after(bad.cleanup);
  /** @type {any} */
  const g = await bad.dispatch(HOME_INVOKE.homeListGroups, []);
  assert.equal(g.ok, true);
  assert.deepEqual(g.data.options, [{ id: 1, label: "默认分组" }]);

  /** @type {any} */
  const good = await s.dispatch(HOME_INVOKE.homeListGroups, []);
  assert.deepEqual(good.data.options, [
    { id: 1, label: "默认分组" },
    { id: 2, label: "业务 (ID: 2)" },
  ]);
});

test("listBrowsers：翻页中途失败 → 返回已取到的部分，不报错", async (t) => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ profile_id: i + 1, name: `w${i + 1}`, note: "", group_id: 0 }));
  const pages = [];
  const s = setup({
    async getProfileList(q) {
      pages.push(q.page);
      if (q.page === 1) return page1;
      throw new Error("boom"); // 不可重试错误：立即放弃后续页
    },
  });
  t.after(s.cleanup);
  /** @type {any} */
  const env = await s.dispatch(HOME_INVOKE.homeListBrowsers, []);
  assert.equal(env.ok, true);
  assert.equal(env.data.error, null, "getBrowserList 吞掉翻页错误，返回部分数据");
  assert.equal(env.data.totalBrowsers, 100);
  assert.deepEqual(pages, [1, 2]);
});

test("listBrowsers：第一页就失败 → 空树（只剩「未分组」），error 仍为 null", async (t) => {
  const s = setup({
    async getGroupList() {
      return { not: "array" }; // groups.ts 容错为 []
    },
    async getProfileList() {
      throw new Error("boom");
    },
  });
  t.after(s.cleanup);
  /** @type {any} */
  const env = await s.dispatch(HOME_INVOKE.homeListBrowsers, []);
  assert.equal(env.ok, true);
  assert.equal(env.data.error, null);
  assert.equal(env.data.totalBrowsers, 0);
  assert.deepEqual(env.data.groups.map((g) => g.groupName), ["未分组"]);
});

test("buildGroupOptions：跳过非整数 id（字符串 / 小数 / 缺失 / 非对象）", () => {
  assert.deepEqual(
    buildGroupOptions([{ id: "2", title: "S" }, { id: 2.5, title: "F" }, { title: "无 id" }, null, 7, { id: 3, title: "OK" }]),
    [
      { id: 1, label: "默认分组" },
      { id: 3, label: "OK (ID: 3)" },
    ],
  );
});

test("buildBrowserTree：有 profileId 时 key 为 b:{id}，重复 / 无效 id 退回序号 key，且全局唯一", () => {
  const { groups } = buildBrowserTree(
    [{ id: 2, title: "二" }],
    [
      { profile_id: 11, name: "a", group_id: 2 },
      { profile_id: "12", name: "b", group_id: 0 },
      { profile_id: 11, name: "dup", group_id: 2 },
      { profile_id: null, name: "none", group_id: 2 },
    ],
  );
  const byName = Object.fromEntries(groups.flatMap((g) => g.browsers.map((b) => [b.name, b.key])));
  assert.equal(byName.a, "b:11");
  assert.equal(byName.b, "b:12");
  assert.equal(byName.dup, "b:2:2");
  assert.equal(byName.none, "b:2:3");
  const keys = groups.flatMap((g) => [g.key, ...g.browsers.map((b) => b.key)]);
  assert.equal(new Set(keys).size, keys.length);
  // 刷新（同一数据重建）后 key 稳定
  const again = buildBrowserTree([{ id: 2, title: "二" }], [{ profile_id: 11, name: "a", group_id: 2 }]).groups;
  const g2 = again.find((g) => g.groupId === 2);
  assert.ok(g2);
  const b0 = g2.browsers[0];
  assert.ok(b0);
  assert.equal(b0.key, "b:11");
  // 勾选重复 id 的两行只取一次
  const all = groups.flatMap((g) => g.browsers.map((b) => b.key));
  assert.deepEqual(selectedProfileIds(groups, all), [12, 11]);
});

// ==================== handler：配置读写 ====================

test("getConfig / saveConfig：只读写 last_used_template_id 与 window_name_prefix，其他键不变", async (t) => {
  const original = {
    last_used_template_id: 123,
    window_name_prefix: "old",
    theme: "dark",
    custom_section: { a: 1, b: [1, 2] },
  };
  const s = setup({}, original);
  t.after(s.cleanup);
  const file = join(s.dir, "config.json");

  /** @type {any} */
  const got = await s.dispatch(HOME_INVOKE.homeGetConfig, []);
  assert.deepEqual(got.data, { templateId: "123", namePrefix: "old" });

  const before = new ConfigManager({ configFile: file, log: () => {} }).load();

  const saved = await s.dispatch(HOME_INVOKE.homeSaveConfig, [{ templateId: "  456  " }]);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.data, { templateId: "456", namePrefix: "old" });

  /** @type {any} */
  const saved2 = await s.dispatch(HOME_INVOKE.homeSaveConfig, [{ namePrefix: " pre " }]);
  assert.deepEqual(saved2.data, { templateId: "456", namePrefix: "pre" });

  const onDisk = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(onDisk.last_used_template_id, "456");
  assert.equal(onDisk.window_name_prefix, "pre");
  assert.equal(onDisk.theme, "dark");
  assert.deepEqual(onDisk.custom_section, { a: 1, b: [1, 2] });

  const after = new ConfigManager({ configFile: file, log: () => {} }).load();
  for (const k of ["last_used_template_id", "window_name_prefix"]) {
    delete before[k];
    delete after[k];
  }
  assert.deepEqual(after, before);
});

// ==================== handler：参数校验 ====================

test("handler 参数校验：非法参数一律 INVALID_ARGUMENT，且不会启动任务", async (t) => {
  const s = setup();
  t.after(s.cleanup);
  /** @type {Array<[string, unknown[]]>} */
  const bad = [
    [HOME_INVOKE.homeOpenBrowsers, []],
    [HOME_INVOKE.homeOpenBrowsers, [[]]],
    [HOME_INVOKE.homeOpenBrowsers, [["1"]]],
    [HOME_INVOKE.homeOpenBrowsers, [[0]]],
    [HOME_INVOKE.homeOpenBrowsers, [[1.5]]],
    [HOME_INVOKE.homeOpenBrowsers, ["1,2"]],
    [HOME_INVOKE.homeDeleteBrowsers, [[-1]]],
    [HOME_INVOKE.homeDeleteBrowsers, [[1], "extra"]],
    [HOME_INVOKE.homeSaveConfig, []],
    [HOME_INVOKE.homeSaveConfig, [null]],
    [HOME_INVOKE.homeSaveConfig, [{}]],
    [HOME_INVOKE.homeSaveConfig, [{ theme: "x" }]],
    [HOME_INVOKE.homeSaveConfig, [{ templateId: 1 }]],
    [HOME_INVOKE.homeSaveConfig, [["templateId"]]],
    [HOME_INVOKE.homeGetConfig, ["x"]],
    [HOME_INVOKE.homeListGroups, [1]],
    [HOME_INVOKE.homeListBrowsers, [{}]],
  ];
  for (const [channel, args] of bad) {
    const env = await s.dispatch(channel, args);
    assert.equal(env.ok, false, `${channel} ${JSON.stringify(args)} 应被拒绝`);
    assert.equal(env.error.code, ERROR_CODES.INVALID_ARGUMENT, `${channel} ${JSON.stringify(args)}`);
  }
  assert.equal(s.runner.busy, false);
  assert.deepEqual(s.client.calls.open, []);
  assert.deepEqual(s.client.calls.del, []);
});

test("HOME_INVOKE 的每个通道都有 handler 实现", () => {
  const s = setup();
  try {
    const implemented = Object.keys(createHomeHandlers(s.ctx)).sort();
    assert.deepEqual(implemented, Object.values(HOME_INVOKE).sort());
  } finally {
    s.cleanup();
  }
});
