/**
 * 首页「根据模板创建窗口」（F3）单测
 *
 * 覆盖：ixBrowser 官方复制接口的调用形状、「前缀_序号」命名、「前缀为空用模板名」、
 * 批量编排的计数与逐条目、失败与停止、参数校验、handler 端到端（含模板不存在时拒绝）。
 * 全部离线：假 fetch + 假 ixBrowser 客户端。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ERROR_CODES } from "../app/shared/envelope.ts";
import { IPC } from "../app/shared/ipc.ts";
import { HOME_INVOKE, HOME_TASK_TYPES, MAX_CREATE_COUNT } from "../app/shared/channels/home.ts";
import { IxBrowserClient } from "../src/ixbrowser/client.ts";
import { createWindowsFromTemplate, resolveNamePrefix } from "../src/application/create-windows.ts";
import { createHostContext } from "../app/host/context.ts";
import { createDispatcher } from "../app/host/dispatch.ts";
import { createHomeHandlers, parseCreateSpec } from "../app/host/handlers/home.ts";

// ==================== ixBrowser 客户端：profile-copy ====================

/**
 * 假 fetch：只实现被测代码用到的字段，形状不满足 DOM 的 Response
 * @returns {any}
 */
function fakeFetch(body, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("copyProfile：调 profile-copy，只带传入的字段；data 是裸数字（真机形状）", async () => {
  // 真机实测（2026-09-24）：profile-copy 的 data 就是新窗口 ID 本身，不是 {profile_id:N}
  const f = fakeFetch({ error: { code: 0, message: "success" }, data: 835 });
  const c = new IxBrowserClient({ fetchImpl: f });

  assert.equal(await c.copyProfile(7, { name: "F3_1", groupId: 3 }), 835);
  assert.match(f.calls[0].url, /profile-copy$/);
  assert.deepEqual(f.calls[0].body, { profile_id: 7, name: "F3_1", group_id: 3 });

  // 只给名字时不能凭空塞 group_id（否则会把窗口挪到「默认分组」）
  await c.copyProfile(7, { name: "F3_2" });
  assert.deepEqual(f.calls[1].body, { profile_id: 7, name: "F3_2" });
});

test("copyProfile：data 是对象形状时也认（两种形状都兼容）", async () => {
  const f = fakeFetch({ error: { code: 0, message: "success" }, data: { profile_id: 55 } });
  const c = new IxBrowserClient({ fetchImpl: f });
  assert.equal(await c.copyProfile(7, { name: "x" }), 55);
});

test("copyProfile：拿不到可用的新窗口 ID 时抛错（绝不能静默变成 undefined）", async () => {
  // 无 data（服务端只回成功）
  await assert.rejects(
    () => new IxBrowserClient({ fetchImpl: fakeFetch({ error: { code: 0, message: "success" } }) }).copyProfile(7, { name: "x" }),
    /未返回可用的新窗口 ID/,
  );
  // data 里没有 ID
  await assert.rejects(
    () =>
      new IxBrowserClient({ fetchImpl: fakeFetch({ error: { code: 0, message: "success" }, data: {} }) }).copyProfile(7, {
        name: "x",
      }),
    /未返回可用的新窗口 ID/,
  );
  // data 是 0（非法 ID）
  await assert.rejects(
    () =>
      new IxBrowserClient({ fetchImpl: fakeFetch({ error: { code: 0, message: "success" }, data: 0 }) }).copyProfile(7, {
        name: "x",
      }),
    /未返回可用的新窗口 ID/,
  );
});

// ==================== 前缀回落 ====================

test("resolveNamePrefix：有前缀用前缀；空前缀用模板名；都为空才用 Profile", () => {
  assert.equal(resolveNamePrefix("  F3  ", "模板A"), "F3");
  assert.equal(resolveNamePrefix("", "  模板A  "), "模板A");
  assert.equal(resolveNamePrefix("   ", "   "), "Profile");
});

// ==================== 批量编排 ====================

/**
 * 造一个可观测的编排依赖
 * @param {{ names?: string[], copyFailOn?: number[], nextNameFailOn?: number[], stopAfter?: number|null }} [opts]
 */
function makeDeps({ names, copyFailOn = [], nextNameFailOn = [], stopAfter = null } = {}) {
  const created = [];
  const items = [];
  const progress = [];
  const logs = [];
  let calls = 0;
  let n = 0;
  return {
    created,
    items,
    progress,
    logs,
    deps: {
      copy: async (templateId, fields) => {
        calls += 1;
        if (copyFailOn.includes(calls)) throw new Error(`copy 炸了 #${calls}`);
        const id = 100 + calls;
        created.push({ templateId, ...fields, profile_id: id });
        return id;
      },
      nextName: async (prefix) => {
        n += 1;
        if (nextNameFailOn.includes(n)) throw new Error("列窗口失败");
        // names 里取不到时回落「前缀_序号」（与原来的三元表达式行为一致）
        return (names ? names[n - 1] : undefined) ?? `${prefix}_${n}`;
      },
      shouldStop: () => stopAfter !== null && calls >= stopAfter,
      log: (m) => logs.push(m),
      progress: (c) => progress.push(c),
      item: (k, s, m) => items.push([k, s, m]),
    },
  };
}

test("createWindowsFromTemplate：按「前缀_序号」连建 N 个，计数 / 逐条目 / 进度 / 汇总都对", async () => {
  const h = makeDeps();
  const result = await createWindowsFromTemplate({
    templateId: 7,
    count: 3,
    namePrefix: " F3 ",
    groupId: 4,
    deps: h.deps,
  });

  assert.deepEqual(result, {
    total: 3,
    success_count: 3,
    failed_count: 0,
    created: [
      { profile_id: 101, name: "F3_1" },
      { profile_id: 102, name: "F3_2" },
      { profile_id: 103, name: "F3_3" },
    ],
    failed_names: [],
  });
  assert.deepEqual(
    h.items,
    [
      ["F3_1", "成功", "新窗口 ID: 101"],
      ["F3_2", "成功", "新窗口 ID: 102"],
      ["F3_3", "成功", "新窗口 ID: 103"],
    ],
  );
  assert.deepEqual(h.progress, [0, 1, 2, 3]);
  // 前缀已 trim，且分组透传给复制接口
  assert.deepEqual(
    h.created.map((c) => [c.templateId, c.name, c.groupId]),
    [
      [7, "F3_1", 4],
      [7, "F3_2", 4],
      [7, "F3_3", 4],
    ],
  );
  assert.ok(h.logs.includes("创建完成: 成功 3，失败 0"));
});

test("createWindowsFromTemplate：不给分组时复制接口不带 group_id（沿用模板分组）", async () => {
  const h = makeDeps();
  await createWindowsFromTemplate({ templateId: 7, count: 1, namePrefix: "F3", deps: h.deps });
  assert.equal("groupId" in h.created[0], false);
});

test("createWindowsFromTemplate：中途某个失败时继续跑，成败分别计数", async () => {
  const h = makeDeps({ copyFailOn: [2] });
  const result = await createWindowsFromTemplate({
    templateId: 7,
    count: 3,
    namePrefix: "F3",
    deps: h.deps,
  });

  assert.equal(result.success_count, 2);
  assert.equal(result.failed_count, 1);
  assert.deepEqual(result.failed_names, ["F3_2"]);
  assert.ok(h.items.some(([k, s, m]) => k === "F3_2" && s === "失败" && m.includes("copy 炸了 #2")));
  assert.ok(h.logs.some((m) => m.includes("✗ 创建窗口失败（F3_2）")));
  assert.deepEqual(h.progress, [0, 1, 2, 3]);
});

test("createWindowsFromTemplate：取名失败也只算这一次失败，不影响后续", async () => {
  const h = makeDeps({ nextNameFailOn: [1] });
  const result = await createWindowsFromTemplate({
    templateId: 7,
    count: 2,
    namePrefix: "F3",
    deps: h.deps,
  });

  assert.equal(result.success_count, 1);
  assert.equal(result.failed_count, 1);
  const firstCreated = result.created[0];
  assert.ok(firstCreated);
  assert.equal(firstCreated.name, "F3_2");
  assert.deepEqual(h.items[0], ["F3", "失败", "列窗口失败"]);
});

test("createWindowsFromTemplate：停止后不再创建，也不给没跑的窗口补条目", async () => {
  const h = makeDeps({ stopAfter: 1 });
  const result = await createWindowsFromTemplate({
    templateId: 7,
    count: 3,
    namePrefix: "F3",
    deps: h.deps,
  });

  assert.equal(result.success_count, 1);
  assert.equal(result.total, 3);
  assert.equal(h.created.length, 1);
  assert.equal(h.items.length, 1);
  assert.ok(h.logs.some((m) => m.includes("剩余 2 个窗口未创建")));
});

// ==================== 参数校验 ====================

test("parseCreateSpec：合法入参；非法入参一律 INVALID_ARGUMENT", () => {
  assert.deepEqual(parseCreateSpec([{ templateId: 7, count: 2, namePrefix: "F3", groupId: 3 }]), {
    templateId: 7,
    count: 2,
    namePrefix: "F3",
    groupId: 3,
  });
  // 省略 / null 分组都表示沿用模板分组
  assert.equal(parseCreateSpec([{ templateId: 7, count: 1 }]).groupId, null);
  assert.equal(parseCreateSpec([{ templateId: 7, count: 1, groupId: null }]).groupId, null);

  /** @type {(args: unknown[]) => void} */
  const bad = (args) =>
    assert.throws(() => parseCreateSpec(args), (e) => /** @type {any} */ (e).code === ERROR_CODES.INVALID_ARGUMENT);
  bad([]); // 没有参数
  bad([null]);
  bad([[1, 2]]);
  bad([{ templateId: 0, count: 1 }]); // 模板 ID 必须是正整数
  bad([{ templateId: "7", count: 1 }]);
  bad([{ templateId: 7, count: 0 }]);
  bad([{ templateId: 7, count: MAX_CREATE_COUNT + 1 }]);
  bad([{ templateId: 7, count: 1.5 }]);
  bad([{ templateId: 7, count: 1, namePrefix: 123 }]);
  bad([{ templateId: 7, count: 1, namePrefix: "x".repeat(101) }]);
  bad([{ templateId: 7, count: 1, groupId: -1 }]);
  bad([{ templateId: 7, count: 1, groupId: "3" }]);
});

// ==================== handler 端到端 ====================

/**
 * 假 ixBrowser：只实现创建窗口这条路用到的接口
 * @param {{ windows?: any[], template?: any }} [opts]
 */
function fakeIx({ windows = [], template = { profile_id: 7, name: "模板A", group_id: 1 } } = {}) {
  /** @type {any[][]} */
  const copies = [];
  const state = { windows: [...windows], copies, nextId: 900 };
  return {
    state,
    async getProfileList() {
      return state.windows;
    },
    async getProfileInfo(id) {
      return template && id === template.profile_id ? { ...template } : null;
    },
    async copyProfile(id, fields) {
      state.copies.push([id, fields]);
      const profile_id = state.nextId++;
      state.windows.push({ profile_id, name: fields.name, group_id: fields.groupId ?? template.group_id });
      return profile_id;
    },
    async getGroupList() {
      return [];
    },
  };
}

function setup(ix) {
  const dir = mkdtempSync(join(tmpdir(), "abb-home-create-"));
  const events = [];
  const waiters = [];
  const ctx = createHostContext({
    dataRoot: dir,
    emit: (channel, payload) => {
      events.push([channel, payload]);
      if (channel === IPC.event.taskFinished) waiters.shift()?.(payload);
    },
    ixClient: ix,
    log: () => {},
  });
  const dispatch = createDispatcher(createHomeHandlers(ctx));
  return {
    ctx,
    events,
    nextFinished: () => new Promise((r) => waiters.push(r)),
    /**
     * @param {string} channel
     * @param {...any} args
     * @returns {Promise<any>}
     */
    call: async (channel, ...args) => {
      const env = await dispatch(channel, args);
      if (!env.ok) {
        /** @type {any} */
        const e = new Error(env.error.message);
        e.code = env.error.code;
        throw e;
      }
      return env.data;
    },
    dispatch,
  };
}

test("handler：模板窗口不存在时直接拒绝，不启动任务", async () => {
  const ix = fakeIx();
  const s = setup(ix);
  const env = await s.dispatch(HOME_INVOKE.homeCreateBrowsers, [{ templateId: 999, count: 1, namePrefix: "" }]);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, ERROR_CODES.INVALID_ARGUMENT);
  assert.match(env.error.message, /模板窗口不存在: 999/);
  assert.equal(ix.state.copies.length, 0);
  assert.equal(s.ctx.tasks.busy, false, "拒绝时不应留下运行中的任务");
});

