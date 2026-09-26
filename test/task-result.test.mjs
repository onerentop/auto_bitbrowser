/**
 * lib/task-result.ts 单测 —— 任务结束的「一句话摘要 + 色调 + 明细行」
 *
 * 这些断言的意图来自原先两组 finishedNotice 测试（已随 finished-notice.ts 删除迁到这里，
 * 见 test/app-accounts.test.mjs 的历史），并扩展到全部任务类型、停止与失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { taskResultView } from "../app/renderer/src/lib/task-result.ts";

/**
 * 造一个任务结束事件
 * @param {string} type
 * @param {unknown} result
 * @param {{ label?: string, outcome?: "succeeded" | "failed" | "stopped", error?: string | null }} [extra]
 */
function ev(type, result, extra = {}) {
  return {
    type,
    label: extra.label ?? "任务",
    outcome: extra.outcome ?? "succeeded",
    result,
    error: extra.error ?? null,
  };
}

// ==================== 删除类 ====================

test("批量删除（含窗口）：摘要说清账号与窗口数量", () => {
  const v = taskResultView(ev("batch_delete", { type: "batch_delete", result: { deleted_accounts: 2, deleted_windows: 1 } }, { label: "删除账号和窗口" }));
  assert.equal(v.summary, "已完成 · 已删除 2 个账号、1 个窗口");
  assert.equal(v.tone, "ok");
});

test("只删账号（删除选中）时不说窗口", () => {
  const v = taskResultView(ev("batch_delete", { type: "batch_delete", result: { deleted_accounts: 3, deleted_windows: 0 } }, { label: "删除选中" }));
  assert.equal(v.summary, "已完成 · 已删除 3 个账号");
});

// ==================== 巡检 ====================

test("巡检：四项计数逐项说清", () => {
  const v = taskResultView(
    ev("health_check", { ok: 5, need_login: 2, suspended: 1, window_error: 0 }, { label: "健康巡检" }),
  );
  assert.equal(v.summary, "已完成 · 正常 5 · 需登录 2 · 已停用 1 · 窗口异常 0");
  assert.equal(v.tone, "ok");
});

// ==================== 登录 ====================

test("批量登录：成功 / 失败 / 跳过", () => {
  const v = taskResultView(
    ev("login", { type: "login", result: { success_count: 3, failed_count: 0, skipped_count: 1 } }, { label: "批量登录" }),
  );
  assert.equal(v.summary, "已完成 · 成功 3 · 失败 0 · 跳过 1");
  assert.equal(v.tone, "ok");
});

test("成功但有条目失败 → warn 色（不用 bad：任务本身完成了）", () => {
  const v = taskResultView(
    ev("login", { type: "login", result: { success_count: 1, failed_count: 2, skipped_count: 0 } }, { label: "批量登录" }),
  );
  assert.equal(v.tone, "warn");
});

test("失败计数也认 failed_list / failed_ids 这类数组", () => {
  const v = taskResultView(ev("home_delete_browsers", { total: 3, success_count: 2, failed_count: 1 }, {}));
  assert.equal(v.tone, "warn");
  const w = taskResultView(ev("home_delete_browsers", { total: 2, success_count: 1, failed_ids: [7] }, {}));
  assert.equal(w.tone, "warn");
});

// ==================== 停止 / 失败 ====================

test("已停止：结论为已停止，用 none（muted）色", () => {
  const v = taskResultView(
    ev("login", { type: "login", result: { success_count: 0, failed_count: 1, skipped_count: 2 } }, { label: "批量登录", outcome: "stopped" }),
  );
  assert.equal(v.summary, "已停止 · 成功 0 · 失败 1 · 跳过 2");
  assert.equal(v.tone, "none");
});

