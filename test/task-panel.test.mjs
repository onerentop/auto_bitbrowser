/**
 * 账号页「任务」面板的纯逻辑（app/shared/logic/task-panel.ts）
 *
 * 面板把「选中账号 → 执行任务」收敛成一个抽屉，这张任务表是唯一的真相：
 * 顺序、分组、名称、说明、需不需要窗口 ID、是否破坏性。界面只按表渲染。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_PANEL_TASKS,
  TASK_PANEL_GROUPS,
  aiItemsFromAccounts,
  aiParamsFor,
  countResults,
  isTaskPanelId,
  taskPanelDef,
  taskSummaryText,
  upsertResult,
} from "../app/shared/logic/task-panel.ts";
import { AI_TASK_KINDS } from "../app/shared/channels/ai-tasks.ts";

/** @param {Partial<{email: string, browser_profile_id: string}>} over */
const row = (over = {}) => ({ email: "a@x.com", browser_profile_id: "12", ...over });

test("任务表：账号动作 4 个 + 6 个 AI 任务，id 不重复", () => {
  const ids = TASK_PANEL_TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "任务 id 重复");
  assert.deepEqual(
    TASK_PANEL_TASKS.filter((t) => t.runner === "account").map((t) => t.id),
    ["login", "health_check", "delete", "delete_with_windows"],
  );
  assert.deepEqual(
    TASK_PANEL_TASKS.filter((t) => t.runner === "ai").map((t) => t.id),
    ["replace_phone", "replace_email", "modify_2sv", "modify_auth", "kick_devices", "change_password"],
  );
});

test("任务表：AI 任务的名称 / 额外输入与 AI_TASK_KINDS 一致，说明非空", () => {
  for (const t of TASK_PANEL_TASKS) {
    assert.ok(t.label.trim() !== "" && t.description.trim() !== "", `${t.id} 缺少名称或说明`);
    if (t.runner !== "ai") {
      assert.equal(t.extraField, null, `${t.id} 是账号动作，不该有额外输入`);
      continue;
    }
    const def = AI_TASK_KINDS[t.id];
    assert.equal(t.label, def.taskName, `${t.id} 名称与 AI_TASK_KINDS 不一致`);
    assert.deepEqual(t.extraField, def.extraField, `${t.id} 额外输入与 AI_TASK_KINDS 不一致`);
  }
});

test("任务表：分组覆盖全部任务且不重复（界面按分组渲染）", () => {
  const inGroups = TASK_PANEL_GROUPS.flatMap((g) => g.ids);
  assert.deepEqual([...inGroups].sort(), TASK_PANEL_TASKS.map((t) => t.id).sort());
  assert.equal(new Set(inGroups).size, inGroups.length, "同一个任务出现在多个分组");
  for (const g of TASK_PANEL_GROUPS) assert.ok(g.title.trim() !== "", "分组要有标题");
});

test("删除类任务标记为破坏性，登录 / 巡检不是", () => {
  assert.equal(taskPanelDef("delete").danger, true);
  assert.equal(taskPanelDef("delete_with_windows").danger, true);
  assert.equal(taskPanelDef("login").danger, false);
  assert.equal(taskPanelDef("health_check").danger, false);
  // 修改密码会换掉账号密码，也属于破坏性
  assert.equal(taskPanelDef("change_password").danger, true);
  assert.equal(taskPanelDef("kick_devices").danger, false);
});

test("taskPanelDef 查到的是同一份定义（不是副本）", () => {
  const t = TASK_PANEL_TASKS.find((x) => x.id === "replace_phone");
  assert.equal(taskPanelDef("replace_phone"), t);
});

test("isTaskPanelId 只认表里的 id", () => {
  assert.equal(isTaskPanelId("login"), true);
  assert.equal(isTaskPanelId("modify_auth"), true);
  assert.equal(isTaskPanelId("delete_one_with_window"), false);
  assert.equal(isTaskPanelId(""), false);
  assert.equal(isTaskPanelId(null), false);
});

