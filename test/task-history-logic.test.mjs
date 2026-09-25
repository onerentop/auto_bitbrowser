/**
 * 任务历史面板的纯逻辑（app/shared/logic/task-history.ts）
 *
 * 重点是「能不能重跑」的判定必须与后端 abb/taskhistory/rerun 一致：
 * 界面禁用按钮的理由，不能和后端拒绝的理由不一样。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RERUNNABLE_ACCOUNT_ACTIONS,
  TASK_HISTORY_OUTCOMES,
  TASK_HISTORY_RANGES,
  formatLocalStamp,
  parseRunSnapshot,
  rangeBounds,
  rerunBlockReason,
  taskTypeLabel,
  taskTypeOptions,
} from "../app/shared/logic/task-history.ts";

/** @param {Record<string, unknown>} snapshot */
const snapshot = (snapshot) => JSON.stringify(snapshot);
/** @param {{params?: string | null, task_type?: string}} over */
const run = (over = {}) => ({ params: null, task_type: "login", ...over });

test("可重跑：AI 任务看快照里的 kind", () => {
  assert.equal(rerunBlockReason(run({ params: snapshot({ kind: "replace_phone", items: [], params: {} }), task_type: "ai_replace_phone" })), null);
  assert.equal(rerunBlockReason(run({ params: snapshot({ kind: "change_password", items: [] }), task_type: "ai_change_password" })), null);
});

test("可重跑：账号批量任务只认 login / health_check / batch_delete", () => {
  assert.deepEqual([...RERUNNABLE_ACCOUNT_ACTIONS].sort(), ["batch_delete", "health_check", "login"]);
  for (const action of RERUNNABLE_ACCOUNT_ACTIONS) {
    assert.equal(rerunBlockReason(run({ params: snapshot({ action, rows: [] }), task_type: "login" })), null, action);
  }
});

test("不可重跑：没有快照 / 快照坏掉 / 类型不支持，都给得出给人看的原因", () => {
  /** 取原因文本（取不到就让 assert 直接失败，而不是拿 null 去 match） */
  const reasonOf = (row) => {
    const reason = rerunBlockReason(row);
    assert.ok(reason !== null, "这条记录应该不可重跑并给出原因");
    return reason;
  };
  assert.match(reasonOf(run({ params: null })), /没有参数快照/);
  assert.match(reasonOf(run({ params: "{不是 JSON" })), /没有参数快照/);
  assert.match(reasonOf(run({ params: snapshot({ action: "delete_one_with_window" }), task_type: "batch_delete" })), /不支持重跑/);
  assert.match(reasonOf(run({ params: snapshot({ kind: "unknown_kind" }), task_type: "ai_x" })), /不支持重跑/);
  assert.match(reasonOf(run({ params: snapshot({}), task_type: "window_open" })), /window_open/);
});

test("parseRunSnapshot：缺失 / 空串 / 数组 / 非对象一律 null", () => {
  assert.equal(parseRunSnapshot(null), null);
  assert.equal(parseRunSnapshot(""), null);
  assert.equal(parseRunSnapshot("[1,2]"), null);
  assert.equal(parseRunSnapshot("123"), null);
  assert.equal(parseRunSnapshot('"文字"'), null);
  assert.deepEqual(parseRunSnapshot('{"action":"login"}'), { action: "login" });
});

test("任务类型名：AI 任务取 AI_TASK_KINDS，其余本表登记，未登记的原样返回", () => {
  assert.equal(taskTypeLabel("ai_replace_phone"), "替换手机号");
  assert.equal(taskTypeLabel("health_check"), "健康巡检");
  assert.equal(taskTypeLabel("totp_import"), "导入 TOTP 密钥");
  assert.equal(taskTypeLabel("something_new"), "something_new");
});

test("类型筛选项：按出现过的类型去重、用中文名、按名称排序", () => {
  const options = taskTypeOptions([
    { task_type: "login" },
    { task_type: "ai_replace_phone" },
    { task_type: "login" },
    { task_type: "something_new" },
  ]);
  assert.deepEqual(
    options.map((o) => o.value).sort(),
    ["ai_replace_phone", "login", "something_new"],
  );
  const loginOption = options.find((o) => o.value === "login");
  assert.ok(loginOption, "类型下拉里应有 login");
  assert.equal(loginOption.label, "批量登录");
  assert.equal(taskTypeOptions([]).length, 0);
});

test("结果筛选项：三项固定文案", () => {
  assert.deepEqual(TASK_HISTORY_OUTCOMES, [
    { value: "succeeded", label: "成功" },
    { value: "failed", label: "失败" },
    { value: "stopped", label: "已停止" },
  ]);
});

test("formatLocalStamp：补零到秒（与库里的本地时间串同格式）", () => {
  assert.equal(formatLocalStamp(new Date(2026, 8, 6, 7, 8, 9)), "2026-09-06 07:08:09");
});

test("快捷时间范围：全部不带上下限；今天从今天 0 点起；7 天含今天共 7 天", () => {
  const now = new Date(2026, 8, 26, 14, 30, 5);
  assert.deepEqual(rangeBounds("all", now), {});
  assert.deepEqual(rangeBounds("today", now), { from: "2026-09-26 00:00:00", to: "2026-09-26 14:30:05" });
  assert.deepEqual(rangeBounds("7d", now), { from: "2026-09-20 00:00:00", to: "2026-09-26 14:30:05" });
  assert.deepEqual(rangeBounds("30d", now), { from: "2026-08-28 00:00:00", to: "2026-09-26 14:30:05" });
});

test("快捷时间范围：跨月的那一天算得对（30 天前是上个月）", () => {
  const now = new Date(2026, 0, 3, 9, 0, 0); // 2026-01-03
  assert.deepEqual(rangeBounds("7d", now), { from: "2025-12-28 00:00:00", to: "2026-01-03 09:00:00" });
});

test("范围选项文案齐全（界面按它渲染）", () => {
  assert.deepEqual(TASK_HISTORY_RANGES.map((r) => r.value), ["all", "today", "7d", "30d"]);
});
