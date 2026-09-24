/** Playwright 兼容层单测 —— 重点覆盖 waitForSelector 的轮询与超时语义 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCompatPage } from "../src/engine/playwright-compat.ts";

/** 造一个假的 V3 Page，用脚本控制 locator 的行为 */
function fakeV3Page(script = {}) {
  const state = {
    goto: [],
    pressed: [],
    fillCalls: [],
    clickCalls: [],
  };
  // script.visible: 每次调用 count/isVisible 时返回什么（按调用序号）
  const countSeq = script.countSeq ? [...script.countSeq] : null;
  const visibleSeq = script.visibleSeq ? [...script.visibleSeq] : null;
  let nth = 0;

  const page = {
    async goto(url, opts) {
      state.goto.push({ url, opts });
    },
    url: () => script.url ?? "https://example.com",
    async evaluate() {
      return script.text ?? "";
    },
    locator(selector) {
      const idx = nth;
      nth += 1;
      const count = countSeq ? (countSeq[Math.min(idx, countSeq.length - 1)] ?? 0) : (script.count ?? 1);
      const visible = visibleSeq
        ? (visibleSeq[Math.min(idx, visibleSeq.length - 1)] ?? false)
        : (script.visible ?? true);
      return {
        count: async () => count,
        isVisible: async () => visible,
        click: async () => {
          state.clickCalls.push(selector);
        },
        fill: async (v) => {
          state.fillCalls.push({ selector, value: v });
        },
        first() {
          return this;
        },
      };
    },
    async keyPress(key) {
      state.pressed.push(key);
    },
  };
  return { page, state };
}

const noSleep = async () => {};

test("goto 默认 waitUntil=domcontentloaded", async () => {
  const { page, state } = fakeV3Page();
  const p = createCompatPage(page, { sleepImpl: noSleep });
  await p.goto("https://x.io");
  assert.equal(state.goto[0].opts.waitUntil, "domcontentloaded");
});

test("fill 对首个匹配元素填充", async () => {
  const { page, state } = fakeV3Page();
  const p = createCompatPage(page, { sleepImpl: noSleep });
  await p.fill('input[type="password"]', "secret");
  assert.deepEqual(state.fillCalls[0], { selector: 'input[type="password"]', value: "secret" });
});

test("locator.first() 是方法（抹平与 Playwright 的属性差异）", () => {
  const { page } = fakeV3Page();
  const p = createCompatPage(page, { sleepImpl: noSleep });
  assert.equal(typeof p.locator("div").first, "function");
});

test("waitForSelector: 元素已可见时立即返回", async () => {
  const { page } = fakeV3Page({ count: 1, visible: true });
  const p = createCompatPage(page, { sleepImpl: noSleep });
  const loc = await p.waitForSelector("#a", { timeout: 1000 });
  assert.equal(await loc.isVisible(), true);
});

test("waitForSelector: 先不存在后出现（轮询生效）", async () => {
  // 调用序号 0,1 返回 count=0，第 2 次起返回 1
  const { page } = fakeV3Page({ countSeq: [0, 0, 1], visible: true });
  const p = createCompatPage(page, { sleepImpl: noSleep });
  const loc = await p.waitForSelector("#b", { timeout: 5000 });
  assert.ok(loc, "应轮询到元素出现");
});

test("waitForSelector: state=attached 不要求可见", async () => {
  const { page } = fakeV3Page({ count: 1, visible: false });
  const p = createCompatPage(page, { sleepImpl: noSleep });
  const loc = await p.waitForSelector("#c", { state: "attached", timeout: 1000 });
  assert.ok(loc, "attached 只要求存在");
});

test("waitForSelector: state=visible 且元素不可见时超时抛错", async () => {
  const { page } = fakeV3Page({ count: 1, visible: false });
  const p = createCompatPage(page, { sleepImpl: noSleep });
  await assert.rejects(
    () => p.waitForSelector("#d", { timeout: 1 }),
    /超时/,
    "应抛超时错误，与 Playwright 一致",
  );
});

test("waitForSelector: 元素始终不存在时超时抛错", async () => {
  const { page } = fakeV3Page({ count: 0 });
  const p = createCompatPage(page, { sleepImpl: noSleep });
  await assert.rejects(() => p.waitForSelector("#e", { timeout: 1 }), /超时/);
});

test("waitForSelector: 探测过程抛错不终止等待", async () => {
  let calls = 0;
  const page = {
    async goto() {},
    url: () => "",
    evaluate: async () => "",
    locator() {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return {
        count: async () => 1,
        isVisible: async () => true,
        click: async () => {},
        fill: async () => {},
        first() {
          return this;
        },
      };
    },
    async keyPress() {},
  };
  const p = createCompatPage(page, { sleepImpl: noSleep });
  const loc = await p.waitForSelector("#f", { timeout: 3000 });
  assert.ok(loc, "瞬态错误后应重试成功");
});

test("keyboard.press 走 V3 keyPress（支持 Enter 等命名键）", async () => {
  const { page, state } = fakeV3Page();
  const p = createCompatPage(page, { sleepImpl: noSleep });
  await p.keyboard.press("Enter");
  assert.deepEqual(state.pressed, ["Enter"]);
});

test("keyboard.press: 无 keyPress 能力且要按 Enter 时明确报错", async () => {
  const page = {
    async goto() {},
    url: () => "",
    evaluate: async () => "",
    locator: () => ({
      count: async () => 0,
      isVisible: async () => false,
      first() {
        return this;
      },
    }),
    keyboard: { type: async () => {} },
  };
  const p = createCompatPage(page, { sleepImpl: noSleep });
  await assert.rejects(() => p.keyboard.press("Enter"), /不支持 Enter/);
});

test("content 返回页面可见文本", async () => {
  const { page } = fakeV3Page({ text: "Verify it's you" });
  const p = createCompatPage(page, { sleepImpl: noSleep });
  assert.equal(await p.content(), "Verify it's you");
});

test("content 在 evaluate 不可用时返回空串而非抛错", async () => {
  const page = { async goto() {}, url: () => "", locator: () => ({ first() { return this; } }) };
  const p = createCompatPage(page, { sleepImpl: noSleep });
  assert.equal(await p.content(), "");
});

test("locator 能力缺失时明确报错（而非静默返回空）", () => {
  const page = { async goto() {}, url: () => "" };
  const p = createCompatPage(page, { sleepImpl: noSleep });
  assert.throws(() => p.locator("div"), /不支持 locator/);
});