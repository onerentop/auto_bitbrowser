/**
 * 一体列表（窗口视角）的共享纯函数（app/shared/logic/unified-list.ts）
 *
 * 窗口行用 buildBrowserList 真实构造，避免手写行形状与生产不一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildBrowserList } from "../app/shared/logic/home-list.ts";
import {
  attachBoundEmails,
  filterUnifiedWindows,
  windowViewSummary,
  windowViewSummaryText,
} from "../app/shared/logic/unified-list.ts";

/**
 * 取数组第 index 项并断言存在（noUncheckedIndexedAccess 下把下标访问收窄成非空）
 * @template T
 * @param {readonly T[]} list
 * @param {number} index
 * @returns {T}
 */
function at(list, index) {
  const value = list[index];
  assert.ok(value !== undefined, `下标越界: ${index}`);
  return value;
}

const GROUPS = [{ id: 2, title: "组A" }];
const BROWSERS = [
  { profile_id: 11, name: "win-a", note: "n1", group_id: 2 },
  { profile_id: 12, name: "win-b", note: "", group_id: 2 },
  { profile_id: 13, name: "win-c", note: "", group_id: 0 },
  { name: "无ID窗口", note: "" },
];
const ACCOUNTS = [
  { email: "alice@x.com", browser_profile_id: "11" },
  { email: "bob@x.com", browser_profile_id: "12" },
  { email: "empty@x.com", browser_profile_id: "" },
  { email: "zero@x.com", browser_profile_id: "0" },
  { email: "null@x.com", browser_profile_id: null },
  { email: "notnum@x.com", browser_profile_id: "abc" },
];

function rows() {
  return attachBoundEmails(buildBrowserList(GROUPS, BROWSERS).browsers, ACCOUNTS);
}

test("attachBoundEmails：把绑定账号贴到窗口行上；空 / 0 / 非数字 / null 一律视为未绑定", () => {
  const list = rows();
  assert.deepEqual(
    list.map((r) => [r.profileId, r.boundEmail]),
    [
      [11, "alice@x.com"],
      [12, "bob@x.com"],
      [13, null],
      [null, null],
    ],
  );
  // 窗口自身的字段原样保留（不是重新造行）
  assert.equal(at(list, 0).name, "win-a");
  assert.equal(at(list, 0).groupId, 2);
  assert.equal(at(list, 0).groupName, "组A");
});

test("attachBoundEmails：同一窗口被多个账号绑定时取先出现的那个", () => {
  const list = attachBoundEmails(buildBrowserList(GROUPS, BROWSERS).browsers, [
    { email: "first@x.com", browser_profile_id: "11" },
    { email: "second@x.com", browser_profile_id: "11" },
  ]);
  assert.equal(at(list, 0).boundEmail, "first@x.com");
});

test("filterUnifiedWindows：没有任何条件时原样返回同一个数组", () => {
  const list = rows();
  const same = filterUnifiedWindows(list, { groupId: null, text: "", onlyUnbound: false });
  assert.equal(same, list, "无筛选应原样返回（渲染层据此少做一次复制）");
});

test("filterUnifiedWindows：搜索词命中「绑定账号」（这是合并后新增的维度）", () => {
  const list = rows();
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: null, text: "alice", onlyUnbound: false }).map((r) => r.profileId),
    [11],
  );
  // 不区分大小写 + 部分匹配
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: null, text: "ALICE@X", onlyUnbound: false }).map((r) => r.profileId),
    [11],
  );
  // 原来就支持的维度不受影响：名称 / 备注 / 窗口ID 前缀
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: null, text: "win-b", onlyUnbound: false }).map((r) => r.profileId),
    [12],
  );
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: null, text: "n1", onlyUnbound: false }).map((r) => r.profileId),
    [11],
  );
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: null, text: "13", onlyUnbound: false }).map((r) => r.profileId),
    [13],
  );
  assert.deepEqual(filterUnifiedWindows(list, { groupId: null, text: "没人", onlyUnbound: false }), []);
});

test("filterUnifiedWindows：只看未绑定 / 分组 + 未绑定叠加", () => {
  const list = rows();
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: null, text: "", onlyUnbound: true }).map((r) => r.profileId),
    [13, null],
    "未绑定的两个：有 ID 的 13 与没有 ID 的那行",
  );
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: 2, text: "", onlyUnbound: true }).map((r) => r.profileId),
    [],
    "组A 里的两个窗口都已绑定",
  );
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: 2, text: "", onlyUnbound: false }).map((r) => r.profileId),
    [11, 12],
  );
  assert.deepEqual(
    filterUnifiedWindows(list, { groupId: 0, text: "", onlyUnbound: true }).map((r) => r.profileId),
    [13, null],
    "未分组 + 未绑定",
  );
});

test("filterUnifiedWindows：搜到已绑定账号的行，也不会漏掉 onlyUnbound 的约束", () => {
  const list = rows();
  // alice 已绑定；同时要求 onlyUnbound 时应返回空（两个条件必须同时成立）
  assert.deepEqual(filterUnifiedWindows(list, { groupId: null, text: "alice", onlyUnbound: true }), []);
});

test("windowViewSummary / windowViewSummaryText：计数与文案", () => {
  const list = rows();
  assert.deepEqual(windowViewSummary(list), { total: 4, unbound: 2 });
  assert.equal(windowViewSummaryText(list), "共 4 个窗口（2 个未绑定账号）");
  assert.equal(windowViewSummaryText(list.slice(0, 2)), "共 2 个窗口", "未绑定为 0 时不啰嗦");
  assert.deepEqual(windowViewSummary([]), { total: 0, unbound: 0 });
});