test("aiItemsFromAccounts：按列表顺序取窗口 ID，绑定字段非法 / 为空的行跳过并计数", () => {
  const rows = [
    row({ email: "a@x.com", browser_profile_id: "12" }),
    row({ email: "b@x.com", browser_profile_id: "" }),
    row({ email: "c@x.com", browser_profile_id: "-" }),
    row({ email: "d@x.com", browser_profile_id: "0" }),
    row({ email: "e@x.com", browser_profile_id: "abc" }),
    row({ email: "f@x.com", browser_profile_id: " 34 " }),
  ];
  const r = aiItemsFromAccounts(rows);
  assert.deepEqual(r.items, [
    { email: "a@x.com", profileId: 12 },
    { email: "f@x.com", profileId: 34 },
  ]);
  assert.equal(r.skipped, 4, "四个没有有效窗口 ID 的账号要计数");
});

test("aiItemsFromAccounts：空数组 / 重复邮箱 → 空结果 / 去重保序", () => {
  assert.deepEqual(aiItemsFromAccounts([]), { items: [], skipped: 0 });
  const r = aiItemsFromAccounts([
    row({ email: "a@x.com", browser_profile_id: "12" }),
    row({ email: "a@x.com", browser_profile_id: "12" }),
    row({ email: "a@x.com", browser_profile_id: "13" }),
  ]);
  assert.deepEqual(r.items, [
    { email: "a@x.com", profileId: 12 },
    { email: "a@x.com", profileId: 13 },
  ]);
  assert.equal(r.skipped, 0);
});

test("aiItemsFromAccounts：超长数字（不是安全整数）按无效处理，不静默截断", () => {
  const r = aiItemsFromAccounts([row({ browser_profile_id: "99999999999999999999" })]);
  assert.deepEqual(r.items, []);
  assert.equal(r.skipped, 1);
});

test("aiParamsFor：只有带额外输入的任务产出参数，值去首尾空白（留空即空串）", () => {
  assert.deepEqual(aiParamsFor(taskPanelDef("replace_phone"), " 13800138000 "), { newPhone: "13800138000" });
  assert.deepEqual(aiParamsFor(taskPanelDef("replace_email"), "a@x.com"), { newEmail: "a@x.com" });
  assert.deepEqual(aiParamsFor(taskPanelDef("replace_email"), "   "), { newEmail: "" });
  assert.deepEqual(aiParamsFor(taskPanelDef("kick_devices"), "随便写"), {});
  assert.deepEqual(aiParamsFor(taskPanelDef("login"), "随便写"), {});
});

test("upsertResult：按条目键累加，内容没变时返回同一个对象（避免多余重渲染）", () => {
  const e = { key: "a@x.com", status: "处理中", message: "正在替换手机号..." };
  const one = upsertResult({}, e);
  assert.deepEqual(one, { "a@x.com": { email: "a@x.com", status: "处理中", message: "正在替换手机号..." } });
  assert.equal(upsertResult(one, e), one, "同样的状态不该产生新对象");

  const two = upsertResult(one, { key: "a@x.com", status: "成功", message: "已替换" });
  const after = two["a@x.com"];
  assert.ok(after, "结果里应有这一行");
  assert.equal(after.status, "成功");
  assert.equal(after.message, "已替换");
  const before = one["a@x.com"];
  assert.ok(before, "上一轮结果里应有这一行");
  assert.equal(before.status, "处理中", "不能就地改旧对象");
});

test("countResults：成功 / 失败 / 未完成三个口径，未完成不为负", () => {
  const results = {
    "a@x.com": { email: "a@x.com", status: "成功", message: "" },
    "b@x.com": { email: "b@x.com", status: "失败", message: "" },
    "c@x.com": { email: "c@x.com", status: "错误", message: "" },
    "d@x.com": { email: "d@x.com", status: "处理中", message: "" },
  };
  assert.deepEqual(countResults(results, 6), { total: 6, ok: 1, failed: 2, unfinished: 3 });
  // 条目数比总数多（重复事件）时未完成按 0 计，不出现负数
  assert.deepEqual(countResults(results, 1), { total: 1, ok: 1, failed: 2, unfinished: 0 });
});

test("taskSummaryText：三种文案（未开始 / 进行中 / 全完成）", () => {
  assert.equal(taskSummaryText({ total: 0, ok: 0, failed: 0, unfinished: 0 }), "还没有执行任务");
  assert.equal(
    taskSummaryText({ total: 12, ok: 9, failed: 2, unfinished: 1 }),
    "本次共 12 个账号：成功 9 · 失败 2 · 未完成 1",
  );
  assert.equal(taskSummaryText({ total: 3, ok: 3, failed: 0, unfinished: 0 }), "本次共 3 个账号：成功 3");
});
