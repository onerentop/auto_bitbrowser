/**
 * AI 任务页平铺账号列表的纯函数（app/shared/logic/ai-task-list.ts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  filterRows,
  isFailedRuntime,
  isSelectable,
  loginStatusLabel,
  rowSorter,
  selectedItems,
  statusTone,
} from "../app/shared/logic/ai-task-list.ts";

/** @returns {import("../app/shared/channels/ai-tasks.ts").AiTaskRow} */
function row(o) {
  return {
    key: `b:${o.profileId ?? "x"}`,
    profileId: null,
    email: "",
    groupId: 0,
    groupName: "未分组",
    inDb: true,
    hasRecoveryEmail: false,
    hasSecret: false,
    loginStatus: "logged_in",
    lastLoginAt: null,
    ...o,
  };
}

const ROWS = [
  row({ profileId: 101, email: "Alice@X.com", groupId: 1, lastLoginAt: "2026-09-23 16:14:36" }),
  row({ profileId: 102, email: "bob@x.com", groupId: 1, loginStatus: "login_failed", lastLoginAt: "2026-09-20 08:00:00" }),
  row({ profileId: 203, email: "carol@x.com", groupId: 2, loginStatus: "" }),
  row({ profileId: 1010, email: "dave@x.com", groupId: 2, inDb: false, loginStatus: "" }),
  row({ key: "b:2:4", profileId: null, email: "noid@x.com", groupId: 2 }),
];
const ids = (list) => list.map((r) => r.profileId);
const q = (o) => ({ groupId: null, login: "all", failedOnly: false, text: "", ...o });

test("filterRows：分组 / 账号状态 / 搜索（邮箱包含、窗口ID 前缀）叠加；无条件原样返回", () => {
  assert.equal(filterRows(ROWS, q({}), {}), ROWS);
  assert.deepEqual(ids(filterRows(ROWS, q({ groupId: 2 }), {})), [203, 1010, null]);
  assert.deepEqual(ids(filterRows(ROWS, q({ login: "logged_in" }), {})), [101, null]);
  assert.deepEqual(ids(filterRows(ROWS, q({ login: "login_failed" }), {})), [102]);
  assert.deepEqual(ids(filterRows(ROWS, q({ login: "other" }), {})), [203], "在库但登录状态为空");
  assert.deepEqual(ids(filterRows(ROWS, q({ login: "not_in_db" }), {})), [1010]);
  assert.deepEqual(ids(filterRows(ROWS, q({ text: "  ALICE " }), {})), [101], "不区分大小写");
  assert.deepEqual(ids(filterRows(ROWS, q({ text: "101" }), {})), [101, 1010], "窗口ID 前缀");
  assert.deepEqual(ids(filterRows(ROWS, q({ groupId: 2, text: "101" }), {})), [1010], "叠加");
});

test("filterRows：只看本次失败 = 本次结果为 失败 / 错误 的行（按 email 取结果）", () => {
  const runtime = {
    "Alice@X.com": { status: "成功", message: "" },
    "bob@x.com": { status: "失败", message: "x" },
    "carol@x.com": { status: "错误", message: "y" },
    "dave@x.com": { status: "处理中", message: "" },
  };
  assert.deepEqual(ids(filterRows(ROWS, q({ failedOnly: true }), runtime)), [102, 203]);
  assert.deepEqual(ids(filterRows(ROWS, q({ failedOnly: true }), {})), [], "没跑过任务时为空");
  assert.equal(isFailedRuntime(undefined), false);
});

test("rowSorter：模拟 antd（降序时把结果取反），空值无论升降序都在最后", () => {
  const antd = (key, order) =>
    [...ROWS]
      .sort((x, y) => {
        const r = rowSorter(key)(x, y, order);
        return order === "descend" ? -r : r;
      })
      .map((r) => r.email);
  assert.deepEqual(antd("profileId", "descend"), ["dave@x.com", "carol@x.com", "bob@x.com", "Alice@X.com", "noid@x.com"]);
  assert.deepEqual(antd("profileId", "ascend"), ["Alice@X.com", "bob@x.com", "carol@x.com", "dave@x.com", "noid@x.com"]);
  assert.deepEqual(antd("lastLoginAt", "descend").slice(0, 2), ["Alice@X.com", "bob@x.com"]);
  assert.deepEqual(antd("lastLoginAt", "ascend").slice(0, 2), ["bob@x.com", "Alice@X.com"]);
  assert.deepEqual(antd("email", "ascend"), ["Alice@X.com", "bob@x.com", "carol@x.com", "dave@x.com", "noid@x.com"]);
});

test("selectedItems：含被隐藏的勾选；无窗口 ID / 空邮箱不可选", () => {
  assert.equal(isSelectable({ profileId: null, email: "a" }), false);
  assert.equal(isSelectable({ profileId: 1, email: "  " }), false);
  assert.deepEqual(selectedItems(ROWS, ["b:203", "b:101", "b:2:4", "b:999"]), [
    { email: "Alice@X.com", profileId: 101 },
    { email: "carol@x.com", profileId: 203 },
  ]);
});

test("loginStatusLabel / statusTone", () => {
  assert.equal(loginStatusLabel({ inDb: false, loginStatus: "" }), "不在数据库");
  assert.equal(loginStatusLabel({ inDb: true, loginStatus: "logged_in" }), "已登录");
  assert.equal(loginStatusLabel({ inDb: true, loginStatus: "login_failed" }), "登录失败");
  assert.equal(loginStatusLabel({ inDb: true, loginStatus: "not_logged" }), "未登录");
  assert.equal(loginStatusLabel({ inDb: true, loginStatus: "" }), "未知");
  assert.equal(statusTone("成功"), "success");
  assert.equal(statusTone("错误"), "error");
  assert.equal(statusTone("处理中"), "warning");
});
