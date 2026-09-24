/**
 * automation/batch/types.ts 单测（全离线）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addFailed,
  addSkipped,
  addSuccess,
  batchDurationSeconds,
  batchResultToDict,
  batchSuccessRate,
  createBatchResult,
  formatPercent1,
} from "../src/automation/batch/types.ts";

// ==================== BatchResult ====================

test("createBatchResult: 默认字段", () => {
  const r = createBatchResult({ total: 5 });
  assert.deepEqual(r, {
    total: 5,
    success_count: 0,
    failed_count: 0,
    skipped_count: 0,
    results: [],
    start_time: null,
    end_time: null,
  });
});

test("addSuccess / addFailed / addSkipped: 计数与结果条目形状", () => {
  const r = createBatchResult({ total: 3 });
  addSuccess(r, "a@x.com", { browser_id: "1" });
  addFailed(r, "b@x.com", "登录失败", "no_api_key");
  addSkipped(r, "c@x.com", "用户停止");

  assert.equal(r.success_count, 1);
  assert.equal(r.failed_count, 1);
  assert.equal(r.skipped_count, 1);
  assert.deepEqual(r.results[0], { email: "a@x.com", status: "success", data: { browser_id: "1" } });
  assert.deepEqual(r.results[1], {
    email: "b@x.com",
    status: "failed",
    error: "登录失败",
    error_type: "no_api_key",
  });
  assert.deepEqual(r.results[2], { email: "c@x.com", status: "skipped", reason: "用户停止" });

  // 不传 data 时补空对象；不传 errorType 时补 null
  const r2 = createBatchResult({ total: 1 });
  addSuccess(r2, "d@x.com");
  addFailed(r2, "e@x.com", "err");
  const first = r2.results[0];
  const second = r2.results[1];
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first.data, {});
  assert.equal(second.error_type, null);
});

test("batchSuccessRate: 分母是 success+failed，不含 skipped", () => {
  const r = createBatchResult({ total: 10 });
  r.success_count = 2;
  r.failed_count = 1;
  r.skipped_count = 7;
  assert.equal(batchSuccessRate(r), 2 / 3);
});

test("batchSuccessRate: 全部 skipped 时分母为 0，返回 0", () => {
  const r = createBatchResult({ total: 4 });
  r.skipped_count = 4;
  assert.equal(batchSuccessRate(r), 0);
});

test("batchDurationSeconds: 有起止时间取差值（秒），缺一个则 0", () => {
  const r = createBatchResult({ total: 1 });
  assert.equal(batchDurationSeconds(r), 0);
  r.start_time = 1_000_000;
  assert.equal(batchDurationSeconds(r), 0);
  r.end_time = 1_002_500;
  assert.equal(batchDurationSeconds(r), 2.5);
});

test("formatPercent1: 常规值与 Python f\"{x:.1%}\" 一致", () => {
  assert.equal(formatPercent1(0), "0.0%");
  assert.equal(formatPercent1(1), "100.0%");
  assert.equal(formatPercent1(0.5), "50.0%");
  assert.equal(formatPercent1(2 / 3), "66.7%");
  assert.equal(formatPercent1(1 / 3), "33.3%");
});

test("formatPercent1: .5 边界按银行家舍入（取偶），与 Python 一致", () => {
  // 0.0625 * 100 = 6.25 → 62|5 → 62 是偶数 → 6.2
  assert.equal(formatPercent1(0.0625), "6.2%");
  // 0.1875 * 100 = 18.75 → 187|5 → 187 是奇数 → 进位到 188 → 18.8
  assert.equal(formatPercent1(0.1875), "18.8%");
  // 0.3125 * 100 = 31.25 → 312|5 → 312 是偶数 → 31.2
  assert.equal(formatPercent1(0.3125), "31.2%");
});

test("batchResultToDict: 字段齐全且 success_rate 是百分比字符串", () => {
  const r = createBatchResult({ total: 3 });
  addSuccess(r, "a@x.com");
  addSuccess(r, "b@x.com");
  addFailed(r, "c@x.com", "boom");
  addSkipped(r, "d@x.com", "跳过");
  r.start_time = 0;
  r.end_time = 3000;

  const dict = batchResultToDict(r);
  assert.deepEqual(Object.keys(dict), [
    "total",
    "success_count",
    "failed_count",
    "skipped_count",
    "success_rate",
    "duration_seconds",
    "results",
  ]);
  assert.equal(dict.total, 3);
  assert.equal(dict.success_count, 2);
  assert.equal(dict.failed_count, 1);
  assert.equal(dict.skipped_count, 1);
  assert.equal(typeof dict.success_rate, "string");
  assert.equal(dict.success_rate, "66.7%");
  assert.equal(dict.duration_seconds, 3);
  const results = /** @type {unknown[]} */ (dict.results);
  assert.equal(results.length, 4);
});
