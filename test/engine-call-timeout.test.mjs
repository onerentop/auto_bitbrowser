/**
 * 引擎页面调用的超时封顶（真机 2026-09-26 回归）
 *
 * 真机现场：批量登录卡在 19/20，点「停止」也没反应。日志显示最后一个账号登录时
 * `initiating shutdown → CDP transport closed: socket-close code=1006`，此后三分钟零输出 ——
 * 因为 page.evaluate 这类调用在 CDP 断开后**永不 settle**，`try/catch` 也兜不住，
 * 登录流程的轮询永远等不到结果，那个账号结束不了，任务也就收不了尾
 * （停止按既有设计不打断进行中的账号，所以它只能一直等）。
 *
 * 这里用「永不完结的 promise」复现那种调用，验证封顶生效：超时后如实失败退出。
 * 封顶值经 callTimeoutOverrideMs 压到 25ms，否则每个用例要真等 15s。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { StagehandGoogleEngine } from "../src/engine/stagehand-engine.ts";

/** 模拟 CDP 断开后的调用：promise 永不 settle */
const never = () => new Promise(() => {});

function engineWithPage(page) {
  // 用例要直接替换内部私有的 sh / page（与 engine-visibility.test.mjs 同一手法）
  const engine = /** @type {any} */ (new StagehandGoogleEngine(/** @type {any} */ ({ ixClient: {} })));
  engine.sh = {};
  engine.page = page;
  engine.callTimeoutOverrideMs = 25; // 真机是 Timeouts.ENGINE_CALL（15s）
  return engine;
}

test("evaluateScript: 页面调用永不返回时超时退出并返回 null，不永久挂住", async () => {
  const engine = engineWithPage({ url: () => "", evaluate: never });
  const started = Date.now();
  assert.equal(await engine.evaluateScript("1"), null);
  assert.ok(Date.now() - started < 2000, "应当很快超时退出，而不是一直等下去");
});

test("getPageContent: evaluate 卡住且没有 content 回退时返回空串，不挂住", async () => {
  const engine = engineWithPage({ url: () => "", evaluate: never });
  const started = Date.now();
  assert.equal(await engine.getPageContent(), "");
  assert.ok(Date.now() - started < 2000);
});

test("getPageHtml: evaluate 卡住时返回空串，不挂住", async () => {
  const engine = engineWithPage({ url: () => "", evaluate: never });
  assert.equal(await engine.getPageHtml(), "");
});

test("clickByText: 页面调用卡住时返回 null，不挂住", async () => {
  const engine = engineWithPage({ url: () => "", evaluate: never });
  assert.equal(await engine.clickByText("下一步"), null);
});

test("navigate: goto 永不返回时超时失败，而不是永久等待", async () => {
  const engine = engineWithPage({ url: () => "about:blank", goto: never });
  const r = await engine.navigate("https://example.com");
  assert.equal(r.success, false);
  assert.match(String(r.error), /超时/);
});

test("正常返回的页面调用不受封顶影响", async () => {
  const engine = engineWithPage({
    url: () => "about:blank",
    evaluate: async (script) => `ok:${script}`,
  });
  assert.equal(await engine.evaluateScript("1+1"), "ok:1+1");
});