test("handler：已有的「前缀_1」会被跳过，新窗口接着编号（端到端）", async () => {
  const ix = fakeIx({ windows: [{ profile_id: 1, name: "F3T_1" }] });
  const s = setup(ix);

  const pre = await s.call(HOME_INVOKE.homeCreateBrowsers, {
    templateId: 7,
    count: 2,
    namePrefix: "F3T",
    groupId: 5,
  });
  assert.equal(pre.type, HOME_TASK_TYPES.create);
  assert.equal(pre.label, "按模板创建 2 个窗口");

  const done = await s.nextFinished();
  assert.equal(done.outcome, "succeeded");
  assert.deepEqual(done.result, {
    total: 2,
    success_count: 2,
    failed_count: 0,
    created: [
      { profile_id: 900, name: "F3T_2" },
      { profile_id: 901, name: "F3T_3" },
    ],
    failed_names: [],
  });
  assert.deepEqual(ix.state.copies, [
    [7, { name: "F3T_2", groupId: 5 }],
    [7, { name: "F3T_3", groupId: 5 }],
  ]);
  // 逐条目进任务历史（key 用窗口名，消息带新窗口 ID）
  assert.deepEqual(
    s.events.filter(([c]) => c === IPC.event.taskItem).map(([, p]) => [p.key, p.status, p.message]),
    [
      ["F3T_2", "成功", "新窗口 ID: 900"],
      ["F3T_3", "成功", "新窗口 ID: 901"],
    ],
  );
  // 新窗口真的进了窗口列表（界面上刷新就能看到）
  const list = await s.call(HOME_INVOKE.homeListBrowsers);
  const names = list.browsers.map((b) => b.name);
  assert.ok(names.includes("F3T_2") && names.includes("F3T_3"), `列表里应有新窗口，实际=${names}`);
});

test("handler：前缀为空时用模板窗口名命名", async () => {
  const ix = fakeIx({ template: { profile_id: 7, name: "模板A", group_id: 1 } });
  const s = setup(ix);

  await s.call(HOME_INVOKE.homeCreateBrowsers, { templateId: 7, count: 1, namePrefix: "   " });
  const done = await s.nextFinished();
  assert.deepEqual(
    done.result.created.map((c) => c.name),
    ["模板A_1"],
  );
});
