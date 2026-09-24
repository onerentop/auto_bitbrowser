/**
 * 首页平铺窗口列表的纯函数（app/shared/logic/home-list.ts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBrowserList,
  compareBrowsers,
  filterBrowsers,
  formatOpenTime,
  reconcileChecked,
  refreshSummary,
  selectedProfileIds,
  selectionSummary,
  tableSorter,
} from "../app/shared/logic/home-list.ts";

const GROUPS = [
  { id: 2, title: "列表名" },
  { id: 9, title: "空分组" },
  { id: 0, title: "不会用到" },
];
const BROWSERS = [
  { profile_id: 11, name: "a@x.com", note: "N1", group_id: 2, group_name: "窗口里的名字", last_open_time: 1_700_000_000, tfa_secret: "JBSWY3DPEHPK3PXP" },
  { profile_id: 12, name: "b@x.com", note: "", group_id: 3, group_name: "来自窗口", last_open_time: 0, tfa_secret: "  " },
  { profile_id: 13, name: "c@x.com", note: "", group_id: 0 },
  { profile_id: 14, name: "d@x.com", note: "" },
  { profile_id: 15, name: "e@x.com", note: "", group_id: 4, group_name: "\ufffd" },
];

test("buildBrowserList：平铺窗口 + 分组统计；分组名优先 group-list；gid=0/缺失归「未分组」；空分组不出现", () => {
  const list = buildBrowserList(GROUPS, BROWSERS);
  assert.equal(list.totalBrowsers, 5);
  assert.deepEqual(list.browsers.map((b) => [b.profileId, b.groupId, b.groupName]), [
    [11, 2, "列表名"],
    [12, 3, "来自窗口"],
    [13, 0, "未分组"],
    [14, 0, "未分组"],
    [15, 4, "分组 4"],
  ]);
  // 分组统计按 gid 升序，数量为 0 的分组（id=9）不出现
  assert.deepEqual(list.groups, [
    { groupId: 0, groupName: "未分组", count: 2 },
    { groupId: 2, groupName: "列表名", count: 1 },
    { groupId: 3, groupName: "来自窗口", count: 1 },
    { groupId: 4, groupName: "分组 4", count: 1 },
  ]);
  const a = list.browsers[0];
  assert.ok(a);
  assert.equal(a.name, "a@x.com");
  assert.equal(a.note, "N1");
  assert.equal(a.lastOpenTime, 1_700_000_000);
  assert.equal(a.hasTfa, true);
  const b = list.browsers[1];
  assert.ok(b);
  assert.equal(b.lastOpenTime, null, "0 表示从未打开");
  assert.equal(b.hasTfa, false, "只有空白的密钥视为没有");
  assert.equal(refreshSummary(list), "列表刷新完成，共 4 个分组，5 个窗口");
});

test("buildBrowserList：结果里绝不包含 tfa_secret 原文", () => {
  const json = JSON.stringify(buildBrowserList(GROUPS, BROWSERS));
  assert.ok(!json.includes("JBSWY3DPEHPK3PXP"));
  assert.ok(!json.includes("tfa_secret"));
});

test("buildBrowserList：key 规则 b:{id}；重复 / 无效 id 退回序号 key，且全局唯一；无数据时为空", () => {
  const list = buildBrowserList([], [
    { profile_id: 5, name: "x" },
    { profile_id: 5, name: "dup" },
    { profile_id: "abc", name: "bad" },
    { profile_id: "6", name: "str" },
  ]);
  assert.deepEqual(list.browsers.map((b) => b.profileId), [5, 5, null, 6]);
  const keys = list.browsers.map((b) => b.key);
  assert.equal(keys[0], "b:5");
  assert.equal(keys[3], "b:6");
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(buildBrowserList([], []), { browsers: [], groups: [], totalBrowsers: 0 });
});

function sample() {
  return buildBrowserList(
    [{ id: 1, title: "默认" }, { id: 2, title: "二组" }],
    [
      { profile_id: 101, name: "Alice@X.com", note: "", group_id: 1 },
      { profile_id: 102, name: "bob", note: "VIP 客户", group_id: 1 },
      { profile_id: 203, name: "carol", note: "", group_id: 2 },
      { profile_id: 1010, name: "dave", note: "", group_id: 2, group_name: "alice" },
    ],
  ).browsers;
}

test("filterBrowsers：按窗口ID前缀 / 名称 / 备注搜索（不区分大小写、去空白），与分组筛选叠加", () => {
  const all = sample();
  const ids = (list) => list.map((b) => b.profileId);
  assert.deepEqual(ids(filterBrowsers(all, { groupId: null, text: "  ALICE " })), [101], "分组名不参与搜索");
  assert.deepEqual(ids(filterBrowsers(all, { groupId: null, text: "vip" })), [102]);
  assert.deepEqual(ids(filterBrowsers(all, { groupId: null, text: "101" })), [101, 1010], "ID 前缀");
  assert.deepEqual(ids(filterBrowsers(all, { groupId: 2, text: "" })), [203, 1010]);
  assert.deepEqual(ids(filterBrowsers(all, { groupId: 2, text: "101" })), [1010], "分组 + 搜索叠加");
  assert.deepEqual(ids(filterBrowsers(all, { groupId: null, text: "zzz" })), []);
  assert.equal(filterBrowsers(all, { groupId: null, text: "   " }), all, "无条件时原样返回（不复制）");
});

test("compareBrowsers：按 ID / 名称 / 最近打开排序；空的最近打开时间永远排在最后", () => {
  const list = buildBrowserList([], [
    { profile_id: 3, name: "b", last_open_time: 100 },
    { profile_id: 1, name: "C", last_open_time: 0 },
    { profile_id: 2, name: "a", last_open_time: 300 },
  ]).browsers;
  const sorted = (key, order) =>
    [...list].sort((x, y) => compareBrowsers(key, x, y, order)).map((b) => b.profileId);
  assert.deepEqual(sorted("profileId", "ascend"), [1, 2, 3]);
  assert.deepEqual(sorted("name", "ascend"), [2, 3, 1], "不区分大小写");
  assert.deepEqual(sorted("lastOpenTime", "descend"), [2, 3, 1]);
  assert.deepEqual(sorted("lastOpenTime", "ascend"), [3, 2, 1]);
});

test("tableSorter：模拟 antd（降序时把比较结果取反），空值无论升降序都在最后", () => {
  const list = buildBrowserList([], [
    { profile_id: 3, name: "b", last_open_time: 100 },
    { profile_id: "x", name: "noid", last_open_time: 0 },
    { profile_id: 1, name: "C", last_open_time: 0 },
    { profile_id: 2, name: "a", last_open_time: 300 },
  ]).browsers;
  // antd useSorter：compareResult = sorter(a, b, order)；降序时返回 -compareResult
  const antd = (key, order) =>
    [...list]
      .sort((x, y) => {
        const r = tableSorter(key)(x, y, order);
        return order === "descend" ? -r : r;
      })
      .map((b) => b.name);
  assert.deepEqual(antd("profileId", "ascend"), ["C", "a", "b", "noid"]);
  assert.deepEqual(antd("profileId", "descend"), ["b", "a", "C", "noid"], "无 ID 的行降序也在最后");
  assert.deepEqual(antd("lastOpenTime", "descend"), ["a", "b", "noid", "C"], "从未打开的降序也在最后");
  assert.deepEqual(antd("lastOpenTime", "ascend"), ["b", "a", "noid", "C"]);
  assert.deepEqual(antd("name", "descend"), ["noid", "C", "b", "a"]);
});

test("reconcileChecked：刷新后去掉已不存在的窗口，其余保留", () => {
  const list = sample();
  assert.deepEqual(reconcileChecked(["b:101", "b:999", "b:203"], list), ["b:101", "b:203"]);
});

test("selectionSummary / selectedProfileIds：隐藏行的勾选也算数，并单独计数", () => {
  const all = sample();
  const visible = filterBrowsers(all, { groupId: 2, text: "" });
  const checked = ["b:101", "b:203"];
  assert.deepEqual(selectionSummary(checked, visible), { total: 2, hidden: 1 });
  assert.deepEqual(selectedProfileIds(all, checked), [101, 203]);
  assert.deepEqual(selectionSummary([], visible), { total: 0, hidden: 0 });
});

test("formatOpenTime：秒级时间戳 → 本地 YYYY-MM-DD HH:mm；空为 —", () => {
  assert.equal(formatOpenTime(null), "—");
  const d = new Date(2026, 8, 5, 7, 3);
  assert.equal(formatOpenTime(Math.floor(d.getTime() / 1000)), "2026-09-05 07:03");
});
