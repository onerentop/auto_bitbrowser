/**
 * StagehandGoogleEngine.isVisible 复核逻辑
 *
 * 真机回归发现：Google 密码页里有一个放在 display:none 容器中的 0×0 #captchaimg，
 * Stagehand 的 isVisible 判为可见，导致密码页被误判为人机验证。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { StagehandGoogleEngine, renderedCheckScript } from "../src/engine/stagehand-engine.ts";

/** 用假 page 构造一个已「连接」的引擎（私有字段只是 TS 层面的限制） */
function engineWith({ stagehandVisible, rendered, evaluateThrows = false }) {
  const evaluated = [];
  const page = {
    url: () => "https://accounts.google.com/v3/signin/challenge/pwd",
    locator: () => ({
      fill: async () => {},
      type: async () => {},
      first() {
        return this;
      },
      isVisible: async () => stagehandVisible,
    }),
    evaluate: async (script) => {
      evaluated.push(script);
      if (evaluateThrows) throw new Error("boom");
      return rendered;
    },
  };
  const engine = /** @type {any} */ (new StagehandGoogleEngine(/** @type {any} */ ({ ixClient: {} }))); // 用例要直接替换内部私有的 sh / page
  engine.sh = {};
  engine.page = page;
  return { engine, evaluated };
}

test("isVisible: Stagehand 判可见但页面复核为不可见（隐藏祖先 / 0×0）→ false", async () => {
  const { engine } = engineWith({ stagehandVisible: true, rendered: false });
  assert.equal(await engine.isVisible("#captchaimg"), false);
});

test("isVisible: Stagehand 判可见且页面复核可见 → true", async () => {
  const { engine } = engineWith({ stagehandVisible: true, rendered: true });
  assert.equal(await engine.isVisible('input[name="Passwd"]'), true);
});

test("isVisible: 主文档查不到（shadow DOM）时沿用 Stagehand 结论", async () => {
  const { engine } = engineWith({ stagehandVisible: true, rendered: null });
  assert.equal(await engine.isVisible("#x"), true);
});

test("isVisible: 页面复核抛错时沿用 Stagehand 结论", async () => {
  const { engine } = engineWith({ stagehandVisible: true, rendered: false, evaluateThrows: true });
  assert.equal(await engine.isVisible("#x"), true);
});

test("isVisible: Stagehand 判不可见时不再复核", async () => {
  const { engine, evaluated } = engineWith({ stagehandVisible: false, rendered: true });
  assert.equal(await engine.isVisible("#captchaimg"), false);
  assert.equal(evaluated.length, 0);
});

test("renderedCheckScript: 选择器经 JSON 转义嵌入", () => {
  const script = renderedCheckScript('#password input[type="password"]');
  assert.ok(script.includes(JSON.stringify('#password input[type="password"]')));
  assert.ok(script.includes("getBoundingClientRect"));
  assert.ok(script.includes("checkVisibility"));
});
