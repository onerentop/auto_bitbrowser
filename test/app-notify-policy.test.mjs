/**
 * app/main/notify-policy.ts 单测 —— 系统通知「应用在前台就不发」的判定
 *
 * 这条判定原先内联在 index.ts 的 notify handler 里，没有任何测试覆盖：
 * 写反了会表现为「该弹的时候不弹」，用户只会觉得通知坏了（真机真的踩过类似体感问题）。
 * 抽成纯函数后按四种组合钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { anyWindowFocused } from "../app/main/notify-policy.ts";

/** 假窗口：只需要 isDestroyed / isFocused */
const win = (focused, destroyed = false) => ({
  isFocused: () => focused,
  isDestroyed: () => destroyed,
});

test("没有窗口（应用已关窗）→ 不算前台，应该发系统通知", () => {
  assert.equal(anyWindowFocused([]), false);
});

test("窗口在前台 → 算前台，不发系统通知", () => {
  assert.equal(anyWindowFocused([win(true)]), true);
});

test("窗口在后台 → 不算前台，应该发系统通知", () => {
  assert.equal(anyWindowFocused([win(false)]), false);
});

test("已销毁的窗口即使 isFocused 为真也不算前台", () => {
  assert.equal(anyWindowFocused([win(true, true)]), false);
});

test("多窗口：任一在前台就算前台", () => {
  assert.equal(anyWindowFocused([win(false), win(true), win(false)]), true);
  assert.equal(anyWindowFocused([win(false), win(false, true)]), false);
});
