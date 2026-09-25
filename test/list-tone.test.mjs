/**
 * 列表状态色调（app/renderer/src/lib/list-tone.ts）
 *
 * 各列表把自己的状态映射成统一的色调：ok / warn / bad / busy / none。
 * 色调决定行首 3px 状态条与状态圆点的颜色；none 不画状态条、圆点用 idle 灰。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RAIL_CLASS,
  railClass,
  accountLoginTone,
  aiItemTone,
  totpTone,
  runOutcomeTone,
  historyItemTone,
} from "../app/renderer/src/lib/list-tone.ts";

test("railClass：每种色调对应一个行类，none 不加类", () => {
  assert.deepEqual(RAIL_CLASS, { ok: "abb-rail-ok", warn: "abb-rail-warn", bad: "abb-rail-bad", busy: "abb-rail-busy", none: "" });
  assert.equal(railClass("ok"), "abb-rail-ok");
  assert.equal(railClass("none"), "");
});

test("账号登录状态：已登录 ok / 登录中 busy / 失败 bad / 未登录与未知 none", () => {
  assert.equal(accountLoginTone("logged_in"), "ok");
  assert.equal(accountLoginTone("logging_in"), "busy");
  assert.equal(accountLoginTone("login_failed"), "bad");
  assert.equal(accountLoginTone("not_logged"), "none");
  assert.equal(accountLoginTone(null), "none");
  assert.equal(accountLoginTone("weird"), "none");
});

test("AI 任务条目：成功 ok / 失败与错误 bad / 处理中 busy / 其它（跳过等）warn / 没跑过 none", () => {
  assert.equal(aiItemTone("成功"), "ok");
  assert.equal(aiItemTone("失败"), "bad");
  assert.equal(aiItemTone("错误"), "bad");
  assert.equal(aiItemTone("处理中"), "busy");
  assert.equal(aiItemTone("跳过"), "warn");
  assert.equal(aiItemTone(undefined), "none");
  assert.equal(aiItemTone(""), "none");
});

test("导入 TOTP 匹配：可导入 ok / 已有 warn / 未匹配 none", () => {
  assert.equal(totpTone("can_import"), "ok");
  assert.equal(totpTone("has_secret"), "warn");
  assert.equal(totpTone("no_match"), "none");
});

test("任务历史：运行结果与条目状态", () => {
  assert.equal(runOutcomeTone("succeeded"), "ok");
  assert.equal(runOutcomeTone("stopped"), "warn");
  assert.equal(runOutcomeTone("failed"), "bad");
  assert.equal(runOutcomeTone(null), "none");
  assert.equal(runOutcomeTone("other"), "bad");
  assert.equal(historyItemTone("成功"), "ok");
  assert.equal(historyItemTone("失败"), "bad");
  assert.equal(historyItemTone("错误"), "bad");
  assert.equal(historyItemTone("处理中"), "busy");
  assert.equal(historyItemTone("跳过"), "none");
  assert.equal(historyItemTone(null), "none");
});