/**
 * 真机 2026-09-26 回归：停止批量登录时，后端返回的是**骨架**而不是计数
 * （src/application/account-task-orchestrator.ts 的 createStoppedResult：
 * `{ type: "stopped", task_type: "login", message: "用户停止任务" }`，且它会丢掉
 * 批处理器已经算出的真实聚合值）。照 0 兜底就会在结果行里谎报「成功 0」，
 * 而同一次运行里其实成功过若干账号（test/app-accounts.test.mjs 的停止用例可证）。
 */
test("停止批量登录（真实骨架，无计数字段）：只说停止与原因，绝不谎报成功 0", () => {
  const v = taskResultView(
    ev("login", { type: "stopped", task_type: "login", message: "用户停止任务" }, { label: "批量登录", outcome: "stopped" }),
  );
  assert.equal(v.summary, "已停止 · 用户停止任务");
  assert.doesNotMatch(v.summary, /成功 0/, "没有计数字段时不能印 0");
  assert.equal(v.tone, "none");
});

test("停止骨架的明细：丢掉内部标识，保留说明", () => {
  const v = taskResultView(
    ev("login", { type: "stopped", task_type: "login", message: "用户停止任务" }, { label: "批量登录", outcome: "stopped" }),
  );
  assert.deepEqual(v.details, [["说明", "用户停止任务"]]);
});

test("删除任务拿到空结果（没有 deleted_accounts）时，不印「已删除 0 个账号」", () => {
  const v = taskResultView(ev("batch_delete", { type: "stopped", task_type: "batch_delete", message: "用户停止任务" }, { label: "删除账号和窗口", outcome: "stopped" }));
  assert.equal(v.summary, "已停止 · 用户停止任务");
  assert.doesNotMatch(v.summary, /已删除 0/);
});

test("计数为 0 与字段缺失要能区分：真的 0 照常显示", () => {
  const v = taskResultView(ev("login", { type: "login", result: { success_count: 0, failed_count: 0, skipped_count: 0 } }, { label: "批量登录" }));
  assert.equal(v.summary, "已完成 · 成功 0 · 失败 0 · 跳过 0");
});

test("失败：优先说错误原因，bad 色", () => {
  const v = taskResultView(ev("batch_delete", {}, { label: "删除账号和窗口", outcome: "failed", error: "后端连接中断" }));
  assert.equal(v.summary, "失败 · 后端连接中断");
  assert.equal(v.tone, "bad");
});

test("失败但没有 error 时退回结论，不留悬空分隔符", () => {
  const v = taskResultView(ev("unknown_type", null, { outcome: "failed" }));
  assert.equal(v.summary, "失败");
  assert.equal(v.tone, "bad");
});

// ==================== 兜底与明细 ====================

test("未知类型且无计数字段：只给结论，不编造内容", () => {
  const v = taskResultView(ev("some_future_task", {}, { label: "未来的任务" }));
  assert.equal(v.summary, "已完成");
  assert.equal(v.tone, "ok");
  assert.deepEqual(v.details, []);
});

test("未知类型但有通用计数：用成功 / 失败计数", () => {
  const v = taskResultView(ev("home_open_browsers", { total: 5, success_count: 4, failed_count: 1 }, { label: "打开 5 个窗口" }));
  assert.equal(v.summary, "已完成 · 成功 4 · 失败 1");
});

test("明细：账号类结果展开内层统计，数组字段只说条数", () => {
  const v = taskResultView(
    ev("batch_delete", { type: "batch_delete", result: { total: 2, deleted_accounts: 2, failed_list: [{ a: 1 }] } }, { label: "删除账号和窗口" }),
  );
  assert.deepEqual(v.details, [
    ["总数", "2"],
    ["已删除账号", "2"],
    ["失败列表", "1 项"],
  ]);
});

test("明细：非对象结果也给一行，不静默丢掉", () => {
  const v = taskResultView(ev("weird", "oops", { label: "怪任务" }));
  assert.deepEqual(v.details, [["结果", "\"oops\""]]);
  assert.equal(v.summary, "已完成");
});
